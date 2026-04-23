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
 *   - intervalMs clamped to [60s, 240s] at construction
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
}

// ============================================================
// Live-reload config — ~/.claude/keepalive.json
// ============================================================

const KEEPALIVE_CONFIG_PATH = join(homedir(), '.claude', 'keepalive.json')
let _kaConfigMtimeMs = 0
let _kaConfigCache: Record<string, unknown> | null = null

function readKeepaliveConfig(): Record<string, unknown> | null {
  try {
    const st = statSync(KEEPALIVE_CONFIG_PATH)
    if (st.mtimeMs === _kaConfigMtimeMs && _kaConfigCache) return _kaConfigCache
    _kaConfigMtimeMs = st.mtimeMs
    const { readFileSync } = require('fs') as typeof import('fs')
    _kaConfigCache = JSON.parse(readFileSync(KEEPALIVE_CONFIG_PATH, 'utf8'))
    return _kaConfigCache
  } catch {
    return null
  }
}

// ============================================================
// Errors
// ============================================================

// Re-exported from types.ts — engine throws this on guard block
import { CacheRewriteBlockedError } from './types.js'

// ============================================================
// KeepaliveEngine
// ============================================================

export class KeepaliveEngine {
  // Anthropic cache TTL — API silently downgrades our ttl:'1h' to 5 minutes
  // (ephemeral_1h_input_tokens=0 in response). We're not on the 1h allowlist.
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000

  // Retry backoff: start fast (2s), ramp to 20s max. 13 attempts fit in ~180s margin.
  // Fire at ~120s, cache expires at 300s → 180s window for retries.
  private static readonly KEEPALIVE_RETRY_DELAYS = [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20]

