/**
 * KeepaliveEngine — 7-layer cache-keepalive defense stack.
 *
 * Extracted from sdk.ts (previously 2342-line monocode) to make the KA
 * mechanism reusable across:
 *   - ClaudeCodeSDK (internal SDK consumer, via delegation)
 *   - claude-max-proxy (Anthropic-native passthrough proxy for Claude Code CLI)
 *   - Any future consumer needing warm-cache keepalive with the same guarantees
 *
 * ## Dependencies are injected (zero coupling to SDK internals):
 *   - getToken:          returns a fresh access_token (handles refresh)
 *   - doFetch:           performs the actual HTTPS request, yields SSE events
 *   - getRateLimitInfo:  returns current rate limit snapshot (from last response)
 *
 * ## Usage contract:
 *   1. Call `notifyRealRequestStart()` at the top of every real request —
 *      aborts any in-flight KA, primes pending snapshot slot.
 *   2. After a real request succeeds, call `notifyRealRequestComplete(usage, model, body, headers)`
 *      — registers snapshot (heaviest-wins), starts KA timer.
 *   3. Call `checkRewriteGuard(model)` BEFORE real requests — throws
 *      CacheRewriteBlockedError if guard enabled and cache presumed dead.
 *   4. Call `stop()` on shutdown.
 *
 * ## Invariants (pinned by test/keepalive-regression.test.ts):
 *   - KA fire NEVER writes cache (max_tokens=1, replay identical prefix)
 *   - Heaviest snapshot wins (subagent calls cannot steal main chat's slot)
 *   - Disarm does not kill timer — auto-resumes on next real request
 *   - Retry chain tracks exact TTL from cacheWrittenAt — never overshoots
 *   - intervalMs clamped to [intervalClampMin, intervalClampMax] derived from
 *     current cacheTtlMs at construction (legacy: [60s, 240s] for 5m TTL)
 */

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type {
  KeepaliveConfig,
  KeepaliveStats,
  KeepaliveTick,
  RateLimitInfo,
  StreamEvent,
  TokenUsage,
} from './types.js'

// ============================================================
// DI contract
// ============================================================

export interface KeepaliveEngineOptions {
  /** Keepalive config (see KeepaliveConfig for all options). Defaults applied internally. */
  config?: KeepaliveConfig

  /** Returns a fresh access_token. Implementation handles refresh/triple-check/etc. */
  getToken: () => Promise<string>

  /**
   * Performs the actual Anthropic API request and yields SSE events.
   * Engine uses this for KA fires; consumer uses whatever transport it wants.
   * Must throw APIError/RateLimitError with .status for error classification.
   */
  doFetch: (
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ) => AsyncGenerator<StreamEvent>

  /** Returns current rate limit snapshot (used by onHeartbeat callback). */
  getRateLimitInfo: () => RateLimitInfo

  /**
   * Optional just-in-time liveness check. Called BEFORE every KA fire.
   * If returns false → engine stops (registry cleared, timer dead).
   * Use case: proxy-side PID-of-owner check — don't burn quota firing
   * KA into a cache whose consumer process already exited.
   *
   * If omitted → engine assumes owner is always alive (current behavior).
   */
  isOwnerAlive?: () => boolean
}

// Live-reload config is now centralized in src/keepalive-config.ts (SSOT).
// We call loadKeepaliveConfig() inside tick() — it returns the cached
// resolved config (cheap mtime check) and we apply changes to this.config.

// ============================================================
// Errors
// ============================================================

// Re-exported from types.ts — engine throws this on guard block
import { CacheRewriteBlockedError } from './types.js'
import { loadKeepaliveConfig } from './keepalive-config.js'

/**
 * Classify an error thrown during doFetch into actionable categories.
 *
 *   'network' — transport-level failure (can't reach api.anthropic.com).
 *               Caused by: offline, DNS fail, TCP refused/reset, TLS handshake fail.
 *               Action: TCP probe + retry when network returns.
 *
 *   'server_transient' — Anthropic returned 5xx/429/529/503. Server is up
 *               but overloaded. Action: retryChain with backoff.
 *
 *   'auth' — 401/403. Token expired or revoked.
 *               Action: refresh token, retry once.
 *
 *   'permanent' — 400, other 4xx. Something wrong with the request itself.
 *               Action: disarm, surface to user.
 */
type ErrorCategory = 'network' | 'server_transient' | 'auth' | 'permanent'

function classifyError(err: unknown): ErrorCategory {
  const e = err as {
    status?: number
    code?: string
    name?: string
    cause?: { code?: string; name?: string; message?: string }
    message?: string
  } | undefined
  if (!e) return 'permanent'

  // HTTP status always wins if present (we saw a real response)
  const status = e.status
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status === 503 || status === 529 || (status && status >= 500)) return 'server_transient'
  if (status && status >= 400 && status < 500) return 'permanent'

  // No status → transport-level. Walk the full error chain (the SDK wraps
  // fetch errors in `ClaudeCodeSDKError('Network error', err)`, so the real
  // info lives in .cause). Aggregate every observable field.
  const code = e.code ?? e.cause?.code ?? ''
  const name = e.name ?? e.cause?.name ?? ''
  const msg = (e.message ?? '').toLowerCase()
  const causeMsg = (e.cause?.message ?? '').toLowerCase()
  const allMsg = `${msg} ${causeMsg}`.trim()

  // Aborts due to our own timeoutId firing show up as DOMException AbortError.
  // This is the dominant real-world failure mode — request_timeout (default
  // 10 min in sdk.ts:234) → controller.abort() → fetch rejects with AbortError.
  // Without this branch, classify falls through to 'server_transient' →
  // retryChain → cache_ttl_exhausted (the lying reason that misled diagnosis
  // in the 18:44Z incident).
  if (name === 'AbortError' || name === 'TimeoutError') return 'network'
  if (allMsg.includes('aborted') || allMsg.includes('the operation timed out') ||
      allMsg.includes('request timed out')) return 'network'

  const networkCodes = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH',
    'ENETDOWN', 'EHOSTUNREACH', 'EHOSTDOWN', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'ERR_SOCKET_CONNECTION_TIMEOUT',
    'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_ABORTED',
    'ABORT_ERR', 'ERR_NETWORK',
    'ConnectionRefused', 'FailedToOpenSocket', // Bun-style
  ])
  if (code && networkCodes.has(code)) return 'network'
  // Heuristic on message for Bun/Undici variants. Includes 'network error'
  // because that's exactly what the SDK wraps any fetch failure as.
  if (allMsg.includes('unable to connect') || allMsg.includes('failed to open socket') ||
      allMsg.includes('connection refused') || allMsg.includes('network is unreachable') ||
      allMsg.includes('network error') || allMsg.includes('fetch failed') ||
      allMsg.includes('timeout') || allMsg.includes('dns') ||
      allMsg.includes('socket hang up') || allMsg.includes('terminated')) return 'network'

  // Unknown → treat as transient (safer than permanent — we'd prefer to
  // attempt recovery than disarm on an unrecognized error).
  return 'server_transient'
}

// ============================================================
// KeepaliveEngine
// ============================================================

export class KeepaliveEngine {
  // ── Cache + KA parameters — read from SSOT (~/.claude/keepalive.json) ──
  //
  // Defaults to legacy 5m TTL for backward compatibility. To enable 1h cache,
  // write { "cacheTtlSec": 3600, "intervalSec": 1800, ... } to keepalive.json.
  // See: src/keepalive-config.ts for full schema and recommended values.
  //
  // Resolved values are cached per-instance at construction time. Hot-reload of
  // keepalive.json: callers can construct a new engine, or rely on per-tick
  // re-resolution (TODO: future enhancement). For now, restart of the consumer
  // process picks up new config.
  private readonly cacheTtlMs: number
  private readonly safetyMarginMs: number
  private readonly retryDelaysMs: readonly number[]
  private readonly healthProbeIntervalsMs: readonly number[]
  private readonly healthProbeTimeoutMs: number