  // Snapshot TTL — set via CLAUDE_SDK_SNAPSHOT_TTL_MIN env var. Default: 1440 (24h).
  private static readonly SNAPSHOT_TTL_MS = (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? '1440', 10) || 1440) * 60 * 1000

  // Full body dump for debugging. Set CLAUDE_SDK_DUMP_BODY=1 to enable.
  private static readonly DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === '1'

  // Layer 2 — Network health probe.
  private static readonly HEALTH_PROBE_INTERVAL_MS = 30_000
  private static readonly HEALTH_PROBE_TIMEOUT_MS = 3_000

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

  // ── State ──────────────────────────────────────────────────
  // Largest observed cache size per model (used for rewrite cost estimation)
  private lastKnownCacheTokensByModel = new Map<string, number>()

  // Layer 2: network health probe state
  private networkState: 'healthy' | 'degraded' = 'healthy'
  private healthProbeTimer: ReturnType<typeof setInterval> | null = null

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

    const ka = opts.config ?? {}

    // Layer 4: Clamp interval to safe bounds.
    let intervalMs = ka.intervalMs ?? 120_000
    if (intervalMs < 60_000) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} below safe min (60000); clamped`)
      intervalMs = 60_000
    }
    if (intervalMs > 240_000) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} above safe max (240000, cache TTL - 60s); clamped`)
      intervalMs = 240_000
    }

    this.config = {
      enabled: ka.enabled ?? true,
      intervalMs,
      idleTimeoutMs: ka.idleTimeoutMs ?? Infinity,
      minTokens: ka.minTokens ?? 2000,
      rewriteWarnIdleMs: ka.rewriteWarnIdleMs ?? 300_000,
      rewriteWarnTokens: ka.rewriteWarnTokens ?? 50_000,
      rewriteBlockIdleMs: ka.rewriteBlockIdleMs ?? Infinity,
      rewriteBlockEnabled: ka.rewriteBlockEnabled ?? false,
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
   *   - If gap > warnIdleMs AND estimated cache size > warnTokens → warning callback
   *   - If gap > blockIdleMs AND blockEnabled → throws CacheRewriteBlockedError
   */
  checkRewriteGuard(model: string): void {
    const lastReal = this.lastRealActivityAt
    if (lastReal === 0) return  // First-ever request; no baseline yet.
    const idleMs = Date.now() - lastReal
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

    // Live-reload config from ~/.claude/keepalive.json (mtime-cached, cheap)
    const liveConfig = readKeepaliveConfig()
    if (liveConfig) {
      if (liveConfig.enabled === false) {
        this.registry.clear()
        this.stop()
        return
      }
      if (typeof liveConfig.intervalSec === 'number' && liveConfig.intervalSec > 0)
        this.config.intervalMs = liveConfig.intervalSec * 1000
      if (typeof liveConfig.idleTimeoutSec === 'number' && liveConfig.idleTimeoutSec > 0)
        this.config.idleTimeoutMs = liveConfig.idleTimeoutSec * 1000
      else if (liveConfig.idleTimeoutSec === null || liveConfig.idleTimeoutSec === 0)
        this.config.idleTimeoutMs = Infinity
      if (typeof liveConfig.minTokens === 'number')
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
      const status = (err as { status?: number })?.status
      const isTransient = !status || status === 503 || status === 529 || status >= 500

      if (isTransient) {
        this.retryChain(best)
      } else {
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
    if (attemptIndex >= KeepaliveEngine.KEEPALIVE_RETRY_DELAYS.length) {
      this.registry.clear()
      this.onDisarmed('retry_exhausted')
      return
    }

    const cacheAge = Date.now() - this.cacheWrittenAt
    const ttlRemaining = KeepaliveEngine.CACHE_TTL_MS - cacheAge
    const nextDelay = KeepaliveEngine.KEEPALIVE_RETRY_DELAYS[attemptIndex]! * 1000

    if (ttlRemaining < nextDelay + 5000) {
      // CRITICAL INVARIANT: KA must NEVER cache_write.
      this.registry.clear()
      this.onDisarmed('cache_ttl_exhausted')
      return
    }

    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null

      // Re-check: if a real request happened since we started retrying, stop.
      if (this.lastRealActivityAt > this.cacheWrittenAt) {
        return
      }

      const ageNow = Date.now() - this.cacheWrittenAt
      if (ageNow > KeepaliveEngine.CACHE_TTL_MS - 5000) {
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
        const status = (err as { status?: number })?.status
        const isTransient = !status || status === 503 || status === 529 || status >= 500

        if (isTransient) {
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

    // Layer 2: start health probe ONLY if cache is still worth saving.
    const networkReasons = new Set(['retry_exhausted', 'cache_ttl_exhausted', 'cache_ttl_expired_mid_retry'])
    if (networkReasons.has(reason)) {
      const cacheAge = Date.now() - this.cacheWrittenAt
      const ttlRemaining = KeepaliveEngine.CACHE_TTL_MS - cacheAge
      if (ttlRemaining > 30_000) {
        this.startHealthProbe()
      }
    }
  }

  // ────────────────────────────────────────────────────────────
  // Layer 2 — Network health probe (TCP-only, non-billable)
  // ────────────────────────────────────────────────────────────

  private startHealthProbe(): void {
    if (this.healthProbeTimer) return
    const prevState = this.networkState
    this.networkState = 'degraded'
    if (prevState !== 'degraded') {
      try { this.config.onNetworkStateChange?.({ from: prevState, to: 'degraded', at: Date.now() }) } catch {}
    }

    const probe = async () => {
      const cacheAge = Date.now() - this.cacheWrittenAt
      if (cacheAge >= KeepaliveEngine.CACHE_TTL_MS) {
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
          }, KeepaliveEngine.HEALTH_PROBE_TIMEOUT_MS)
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

      if (ok) {
        this.stopHealthProbe()
        const prev = this.networkState
        this.networkState = 'healthy'
        try { this.config.onNetworkStateChange?.({ from: prev, to: 'healthy', at: Date.now() }) } catch {}
        const ttlLeft = KeepaliveEngine.CACHE_TTL_MS - (Date.now() - this.cacheWrittenAt)
        if (this.registry.size > 0 && ttlLeft > 10_000) {
          void this.tick()
        }
      }
    }

    void probe()
    this.healthProbeTimer = setInterval(probe, KeepaliveEngine.HEALTH_PROBE_INTERVAL_MS)
    if (this.healthProbeTimer && typeof this.healthProbeTimer === 'object' && 'unref' in this.healthProbeTimer) {
      (this.healthProbeTimer as any).unref()
    }
  }

  private stopHealthProbe(): void {
    if (this.healthProbeTimer) {
      clearInterval(this.healthProbeTimer)
      this.healthProbeTimer = null
    }
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
  _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void {
    this._pendingSnapshotModel = model
    this._pendingSnapshotBody = body
    this._pendingSnapshotHeaders = headers
  }
}