  // Snapshot TTL — set via CLAUDE_SDK_SNAPSHOT_TTL_MIN env var. Default: 1440 (24h).
  private static readonly SNAPSHOT_TTL_MS = (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? '1440', 10) || 1440) * 60 * 1000

  // Full body dump for debugging. Set CLAUDE_SDK_DUMP_BODY=1 to enable.
  private static readonly DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === '1'

  // ── Config ──────────────────────────────────────────────────
  private config: Required<Pick<KeepaliveConfig, 'enabled' | 'intervalMs' | 'idleTimeoutMs' | 'minTokens' | 'rewriteWarnIdleMs' | 'rewriteWarnTokens' | 'rewriteBlockIdleMs' | 'rewriteBlockEnabled'>> & {
    onHeartbeat?: (stats: KeepaliveStats) => void
    onTick?: (tick: KeepaliveTick) => void
    onDisarmed?: (info: { reason: string; at: number }) => void
    onRewriteWarning?: (info: { idleMs: number; estimatedTokens: number; blocked: boolean; model: string }) => void
    onNetworkStateChange?: (info: { from: string; to: string; at: number }) => void
  }

  // ── Injected deps ──────────────────────────────────────────
  private readonly getToken: () => Promise<string>
  private readonly doFetch: KeepaliveEngineOptions['doFetch']
  private readonly getRateLimitInfo: () => RateLimitInfo
  private readonly isOwnerAlive: () => boolean

  // ── State ──────────────────────────────────────────────────
  // Largest observed cache size per model (used for rewrite cost estimation)
  private lastKnownCacheTokensByModel = new Map<string, number>()

  // Layer 2: network health probe state
  private networkState: 'healthy' | 'degraded' = 'healthy'
  private healthProbeTimer: ReturnType<typeof setTimeout> | null = null
  private healthProbeAttempt = 0

  // KA registry — one entry per model, heaviest-wins
  private registry = new Map<string, { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number }>()

  // Pending snapshot slot — primed by notifyRealRequestStart, committed by notifyRealRequestComplete
  private _pendingSnapshotModel = ''
  private _pendingSnapshotBody: Record<string, unknown> | null = null
  private _pendingSnapshotHeaders: Record<string, string> | null = null

  // Timestamps
  private lastActivityAt = 0
  private lastRealActivityAt = 0
  private cacheWrittenAt = 0

  // Timers & abort
  private timer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private inFlight = false
  private jitterMs = 0

  // Debug counter
  private snapshotCallCount = 0

  constructor(opts: KeepaliveEngineOptions) {
    this.getToken = opts.getToken
    this.doFetch = opts.doFetch
    this.getRateLimitInfo = opts.getRateLimitInfo
    // Default: always-alive (preserve existing behavior when caller omits).
    this.isOwnerAlive = opts.isOwnerAlive ?? (() => true)

    const ka = opts.config ?? {}

    // SSOT: read cache+KA parameters from ~/.claude/keepalive.json (with safe defaults).
    const ssot = loadKeepaliveConfig()
    this.cacheTtlMs = ssot.cacheTtlMs
    this.safetyMarginMs = ssot.safetyMarginMs
    this.retryDelaysMs = ssot.retryDelaysMs
    this.healthProbeIntervalsMs = ssot.healthProbeIntervalsMs
    this.healthProbeTimeoutMs = ssot.healthProbeTimeoutMs

    // Layer 4: Clamp interval to safe bounds derived from current cache TTL.
    // Caller-provided ka.intervalMs takes priority over SSOT default.
    let intervalMs = ka.intervalMs ?? ssot.intervalMs
    if (intervalMs < ssot.intervalClampMin) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} below safe min (${ssot.intervalClampMin}); clamped`)
      intervalMs = ssot.intervalClampMin
    }
    if (intervalMs > ssot.intervalClampMax) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} above safe max (${ssot.intervalClampMax}, cacheTTL ${this.cacheTtlMs}ms - margin ${this.safetyMarginMs}ms - 60s); clamped`)
      intervalMs = ssot.intervalClampMax
    }

    this.config = {
      enabled: ka.enabled ?? ssot.enabled,
      intervalMs,
      idleTimeoutMs: ka.idleTimeoutMs ?? ssot.idleTimeoutMs,
      minTokens: ka.minTokens ?? ssot.minTokens,
      rewriteWarnIdleMs: ka.rewriteWarnIdleMs ?? ssot.rewriteWarnIdleMs,
      rewriteWarnTokens: ka.rewriteWarnTokens ?? ssot.rewriteWarnTokens,
      rewriteBlockIdleMs: ka.rewriteBlockIdleMs ?? Infinity,
      rewriteBlockEnabled: ka.rewriteBlockEnabled ?? ssot.rewriteBlockEnabled,
      onHeartbeat: ka.onHeartbeat,
      onTick: ka.onTick,
      onDisarmed: ka.onDisarmed,
      onRewriteWarning: ka.onRewriteWarning,
      onNetworkStateChange: ka.onNetworkStateChange,
    }
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Call at the top of every real request. Primes the pending snapshot slot
   * with the body/headers about to be sent, and aborts any in-flight KA.
   */
  notifyRealRequestStart(model: string, body: Record<string, unknown>, headers: Record<string, string>): void {
    // Snapshot for keepalive registry (deep clone to avoid mutation)
    this._pendingSnapshotModel = model
    this._pendingSnapshotBody = JSON.parse(JSON.stringify(body))
    this._pendingSnapshotHeaders = { ...headers }
    // Abort any in-flight keepalive before real request
    this.abortController?.abort()
    this.inFlight = false
  }

  /**
   * Call after a real request completes successfully. Registers the pending
   * snapshot (heaviest-wins), updates activity timestamps, starts KA timer.
   */
  notifyRealRequestComplete(usage: TokenUsage): void {
    const now = Date.now()
    this.lastActivityAt = now
    this.lastRealActivityAt = now  // only REAL requests set this
    this.cacheWrittenAt = now      // cache is fresh right now

    // Layer 2: real stream succeeded → network is definitively healthy.
    if (this.healthProbeTimer || this.networkState !== 'healthy') {
      this.stopHealthProbe()
      if (this.networkState !== 'healthy') {
        const prev = this.networkState
        this.networkState = 'healthy'
        try { this.config.onNetworkStateChange?.({ from: prev, to: 'healthy', at: now }) } catch {}
      }
    }

    if (!this.config.enabled) return

    // Register snapshot for this model — ONLY if it's the heaviest context seen.
    const model = this._pendingSnapshotModel
    const body = this._pendingSnapshotBody
    const headers = this._pendingSnapshotHeaders
    if (model && body && headers) {
      const totalTokens = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
      const existing = this.registry.get(model)
      if (totalTokens >= this.config.minTokens && (!existing || totalTokens >= existing.inputTokens)) {
        this.registry.set(model, { body, headers, model, inputTokens: totalTokens })
      }
      // Track largest observed cache size per model for rewrite cost estimation.
      const prevMax = this.lastKnownCacheTokensByModel.get(model) ?? 0
      if (totalTokens > prevMax) {
        this.lastKnownCacheTokensByModel.set(model, totalTokens)
      }

      // Write snapshot metadata for debugging (rotate: keep last 24h)
      this.writeSnapshotDebug(model, body, usage)

      this._pendingSnapshotBody = null
      this._pendingSnapshotHeaders = null
    }

    if (this.registry.size > 0) this.startTimer()
  }

  /**
   * Layer 3 — Cache rewrite burst protection.
   * Call at the top of every real request BEFORE sending.
   *
   * Measures idle time against `cacheWrittenAt` — the timestamp of the last
   * cache-touching event (real request OR successful KA fire). This correctly
   * accounts for KA keeping the prompt cache warm: even if the user has been
   * idle for hours, KA fires every ~2min refresh the cache (cache_read_input_tokens
   * keeps growing in RAW_USAGE), so cacheWrittenAt stays recent.
   *
   * Previous version compared against `lastRealActivityAt` (only updated by real
   * user requests) — this fired false warnings every 5min of user idleness even
   * when KA was healthily firing. Symptom: TUI banner "Cache likely dead — idle=350s,
   * next request will cost ~150k cache_write tokens" while RAW_USAGE simultaneously
   * showed cache_creation_input_tokens < 2k (cache was actually warm).
   *
   *   - If gap since cacheWrittenAt > warnIdleMs AND cache size > warnTokens → warning
   *   - If gap > blockIdleMs AND blockEnabled → throws CacheRewriteBlockedError
   */
  checkRewriteGuard(model: string): void {
    const lastCacheTouch = this.cacheWrittenAt
    if (lastCacheTouch === 0) return  // First-ever request; no baseline yet.
    const idleMs = Date.now() - lastCacheTouch
    const warnIdle = this.config.rewriteWarnIdleMs
    const blockIdle = this.config.rewriteBlockIdleMs
    if (idleMs < warnIdle) return  // Normal working cadence.

    const estimatedTokens = this.lastKnownCacheTokensByModel.get(model) ?? 0
    const blocked = this.config.rewriteBlockEnabled && idleMs >= blockIdle

    if (estimatedTokens >= this.config.rewriteWarnTokens || blocked) {
      try { this.config.onRewriteWarning?.({ idleMs, estimatedTokens, blocked, model }) } catch {}
    }

    if (blocked) {
      throw new CacheRewriteBlockedError(idleMs, estimatedTokens, model)
    }
  }

  /** Full shutdown — clears all timers, aborts in-flight. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.abortController?.abort()
    this.registry.clear()
    this.inFlight = false
    this.stopHealthProbe()
  }

  // ────────────────────────────────────────────────────────────
  // Internal: timer & tick
  // ────────────────────────────────────────────────────────────

  private startTimer(): void {
    if (this.timer) return
    const TICK_MS = Math.min(30_000, Math.max(5_000, Math.floor(this.config.intervalMs / 6)))
    this.timer = setInterval(() => this.tick(), TICK_MS)
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as any).unref()
    }
  }

  private async tick(): Promise<void> {
    if (this.registry.size === 0 || this.inFlight) return

    // ── Layer 0a: owner-alive check (JIT PID-death gate) ───────────
    // Call BEFORE anything else — if consumer process is gone, instantly
    // disarm. Saves wasted KA fires into a dead owner's cache.
    try {
      if (!this.isOwnerAlive()) {
        this.registry.clear()
        this.stop()
        this.onDisarmed('owner_dead')
        return
      }
    } catch {
      // isOwnerAlive callback errored — assume alive, do not stop.
    }

    // ── Layer 0b: wake-from-sleep detection ────────────────────────
    // On laptop wake: if cacheWrittenAt + CACHE_TTL < now, the cache we
    // were protecting is 100% dead at Anthropic (TTL expired during sleep).
    // Firing a KA would cache_create a NEW cache the user didn't ask for,
    // wasting large prompt-cache-write tokens. Disarm and wait for a real
    // user request to prime a fresh snapshot.
    if (this.cacheWrittenAt > 0) {
      const cacheAge = Date.now() - this.cacheWrittenAt
      if (cacheAge > this.cacheTtlMs) {
        this.registry.clear()
        this.onDisarmed('cache_expired_during_sleep')
        return
      }
    }

    // Live-reload config from SSOT (~/.claude/keepalive.json via keepalive-config.ts).
    // Cheap: mtime cache inside loadKeepaliveConfig(). Reflects intervalSec /
    // idleTimeoutSec changes without restart.
    const liveConfig = loadKeepaliveConfig()
    if (!liveConfig.enabled) {
      this.registry.clear()
      this.stop()
      return
    }
    // Only apply if values actually differ — keeps behavior identical when
    // file unchanged. Clamp to current intervalClamp range.
    const newInterval = Math.max(liveConfig.intervalClampMin,
      Math.min(liveConfig.intervalMs, liveConfig.intervalClampMax))
    if (newInterval !== this.config.intervalMs) {
      this.config.intervalMs = newInterval
    }
    if (liveConfig.idleTimeoutMs !== this.config.idleTimeoutMs) {
      this.config.idleTimeoutMs = liveConfig.idleTimeoutMs
    }
    if (liveConfig.minTokens !== this.config.minTokens) {
      this.config.minTokens = liveConfig.minTokens
    }

    // Idle timeout
    const realIdle = Date.now() - this.lastRealActivityAt
    if (this.config.idleTimeoutMs !== Infinity && realIdle > this.config.idleTimeoutMs) {
      this.registry.clear()
      this.stop()
      return
    }

    // Pick heaviest model from registry
    let best: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number } | null = null
    for (const entry of this.registry.values()) {
      if (!best || entry.inputTokens > best.inputTokens) best = entry
    }
    if (!best) return

    const idle = Date.now() - this.lastActivityAt

    // Jitter: prevents multi-session burst
    if (!this.jitterMs) {
      this.jitterMs = Math.floor(Math.random() * 30_000)
    }
    if (idle < this.config.intervalMs * 0.9 + this.jitterMs) {
      this.config.onTick?.({
        idleMs: idle,
        nextFireMs: Math.max(0, this.config.intervalMs - idle),
        model: best.model,
        tokens: best.inputTokens,
      })
      return
    }

    // Fire keepalive for heaviest model
    this.inFlight = true

    try {
      const token = await this.getToken()

      const body = JSON.parse(JSON.stringify(best.body))
      const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
      body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1

      const headers = { ...best.headers, Authorization: `Bearer ${token}` }

      const controller = new AbortController()
      this.abortController = controller

      const t0 = Date.now()
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

      for await (const event of this.doFetch(body, headers, controller.signal)) {
        if (event.type === 'message_stop') usage = event.usage
      }

      const durationMs = Date.now() - t0
      // Update fire timer (for spacing keepalives) but NOT realActivityAt
      this.lastActivityAt = Date.now()
      this.cacheWrittenAt = Date.now()

      const rl = this.getRateLimitInfo()
      this.config.onHeartbeat?.({
        usage,
        durationMs,
        idleMs: idle,
        model: best.model,
        rateLimit: {
          status: rl.status,
          claim: rl.claim,
          resetAt: rl.resetAt,
        },
      })
    } catch (err: unknown) {
      const category = classifyError(err)

      if (category === 'network') {
        // Network fault: don't bang HTTPS against a dead link — wastes time
        // and doesn't help. Jump straight to aggressive TCP probe (cheap).
        // Probe will auto-fire KA once network returns and cache is still alive.
        const cacheAge = Date.now() - this.cacheWrittenAt
        const ttlRemaining = this.cacheTtlMs - cacheAge
        // If cache effectively dead (< safety margin), go to revive-mode
        // so we know when net is back without attempting KA on dead cache.
        const reviveMode = ttlRemaining <= this.safetyMarginMs
        this.onDisarmed('network_error')
        this.startHealthProbe({ reviveMode })
      } else if (category === 'server_transient') {
        // Anthropic is up but struggling. Classic HTTP-level retry with
        // backoff — kept identical to previous behavior.
        this.retryChain(best)
      } else if (category === 'auth') {
        // Token issue — disarm, token refresh is the consumer's responsibility
        // (they should refresh via credentialStore on 401). Engine will resume
        // on next real request with fresh creds.
        this.registry.clear()
        this.onDisarmed('auth_error')
      } else {
        // Permanent (400, malformed request, etc). Don't retry.
        this.registry.clear()
        this.onDisarmed('permanent_error')
      }
    } finally {
      this.inFlight = false
      this.abortController = null
    }
  }

  /**
   * Dedicated retry chain for transient keepalive failures.
   * Uses setTimeout with exact delays from cacheWrittenAt — no drift.
   */
  private retryChain(
    entry: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number },
    attemptIndex = 0,
  ): void {
    if (attemptIndex >= this.retryDelaysMs.length) {
      this.registry.clear()
      this.onDisarmed('retry_exhausted')
      return
    }

    const cacheAge = Date.now() - this.cacheWrittenAt
    const ttlRemaining = this.cacheTtlMs - cacheAge
    const nextDelay = this.retryDelaysMs[attemptIndex]! * 1000

    // CACHE SAFETY MARGIN: increased from 5s → 15s (2025-04).
    // Rationale: network latency on KA request can add 1-10s unpredictably.
    // If we fire at TTL-5s and network hiccups by 6s, we'd land AFTER TTL
    // expiry → Anthropic would treat our request as cache-miss and create
    // a fresh one (~70k tokens cache_write = wasted quota).
    // 15s margin gives headroom for slow networks + DNS lookup + handshake.
    if (ttlRemaining < nextDelay + this.safetyMarginMs) {
      // CRITICAL INVARIANT: KA must NEVER cache_write.
      //
      // The reason here is honest *only* when cache truly aged out via TTL.
      // For the common case where retry was scheduled because of a transient
      // server failure (5xx/AbortError fall-through) and we already burned
      // most of the TTL waiting for retries, emit a more accurate reason so
      // diagnosis isn't misled into thinking the cache silently expired.
      //
      // Heuristic: if cacheAge > TTL/2 the user-visible behaviour is the
      // same (KA stops), but the *cause* is the retry budget colliding with
      // the natural TTL boundary, not idle expiry. We tag it distinctly.
      this.registry.clear()
      const reason = cacheAge < this.cacheTtlMs / 2
        ? 'retry_budget_exceeds_ttl'  // server failures consumed too much of the window
        : 'cache_ttl_exhausted'        // genuine TTL boundary hit
      this.onDisarmed(reason)
      return
    }

    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null

      // JIT owner-alive check before retry — consumer PID may have died
      // between scheduled retry and fire time.
      try {
        if (!this.isOwnerAlive()) {
          this.registry.clear()
          this.stop()
          this.onDisarmed('owner_dead')
          return
        }
      } catch {}

      // Re-check: if a real request happened since we started retrying, stop.
      if (this.lastRealActivityAt > this.cacheWrittenAt) {
        return
      }

      const ageNow = Date.now() - this.cacheWrittenAt
      if (ageNow > this.cacheTtlMs - this.safetyMarginMs) {
        this.registry.clear()
        this.onDisarmed('cache_ttl_expired_mid_retry')
        return
      }

      this.inFlight = true
      try {
        const token = await this.getToken()
        const body = JSON.parse(JSON.stringify(entry.body))
        const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
        body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1
        const headers = { ...entry.headers, Authorization: `Bearer ${token}` }

        const controller = new AbortController()
        this.abortController = controller

        for await (const event of this.doFetch(body, headers, controller.signal)) {
          void event  // drain
        }

        this.lastActivityAt = Date.now()
        this.cacheWrittenAt = Date.now()
      } catch (err: unknown) {
        const category = classifyError(err)

        if (category === 'network') {
          // Same logic as tick(): network-level error in retry → go straight
          // to TCP probe, don't waste more HTTPS attempts on a dead link.
          this.inFlight = false
          this.abortController = null
          const ttlRemaining = this.cacheTtlMs - (Date.now() - this.cacheWrittenAt)
          const reviveMode = ttlRemaining <= this.safetyMarginMs
          this.onDisarmed('network_error_mid_retry')
          this.startHealthProbe({ reviveMode })
          return
        }

        if (category === 'server_transient') {
          this.inFlight = false
          this.abortController = null
          this.retryChain(entry, attemptIndex + 1)
          return
        } else {
          this.registry.clear()
          this.onDisarmed('permanent_error_mid_retry')
        }
      } finally {
        this.inFlight = false
        this.abortController = null
      }
    }, nextDelay)
  }

  /**
   * Called when KA fire logic decides to "disarm" (stop firing) without
   * killing the interval timer. Timer remains cheap+unref'd, becomes no-op
   * with empty registry, and auto-resumes on next real request.
   */
  private onDisarmed(reason: string): void {
    this.abortController?.abort()
    this.abortController = null
    this.inFlight = false
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    // NOTE: intentionally NOT calling clearInterval(timer).
    try { this.config.onDisarmed?.({ reason, at: Date.now() }) } catch {}

    // Layer 2: start network health probe on any network-related disarm.
    // Escalating intervals [5s, 5s, 10s, 10s, 20s, ...] — fast reaction if
    // network blip is short enough to save the cache; slower as TTL depletes.
    //
    // Two modes:
    //   a) cache-alive (ttlRemaining > safety margin): probe to save cache —
    //      on TCP success fire KA immediately.
    //   b) revive-mode (cache dead but fault is network): probe to detect
    //      when network returns. No KA fire on success (cache is dead) —
    //      engine sits idle waiting for next real request.
    //
    // Note: 'network_error' callers start their own probe explicitly with
    // correct mode, so don't double-start here — we only cover legacy
    // reason codes from retryChain/tick fall-throughs.
    const networkReasons = new Set([
      'retry_exhausted',
      'cache_ttl_exhausted',
      'cache_ttl_expired_mid_retry',
      'retry_budget_exceeds_ttl',
    ])
    if (networkReasons.has(reason) && !this.healthProbeTimer) {
      const cacheAge = Date.now() - this.cacheWrittenAt
      const ttlRemaining = this.cacheTtlMs - cacheAge
      const reviveMode = ttlRemaining <= this.safetyMarginMs
      this.startHealthProbe({ reviveMode })
    }
  }

  // ────────────────────────────────────────────────────────────
  // Layer 2 — Network health probe (TCP-only, non-billable)
  // ────────────────────────────────────────────────────────────

  /**
   * Aggressive TCP health probe to api.anthropic.com:443.
   * Uses escalating intervals [5s, 5s, 10s, 10s, 20s, 20s, 30s, 30s, ...] —
   * hits fast first (cache is precious, network blip may be short) and
   * ramps down when cache approaches TTL death.
   *
   * TCP-only: no tokens burned. On reconnect detection, triggers KA tick
   * if cache is still alive (>10s TTL remaining).
   *
   * Caller passes `restartRegistry` when network fault happened with cache
   * presumed dead — probe still runs so that on reconnect we can signal
   * `network_revived` → caller may want to try 1 KA fire to see if the
   * cache miraculously survived (very rare but free to check).
   */
  private startHealthProbe(opts: { reviveMode?: boolean } = {}): void {
    if (this.healthProbeTimer) return
    this.healthProbeAttempt = 0
    const prevState = this.networkState
    this.networkState = 'degraded'
    if (prevState !== 'degraded') {
      try { this.config.onNetworkStateChange?.({ from: prevState, to: 'degraded', at: Date.now() }) } catch {}
    }

    const scheduleNext = () => {
      const intervals = this.healthProbeIntervalsMs
      const idx = Math.min(this.healthProbeAttempt, intervals.length - 1)
      const delay = intervals[idx]!
      this.healthProbeTimer = setTimeout(probe, delay)
      if (this.healthProbeTimer && typeof this.healthProbeTimer === 'object' && 'unref' in this.healthProbeTimer) {
        (this.healthProbeTimer as any).unref()
      }
    }

    const probe = async () => {
      this.healthProbeTimer = null
      this.healthProbeAttempt++

      const cacheAge = Date.now() - this.cacheWrittenAt
      // "Dead" = cache is past TTL - safety margin. Even if technically
      // still alive for a few seconds, firing would risk landing AFTER
      // expiry (network latency adds unpredictable 1-10s).
      const cacheDead = cacheAge >= (this.cacheTtlMs - this.safetyMarginMs)

      // Stop probing when cache is dead AND we're not in revive-mode
      // (revive-mode wants to know ASAP when network returns so next real
      // request doesn't hang on ConnectionRefused).
      if (cacheDead && !opts.reviveMode) {
        this.stopHealthProbe()
        return
      }

      // Hard stop: 10+ failed probes even in revive-mode = give up, wait
      // for user-initiated real request to break the silence.
      if (this.healthProbeAttempt > this.healthProbeIntervalsMs.length) {
        this.stopHealthProbe()
        return
      }

      let ok = false
      try {
        const { connect } = await import('node:net')
        await new Promise<void>((resolve, reject) => {
          const sock = connect({ host: 'api.anthropic.com', port: 443 })
          const t = setTimeout(() => {
            sock.destroy()
            reject(new Error('timeout'))
          }, this.healthProbeTimeoutMs)
          sock.once('connect', () => {
            clearTimeout(t)
            sock.end()
            resolve()
          })
          sock.once('error', (e) => {
            clearTimeout(t)
            reject(e)
          })
        })
        ok = true
      } catch {
        ok = false
      }

      if (!ok) {
        scheduleNext()
        return
      }

      // Network is back.
      this.stopHealthProbe()
      const prev = this.networkState
      this.networkState = 'healthy'
      try { this.config.onNetworkStateChange?.({ from: prev, to: 'healthy', at: Date.now() }) } catch {}

      const ttlLeft = this.cacheTtlMs - (Date.now() - this.cacheWrittenAt)

      if (this.registry.size > 0 && ttlLeft > this.safetyMarginMs) {
        // Cache still alive with safety margin → fire KA immediately.
        // Note: we check SAFETY_MARGIN (not just >0) because fire itself
        // takes time — if we're within margin, tick() would just disarm anyway.
        void this.tick()
      }
      // If cache is dead or registry empty — do nothing. Engine stays in
      // post-disarm state, waiting for next real request from user which
      // will prime a new snapshot.
    }

    // First probe runs immediately (fastest reaction to network blip).
    void probe()
  }

  private stopHealthProbe(): void {
    if (this.healthProbeTimer) {
      clearTimeout(this.healthProbeTimer)
      this.healthProbeTimer = null
    }
    this.healthProbeAttempt = 0
  }

  // ────────────────────────────────────────────────────────────
  // Debug snapshot writer
  // ────────────────────────────────────────────────────────────

  private writeSnapshotDebug(model: string, body: Record<string, unknown>, usage: TokenUsage): void {
    try {
      const snapshotDir = join(homedir(), '.claude', 'snapshots')
      mkdirSync(snapshotDir, { recursive: true })

      // Rotate: delete files older than configured TTL
      try {
        const cutoff = Date.now() - KeepaliveEngine.SNAPSHOT_TTL_MS
        for (const f of readdirSync(snapshotDir)) {
          const fpath = join(snapshotDir, f)
          const st = statSync(fpath)
          if (st.mtimeMs < cutoff) unlinkSync(fpath)
        }
      } catch { /* rotation best-effort */ }

      this.snapshotCallCount++
      const msgs = body.messages as { role: string; content: unknown }[]
      const sys = body.system
      const tools = body.tools as unknown[] | undefined

      const sysStr = typeof sys === 'string' ? sys : JSON.stringify(sys)
      const sysHash = createHash('md5').update(sysStr).digest('hex').slice(0, 8)

      const meta: Record<string, unknown> = {
        ts: new Date().toISOString(),
        pid: process.pid,
        callNum: this.snapshotCallCount,
        model,
        messages: msgs?.length ?? 0,
        tools: tools?.length ?? 0,
        sysHash,
        sysLen: sysStr.length,
        usage: {
          input: usage.inputTokens ?? 0,
          cacheRead: usage.cacheReadInputTokens ?? 0,
          cacheWrite: usage.cacheCreationInputTokens ?? 0,
        },
        firstMsg: msgs?.[0] ? {
          role: msgs[0].role,
          contentLen: JSON.stringify(msgs[0].content).length,
          contentHash: createHash('md5').update(JSON.stringify(msgs[0].content)).digest('hex').slice(0, 8),
        } : null,
        lastMsg: msgs?.length ? {
          role: msgs[msgs.length - 1].role,
          contentLen: JSON.stringify(msgs[msgs.length - 1].content).length,
        } : null,
        toolsHash: tools?.length ? createHash('md5').update(
          JSON.stringify((tools as { name?: string }[]).map(t => t.name ?? '').join(','))
        ).digest('hex').slice(0, 8) : null,
      }

      const filename = `${process.pid}-${Date.now()}.json`
      writeFileSync(join(snapshotDir, filename), JSON.stringify(meta, null, 2) + '\n')

      if (KeepaliveEngine.DUMP_BODY || this.snapshotCallCount <= 3) {
        const dumpDir = join(snapshotDir, 'bodies')
        mkdirSync(dumpDir, { recursive: true })
        const dumpFile = `${process.pid}-call${this.snapshotCallCount}-${Date.now()}.json`
        writeFileSync(join(dumpDir, dumpFile), JSON.stringify(body, null, 2) + '\n')
      }
    } catch { /* debug logging must never crash */ }
  }

  // ────────────────────────────────────────────────────────────
  // Introspection (for tests / diagnostics)
  // ────────────────────────────────────────────────────────────

  /** @internal — for test inspection */
  get _registry(): ReadonlyMap<string, { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number }> {
    return this.registry
  }

  /** @internal — for test inspection */
  get _timer(): ReturnType<typeof setInterval> | null { return this.timer }

  /** @internal — for test inspection */
  get _config() { return this.config }

  /** @internal — for test inspection */
  get _lastKnownCacheTokensByModel(): ReadonlyMap<string, number> { return this.lastKnownCacheTokensByModel }

  /** @internal — mutable internal state getters/setters for test inspection */
  _setLastRealActivityAt(v: number): void { this.lastRealActivityAt = v }
  _setCacheWrittenAt(v: number): void { this.cacheWrittenAt = v }
  get _cacheWrittenAt(): number { return this.cacheWrittenAt }
  _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void {
    this._pendingSnapshotModel = model
    this._pendingSnapshotBody = body
    this._pendingSnapshotHeaders = headers
  }
}
