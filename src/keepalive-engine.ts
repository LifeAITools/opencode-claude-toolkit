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

import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { ANTHROPIC_API_HOST } from './anthropic-endpoints.js'
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

  /**
   * Optional SHARED cross-engine eviction circuit breaker. When this engine's
   * Layer 5 detects a server-side cold-write eviction it trips the breaker;
   * before firing, every engine consults it and HOLDS (skips the fire) while it
   * is tripped — turning an N-session eviction-rewrite cascade into one rewrite
   * plus a brief fleet-wide hold. Pass the SAME instance to every engine in the
   * process (the proxy does this via SessionTracker). Omit for single-session
   * SDK use — then the engine behaves exactly as before.
   */
  evictionBreaker?: EvictionCircuitBreaker
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
import { lineageKey, classifyRole, type AgentRole, type RoleHints } from './lineage.js'
import type { PersistedEngineState } from './ka-snapshot-store.js'
import type { EvictionCircuitBreaker } from './eviction-breaker.js'
import { isServerSideEviction } from './eviction-breaker.js'

// ============================================================
// Per-lineage KA state shapes
// ============================================================

/** One KA registry entry — keyed by cache lineage, not by model. */
interface RegistryEntry {
  body: Record<string, unknown>
  headers: Record<string, string>
  model: string
  lineageKey: string
  role: AgentRole
  inputTokens: number
  hasCacheControl: boolean
}

/** A snapshot primed by notifyRealRequestStart, awaiting its completion. */
interface PendingSnapshot {
  model: string
  body: Record<string, unknown>
  headers: Record<string, string>
  role: AgentRole
}

/** Observed per-lineage history — feeds the main-agent detector. */
interface LineageStat {
  firstSeenAt: number
  /** Last REAL request for this lineage. Drives the role detector's
   *  `resumedAfterIdle` signal — must NOT be touched by KA fires. */
  lastSeenAt: number
  /** Last time this lineage's cache was WARMED — by a real request OR a KA
   *  fire. This is the PER-LINEAGE idle clock the tick uses to decide when to
   *  fire: it lets the engine see that the main agent's lineage is idle even
   *  while sub-agent lineages are busy (the global `lastActivityAt` could
   *  not — sub-agent traffic masked it). */
  lastWarmedAt: number
  maxToolCount: number
  /** Set once a lineage has gone idle past TTL and then resumed — the
   *  definitionally-correct "this is the main agent" behavioural signal. */
  resumedAfterIdle: boolean
}

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
// Wire-format autoscan: detect cache_control TTL from request body
// ============================================================
//
// Anthropic API encodes per-block cache lifetime via:
//   "cache_control": { "type": "ephemeral" }              ← 5 min default
//   "cache_control": { "type": "ephemeral", "ttl": "5m" } ← 5 min explicit
//   "cache_control": { "type": "ephemeral", "ttl": "1h" } ← 1 hour
//
// Markers may appear inside: body.system[*].cache_control,
// body.messages[*].content[*].cache_control, body.tools[*].cache_control.
//
// Defensive principle: take the MINIMUM TTL observed across all markers.
// Reason: KA must refresh BEFORE the shortest-lived block dies. Longer-lived
// blocks survive incidentally. Choosing max would let short blocks expire and
// force cache_creation rewrite on next real request.

/** All known cache_control TTL string → milliseconds. Extend if Anthropic adds new tiers. */
const TTL_STRING_MS: Readonly<Record<string, number>> = {
  '5m': 5 * 60 * 1000,
  '1h': 60 * 60 * 1000,
}

const EPHEMERAL_DEFAULT_TTL_MS = 5 * 60 * 1000  // anthropic default when no ttl: field

/**
 * Extract one cache_control marker's effective TTL in ms, or null if not a recognized
 * ephemeral marker. Never throws — bad shapes return null.
 */
function ttlFromCacheControl(cc: unknown): number | null {
  if (!cc || typeof cc !== 'object') return null
  const o = cc as { type?: unknown; ttl?: unknown }
  if (o.type !== 'ephemeral') return null
  if (typeof o.ttl === 'string') {
    const mapped = TTL_STRING_MS[o.ttl]
    if (mapped !== undefined) return mapped
    // Unknown ttl string → safest: treat as default 5min, not as "honor unknown".
    return EPHEMERAL_DEFAULT_TTL_MS
  }
  return EPHEMERAL_DEFAULT_TTL_MS
}

/**
 * Scan an Anthropic request body for ALL cache_control markers and return
 * shape info needed for KA decisions:
 *   - `minTtlMs`: shortest observed marker TTL, or null if no markers found.
 *     A non-null value is the conservative TTL the engine should use.
 *   - `hasAnyCacheControl`: true if at least one valid ephemeral marker was found.
 *     Used by Layer 3 ("no cache_control → don't fire KA, nothing to keep alive").
 *
 * Never throws on malformed body. Unknown fields silently skipped.
 *
 * @public for testing; used by KeepaliveEngine.notifyRealRequestStart.
 */
export function detectCacheTtlFromBody(body: unknown): { minTtlMs: number | null; hasAnyCacheControl: boolean } {
  if (!body || typeof body !== 'object') return { minTtlMs: null, hasAnyCacheControl: false }
  const observed: number[] = []
  const collect = (cc: unknown) => {
    const t = ttlFromCacheControl(cc)
    if (t !== null) observed.push(t)
  }

  const b = body as Record<string, unknown>

  // system can be a string (no cache_control) or array of blocks
  const sys = b.system
  if (Array.isArray(sys)) {
    for (const block of sys) {
      if (block && typeof block === 'object') collect((block as Record<string, unknown>).cache_control)
    }
  }

  // messages[].content[].cache_control — content can be string or array of blocks
  const msgs = b.messages
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue
      const content = (m as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') collect((block as Record<string, unknown>).cache_control)
        }
      }
    }
  }

  // tools[].cache_control
  const tools = b.tools
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t === 'object') collect((t as Record<string, unknown>).cache_control)
    }
  }

  if (observed.length === 0) return { minTtlMs: null, hasAnyCacheControl: false }
  return { minTtlMs: Math.min(...observed), hasAnyCacheControl: true }
}

/**
 * Upgrade every EXISTING ephemeral cache_control marker on an Anthropic
 * request body to `ttl: '1h'`. The inverse of detectCacheTtlFromBody: that
 * OBSERVES the wire cache TTL, this CONTROLS it.
 *
 * Native Claude Code marks its cacheable prefix (system / last tool / last
 * message) with `cache_control: { type: 'ephemeral' }` — a 5-minute
 * Anthropic-side TTL. A coding turn routinely runs longer than 5 minutes,
 * so that prefix dies mid-turn and the next turn must re-create the whole
 * ~140K-token cache (cache_creation ≈ 111× a cache_read). Lifting the
 * markers to `ttl: '1h'` lets the (immutable) system+tools+history prefix
 * outlive any realistic turn; keepalive reads then hold it warm for an hour.
 *
 * Only EXISTING markers are upgraded — a marker is never ADDED where the
 * client placed none (adding one would move a cache breakpoint and fork the
 * lineage). Markers already at `ttl: '1h'`, and non-ephemeral cache_control,
 * are left untouched. Sibling fields (e.g. `scope`) are preserved. Mutates
 * `body` in place. Never throws on a malformed body.
 *
 * Anthropic honors `ttl: '1h'` only with the `prompt-caching-scope-2026-01-05`
 * beta on the request — the caller gates on that header's presence.
 *
 * @returns count of markers upgraded.
 */
export function upgradeCacheControlTtl(body: unknown): { upgraded: number } {
  if (!body || typeof body !== 'object') return { upgraded: 0 }
  let upgraded = 0
  const lift = (holder: Record<string, unknown>) => {
    // NEVER touch thinking/redacted_thinking blocks: Anthropic rejects ANY
    // modification of thinking blocks in the latest assistant message (400
    // "thinking blocks ... cannot be modified"). A client may carry a
    // cache_control marker on a thinking block; bumping its ttl = modification.
    const t = (holder as { type?: unknown }).type
    if (t === 'thinking' || t === 'redacted_thinking') return
    const cc = holder.cache_control
    if (!cc || typeof cc !== 'object') return
    const o = cc as { type?: unknown; ttl?: unknown }
    if (o.type !== 'ephemeral') return
    if (o.ttl === '1h') return
    o.ttl = '1h'
    upgraded++
  }
  const b = body as Record<string, unknown>

  // system can be a string (no cache_control) or an array of blocks
  const sys = b.system
  if (Array.isArray(sys)) {
    for (const block of sys) {
      if (block && typeof block === 'object') lift(block as Record<string, unknown>)
    }
  }

  // messages[].content[].cache_control — content can be string or block array
  const msgs = b.messages
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      if (!m || typeof m !== 'object') continue
      const content = (m as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && typeof block === 'object') lift(block as Record<string, unknown>)
        }
      }
    }
  }

  // tools[].cache_control
  const tools = b.tools
  if (Array.isArray(tools)) {
    for (const t of tools) {
      if (t && typeof t === 'object') lift(t as Record<string, unknown>)
    }
  }

  return { upgraded }
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
  // Resolved values are cached per-instance at construction time and
  // **selectively** refreshed in tick() when keepalive.json mtime changes.
  // Specifically `cacheTtlMs`, `safetyMarginMs`, `intervalMs`,
  // `idleTimeoutMs`, `minTokens` are live-reloadable. Other params are
  // fixed at construction.
  //
  // Bug fixed 2026-04-30: `cacheTtlMs` was previously `readonly` and only
  // set in constructor. Long-lived pids that started with the legacy
  // 5-minute default never saw the SSOT update to 1h, causing
  // `cache_expired_during_sleep` disarms every 5 minutes despite the
  // file being correct. Removed `readonly` and added live-reload below.
  private cacheTtlMs: number
  /**
   * When the consumer passes `config.cacheTtlMs` to the constructor, we LOCK
   * the TTL to that value and stop honoring SSOT live-reload AND wire-autoscan
   * for it. This is the "admin pinned" escape hatch — explicit caller wins.
   * See KeepaliveConfig.cacheTtlMs (types.ts) for full rationale.
   */
  private readonly cacheTtlOverridden: boolean
  /**
   * Set to true when wire-autoscan (detectCacheTtlFromBody, called in
   * notifyRealRequestStart) observes a `cache_control` marker shorter than
   * the current cacheTtlMs and locks the engine down to that shorter value.
   *
   * Monotonic-down only: subsequent observations may reduce TTL further but
   * NEVER raise it (defensive — if we ever saw a 5min block, assume server
   * still has 5min blocks alive until session ends; over-fire is fine, under-
   * fire wastes tokens). Also blocks SSOT live-reload from raising TTL.
   */
  private cacheTtlObservedLocked: boolean = false
  private safetyMarginMs: number
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
    onTtlScan?: (info: { minTtlMs: number | null; previousTtlMs: number | null; hasAnyCacheControl: boolean; at: number }) => void
    onRegistryChange?: () => void
  }

  /** Last observed wire cache_control min-TTL (ms). null = none seen yet / no markers. */
  private lastObservedTtlMs: number | null = null
  /** True once the first TTL scan has run — distinguishes "never seen" from "seen null". */
  private ttlEverObserved = false

  // ── Injected deps ──────────────────────────────────────────
  private readonly getToken: () => Promise<string>
  private readonly doFetch: KeepaliveEngineOptions['doFetch']
  private readonly getRateLimitInfo: () => RateLimitInfo
  private readonly isOwnerAlive: () => boolean
  /** Shared cross-engine eviction breaker (null in single-session SDK use). */
  private readonly evictionBreaker: EvictionCircuitBreaker | null

  // ── State ──────────────────────────────────────────────────
  // Largest observed cache size per model (used for rewrite cost estimation)
  private lastKnownCacheTokensByModel = new Map<string, number>()

  // Layer 2: network health probe state
  private networkState: 'healthy' | 'degraded' = 'healthy'
  private healthProbeTimer: ReturnType<typeof setTimeout> | null = null
  private healthProbeAttempt = 0

  // KA registry — one entry per cache LINEAGE (hash of system⊕tools), not per
  // model. main agent + sub-agents share a model (claude-opus-4-7) but have
  // distinct lineages; keying by lineage stops a heavy sub-agent from clobbering
  // the main agent's slot (the model-keyed `heaviest-wins` failure). Only
  // main/unknown-role lineages are registered — sub-agents self-warm via their
  // own continuous traffic and an idle sub-agent is finished, not parked.
  // hasCacheControl: Layer 3 — when false, a fire refreshes nothing; skip it.
  private registry = new Map<string, RegistryEntry>()

  // Last-known committed snapshot per lineage — retained even after clearRegistry
  // so the engine can SELF-HEAL: re-prime a live idle session whose snapshot was
  // dropped (reload / restart-no-revive) instead of waiting for a real request
  // that may never come (a main agent idle while sub-agents work other lineages).
  private lastSnapshots = new Map<string, RegistryEntry>()
  // Only re-prime after a re-primeable clear (reload). Terminal clears
  // (owner_dead, cache_expired, eviction, auth/permanent error) set this false
  // so a dead/evicted session is never resurrected into a cold-rewrite loop.
  private selfHealEligible = false

  // Pending snapshots — keyed by lineageKey so concurrent requests of DIFFERENT
  // lineages (main + sub-agent in flight together) cannot clobber each other.
  // The single-slot version silently dropped registrations under sub-agent
  // fan-out, which left the KA unable to re-arm after a disarm.
  private pendingSnapshots = new Map<string, PendingSnapshot>()

  // Per-lineage observed history — feeds classifyRole's hints.
  private lineageStats = new Map<string, LineageStat>()

  // Lineages whose cache was last written under a DIFFERENT org than the one
  // now billing real requests. While pending, the KA fire replays the snapshot's
  // OWN (old-org) Authorization to keep the OLD org's cache warm until the user
  // decides (sends the override marker → re-registers under the new org) or the
  // old token expires (401 → auth-disarm). Set by ProxyClient on an org-switch
  // block; cleared on re-registration (notifyRealRequestComplete) and clearRegistry.
  private orgSwitchPending = new Set<string>()
  /** Test accessor. */
  get _orgSwitchPending(): Set<string> { return this.orgSwitchPending }

  // Legacy fallback: notifyRealRequestComplete(usage) called WITHOUT a
  // lineageKey (SDK direct use / tests — all sequential) commits the most
  // recently primed lineage. Concurrency-safe callers pass the key explicitly.
  private _legacyPendingLineage = ''

  // Timestamps
  private lastActivityAt = 0
  private lastRealActivityAt = 0
  private cacheWrittenAt = 0

  // Timers & abort
  private timer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private abortController: AbortController | null = null
  private inFlight = false
  /** Lineage of the KA fire currently in flight — so a real request of a
   *  DIFFERENT lineage does not abort it (master-warm-while-sub-agents-run). */
  private inFlightLineageKey: string | null = null
  // -1 = uninitialized (will be seeded on first fire-eligible tick).
  // 0 = explicit "no jitter" (honored — used by tests to make timing deterministic).
  // >0 = current jitter offset added to fire threshold to spread multi-session bursts.
  private jitterMs = -1

  // Quota-pause state (set when 429 arrives with resetAt header; engine
  // suspends fires until resetAt because retrying before quota window
  // resets would consume cache TTL + tokens for no benefit).
  // Wake triggers: scheduled timer (resetAt + jitter) OR notifyRealRequestStart
  // (consumer-side request implies upstream is usable from their side).
  private quotaPauseTimer: ReturnType<typeof setTimeout> | null = null
  private quotaPauseUntil: number | null = null

  // Debug counter
  private snapshotCallCount = 0

  constructor(opts: KeepaliveEngineOptions) {
    this.getToken = opts.getToken
    this.doFetch = opts.doFetch
    this.getRateLimitInfo = opts.getRateLimitInfo
    // Default: always-alive (preserve existing behavior when caller omits).
    this.isOwnerAlive = opts.isOwnerAlive ?? (() => true)
    this.evictionBreaker = opts.evictionBreaker ?? null

    const ka = opts.config ?? {}

    // SSOT: read cache+KA parameters from ~/.claude/keepalive.json (with safe defaults).
    const ssot = loadKeepaliveConfig()
    // Per-consumer override: if caller provides cacheTtlMs (e.g. proxy adapter
    // pins 5min for native CC), use it and lock — SSOT live-reload won't touch it.
    // Otherwise honor SSOT (opencode-style consumers get 1h cache as configured).
    if (typeof ka.cacheTtlMs === 'number' && Number.isFinite(ka.cacheTtlMs) && ka.cacheTtlMs > 0) {
      this.cacheTtlMs = ka.cacheTtlMs
      this.cacheTtlOverridden = true
    } else {
      this.cacheTtlMs = ssot.cacheTtlMs
      this.cacheTtlOverridden = false
    }
    this.safetyMarginMs = ssot.safetyMarginMs
    this.retryDelaysMs = ssot.retryDelaysMs
    this.healthProbeIntervalsMs = ssot.healthProbeIntervalsMs
    this.healthProbeTimeoutMs = ssot.healthProbeTimeoutMs

    // Layer 4: Clamp interval to safe bounds derived from EFFECTIVE cache TTL.
    // When cacheTtlMs was overridden, ssot.intervalClampMax (derived from
    // SSOT.cacheTtlMs) is wrong — recompute against this.cacheTtlMs so that
    // intervalMs never exceeds our actual cache lifetime.
    const effectiveClampMin = ssot.intervalClampMin
    const effectiveClampMax = this.cacheTtlOverridden
      ? Math.max(effectiveClampMin + 1, this.cacheTtlMs - this.safetyMarginMs - 60_000)
      : ssot.intervalClampMax
    // When override is active and SSOT's default interval is sized for a longer
    // TTL (e.g. 1800s for 1h), fall back to half the override TTL.
    const effectiveDefaultInterval = this.cacheTtlOverridden
      ? Math.max(effectiveClampMin, Math.min(this.cacheTtlMs / 2, ssot.intervalMs))
      : ssot.intervalMs
    let intervalMs = ka.intervalMs ?? effectiveDefaultInterval
    if (intervalMs < effectiveClampMin) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} below safe min (${effectiveClampMin}); clamped`)
      intervalMs = effectiveClampMin
    }
    if (intervalMs > effectiveClampMax) {
      console.error(`[claude-sdk] keepalive intervalMs=${intervalMs} above safe max (${effectiveClampMax}, cacheTTL ${this.cacheTtlMs}ms - margin ${this.safetyMarginMs}ms - 60s${this.cacheTtlOverridden ? ', override active' : ''}); clamped`)
      intervalMs = effectiveClampMax
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
      onTtlScan: ka.onTtlScan,
      onRegistryChange: ka.onRegistryChange,
    }
  }

  // ────────────────────────────────────────────────────────────
  // Public API
  // ────────────────────────────────────────────────────────────

  /**
   * Call at the top of every real request. Primes the pending snapshot slot
   * with the body/headers about to be sent, and aborts any in-flight KA.
   */
  notifyRealRequestStart(model: string, body: Record<string, unknown>, headers: Record<string, string>): string {
    // If engine is paused on 429, a real user request implies upstream is
    // reachable from the consumer's perspective — wake immediately. If their
    // request also gets 429'd we'll re-enter pause on the next KA attempt.
    this.wakeFromQuotaPause()

    // ── Lineage identity + per-lineage history ──────────────────────
    // Pure, never-throws. The lineageKey identifies a distinct cache prefix
    // regardless of whether the consumer runs sub-agents as threads (Claude
    // Code) or processes (opencode).
    const key = lineageKey(body)
    const now = Date.now()
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0
    const stat = this.lineageStats.get(key)
    if (!stat) {
      this.lineageStats.set(key, {
        firstSeenAt: now, lastSeenAt: now, lastWarmedAt: now,
        maxToolCount: toolCount, resumedAfterIdle: false,
      })
    } else {
      // Resumed-after-idle: this lineage went quiet past the cache TTL and is
      // back — the definitionally-correct proof that it is the MAIN agent
      // (sub-agents never resume; they burst once and vanish).
      if (now - stat.lastSeenAt > this.cacheTtlMs) stat.resumedAfterIdle = true
      stat.lastSeenAt = now
      stat.lastWarmedAt = now            // a real request warms this lineage
      if (toolCount > stat.maxToolCount) stat.maxToolCount = toolCount
    }

    // ── Role classification (layered, advisory, never throws) ───────
    const maxToolsSeen = Math.max(
      0, ...Array.from(this.lineageStats.values()).map((s) => s.maxToolCount),
    )
    const oldestSeen = Math.min(
      now, ...Array.from(this.lineageStats.values()).map((s) => s.firstSeenAt),
    )
    const hints: RoleHints = {
      resumedAfterIdle: this.lineageStats.get(key)?.resumedAfterIdle,
      oldestInGroup: (this.lineageStats.get(key)?.firstSeenAt ?? now) <= oldestSeen,
      richestToolsInGroup: toolCount >= maxToolsSeen && toolCount > 0,
    }
    // roleDetector weights/thresholds come from the SSOT (keepalive.json),
    // mtime-cached + hot-reloaded — tunable on the fly, never hardcoded.
    const role = classifyRole(body, headers, hints, loadKeepaliveConfig().roleDetector).role

    // Snapshot for keepalive registry — keyed by lineage so a concurrent
    // sub-agent request cannot clobber the main agent's pending slot.
    this.pendingSnapshots.set(key, {
      model,
      body: JSON.parse(JSON.stringify(body)),
      headers: { ...headers },
      role,
    })
    this._legacyPendingLineage = key

    // ── Observability: scan EVERY real request for wire cache_control TTL ──
    // Runs unconditionally (even when TTL is pinned via constructor override),
    // so operators always see the actual wire TTL and any change. Decoupled
    // from the downlock decision below, which stays gated on !cacheTtlOverridden.
    let scannedMinTtlMs: number | null = null
    try {
      const scan = detectCacheTtlFromBody(body)
      scannedMinTtlMs = scan.minTtlMs
      // Observability tracks ONLY requests that actually carry cache_control.
      // Lightweight requests (count_tokens, title-gen, quota checks) ship no
      // cache_control at all — that is NOT a signal that the session's cache
      // TTL policy dropped to "none". Treating a no-cache_control request as a
      // TTL observation caused misleading "5m → none → 5m" flapping in the
      // CACHE_TTL_CHANGED event. A no-cache_control request is a NON-observation:
      // skip it entirely and hold the strictest TTL already observed. This keeps
      // the event aligned with the keepalive decision below, which likewise
      // ignores null observations (monotonic downlock).
      if (scan.hasAnyCacheControl) {
        const changed = !this.ttlEverObserved || scan.minTtlMs !== this.lastObservedTtlMs
        if (changed) {
          const previousTtlMs = this.ttlEverObserved ? this.lastObservedTtlMs : null
          try {
            this.config.onTtlScan?.({
              minTtlMs: scan.minTtlMs,
              previousTtlMs,
              hasAnyCacheControl: scan.hasAnyCacheControl,
              at: Date.now(),
            })
          } catch { /* observer best-effort */ }
          try {
            appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
              `[${new Date().toISOString()}] KA_TTL_SCAN pid=${process.pid} minMs=${scan.minTtlMs} prevMs=${previousTtlMs} hasCC=${scan.hasAnyCacheControl} minMin=${scan.minTtlMs === null ? 'na' : Math.round(scan.minTtlMs / 60000)} source=request_scan\n`)
          } catch { /* logging best-effort */ }
        }
        this.lastObservedTtlMs = scan.minTtlMs
        this.ttlEverObserved = true
      }
    } catch { /* scan failure → keep prior observation state, defensive */ }

    // ── Layer 1+2: wire-format TTL autoscan + monotonic lock-down ──
    // Skip when admin explicitly pinned TTL via constructor config (Layer 0).
    // Reuses the scan result above — no second body walk.
    if (!this.cacheTtlOverridden) {
      try {
        const minTtlMs = scannedMinTtlMs
        if (minTtlMs !== null && minTtlMs < this.cacheTtlMs) {
          const oldTtl = this.cacheTtlMs
          this.cacheTtlMs = minTtlMs
          this.cacheTtlObservedLocked = true
          // Visible audit — operator can see exactly when wire-observed TTL
          // overrode SSOT (e.g. proxy intercepts native CC traffic, sees
          // 5min markers, locks down from 1h SSOT default).
          try {
            appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
              `[${new Date().toISOString()}] KA_TTL_OBSERVED_DOWNLOCK pid=${process.pid} oldMs=${oldTtl} newMs=${minTtlMs} oldMin=${Math.round(oldTtl / 60000)} newMin=${Math.round(minTtlMs / 60000)} source=request_scan\n`)
          } catch { /* logging best-effort */ }
        }
      } catch { /* scan failure → keep current TTL, defensive default */ }
    }

    // Abort the in-flight KA fire ONLY if it is for THIS SAME lineage — a
    // real request of the same lineage makes its KA redundant. A real request
    // for a DIFFERENT lineage (e.g. a sub-agent firing while the main agent's
    // KA is in flight) must NOT interrupt it: that is the whole point of
    // keeping the delegating master agent warm independently of sub-agents.
    if (this.inFlight && this.inFlightLineageKey === key) {
      this.abortController?.abort()
      this.inFlight = false
      this.inFlightLineageKey = null
    }

    // Return the lineageKey so the consumer can hand it back to
    // notifyRealRequestComplete — the concurrency-safe completion path.
    return key
  }

  /**
   * Call after a real request completes successfully. Registers the pending
   * snapshot for KA — but ONLY for the main agent's lineage. Sub-agent and aux
   * lineages are never registered (sub-agents self-warm via their own traffic;
   * aux calls carry no reusable context).
   *
   * `lineageKey` should be the value returned by the matching
   * notifyRealRequestStart — required for concurrency-safety under sub-agent
   * fan-out. When omitted, falls back to the most recently primed lineage
   * (safe only for sequential callers: SDK direct use, tests).
   */
  notifyRealRequestComplete(usage: TokenUsage, lineageKeyArg?: string): void {
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

    // Commit the pending snapshot for this lineage. Keyed by lineageKey so a
    // concurrent sub-agent completion cannot consume the main agent's slot.
    const key = lineageKeyArg ?? this._legacyPendingLineage
    // A completed real request means the user proceeded (override marker
    // accepted, or same-org). This lineage's org-switch window is over.
    if (key) this.orgSwitchPending.delete(key)
    const pending = key ? this.pendingSnapshots.get(key) : undefined
    if (pending) {
      const { model, body, headers, role } = pending
      const totalTokens = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
      // Layer 3 input: does the snapshot carry any cache_control markers? If
      // not, a KA fire refreshes nothing on Anthropic's side — skipped in tick().
      const { hasAnyCacheControl } = detectCacheTtlFromBody(body)

      // Register for KA — UNLESS this is a sub-agent lineage. An active
      // sub-agent self-warms via its own ~10s traffic; an idle one is finished,
      // not parked. Only main/unknown lineages get parked-and-resumed and thus
      // need KA. (`unknown` registers as the over-KA-safe default — under-KA is
      // expensive, over-KA is cheap.) Registry is keyed by lineage, so a heavy
      // sub-agent can no longer clobber the main agent's slot.
      const existing = this.registry.get(key)
      if (role !== 'sub'
          && totalTokens >= this.config.minTokens
          && (!existing || totalTokens >= existing.inputTokens)) {
        const entry = {
          body, headers, model, lineageKey: key, role,
          inputTokens: totalTokens, hasCacheControl: hasAnyCacheControl,
        }
        this.registry.set(key, entry)
        this.lastSnapshots.set(key, entry) // retain for self-heal re-prime
        this.notifyRegistryChanged()
      }

      // Track largest observed cache size per model — feeds the rewrite-guard
      // cost estimate (model-scoped); updated for every role.
      const prevMax = this.lastKnownCacheTokensByModel.get(model) ?? 0
      if (totalTokens > prevMax) this.lastKnownCacheTokensByModel.set(model, totalTokens)

      // Snapshot metadata for debugging (rotate: keep last 24h).
      this.writeSnapshotDebug(model, body, usage)

      this.pendingSnapshots.delete(key)
    }

    if (this.registry.size > 0) this.startTimer()
  }

  /** Flag a lineage as awaiting the user's org-switch decision. While set, the
   *  KA fire replays the snapshot's own (old-org) Authorization to keep the OLD
   *  cache warm. Called by ProxyClient when an org-switch rewrite is blocked. */
  markOrgSwitchPending(lineageKeyArg: string): void { this.orgSwitchPending.add(lineageKeyArg) }
  /** Clear the org-switch-pending flag for a lineage. */
  clearOrgSwitchPending(lineageKeyArg: string): void { this.orgSwitchPending.delete(lineageKeyArg) }

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
    if (this.quotaPauseTimer) {
      clearTimeout(this.quotaPauseTimer)
      this.quotaPauseTimer = null
    }
    this.quotaPauseUntil = null
    this.abortController?.abort()
    this.clearRegistry()
    this.inFlight = false
    this.stopHealthProbe()
  }

  /**
   * Externally-triggered disarm — clears registry, fires onDisarmed, stops timers.
   *
   * Used by admin endpoints (e.g. `claude-max disarm` for safe org-swap) when the
   * caller wants the engine to drop its current snapshot and stop firing KAs
   * regardless of TTL/quota state. The next real request from the consumer will
   * re-prime a fresh snapshot.
   *
   * Distinct from `stop()` (which is silent shutdown) because this notifies
   * `onDisarmed` so observers (TUI, logs) record the cause.
   */
  disarm(reason: string): void {
    this.logClearDiag('external_disarm', { reason })
    this.clearRegistry()
    try { this.config.onDisarmed?.({ reason, at: Date.now() }) } catch {}
    this.stop()
  }

  /**
   * Non-destructive reload — the org-swap / credential-refresh path.
   *
   * Unlike disarm()/stop(), this does NOT kill the tick timer. It drops the
   * stale snapshot (an old org's cached prefix is useless against a new org —
   * replaying it would cold-write the new org's quota) and aborts any in-flight
   * KA fire, but leaves the timer running so the engine **auto-resumes** the
   * moment the next real request re-registers a snapshot.
   *
   * This fixes the failure where one `claude-max disarm` killed KA for the rest
   * of the session: disarm()→stop() nulled the timer, and re-arming then
   * depended on a fragile path that sub-agent request concurrency could starve.
   *
   * Token freshness is the caller's concern: ProxyClient.reloadSessions()
   * invalidates the credential cache; each KA fire rebuilds Authorization from
   * a fresh getToken(). disarm() (full stop) is reserved for shutdown.
   */
  reload(reason: string): void {
    this.logClearDiag('external_reload', { reason })
    this.abortController?.abort()
    this.abortController = null
    this.inFlight = false
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    // Drop committed (stale-org) snapshots. Pending in-flight snapshots are
    // kept — their real request goes to the NEW org, so their completion is a
    // valid fresh registration.
    this.clearRegistry()
    // Re-primeable clear: reload (org/token swap) is NOT terminal — the cache
    // prefix is usually still valid for the live session. Mark eligible so the
    // next tick SELF-HEALS (re-primes from lastSnapshots) for a live idle
    // session, instead of silently staying cold until a real request arrives.
    this.selfHealEligible = true
    // Timer intentionally left running — tick() self-heals or no-ops against the
    // empty registry, and re-arms on the next notifyRealRequestComplete.
    try { this.config.onDisarmed?.({ reason, at: Date.now() }) } catch {}
  }

  // ────────────────────────────────────────────────────────────
  // Internal: timer & tick
  // ────────────────────────────────────────────────────────────

  private startTimer(): void {
    if (this.timer) return
    const TICK_MS = Math.min(30_000, Math.max(5_000, Math.floor(this.config.intervalMs / 6)))
    // tick() is async; the interval callback drops its promise, so a reject
    // (e.g. an upstream throw or transient null-deref during a KA fire) would
    // surface as a global unhandledRejection. Contain it via logAsyncReject.
    this.timer = setInterval(() => { void this.tick().catch((e) => this.logAsyncReject('tick@interval', e)) }, TICK_MS)
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as any).unref()
    }
  }

  private async tick(): Promise<void> {
    // ── KA_HEARTBEAT: visible proof engine is alive on EVERY tick ─────
    // Writes a single low-cost line every TICK_MS (≤30s) to debug log so
    // operators can confirm the engine is running even on totally idle pids.
    // Independent of `onTick` callback (which is gated by jitter window).
    // Format is grep-friendly: `KA_HEARTBEAT pid=X regSize=N idleSec=... ...`
    try {
      const cacheAge = this.cacheWrittenAt > 0 ? Date.now() - this.cacheWrittenAt : -1
      const idleSec = Math.round((Date.now() - this.lastActivityAt) / 1000)
      const nextFireSec = Math.max(0, Math.round((this.config.intervalMs - (Date.now() - this.lastActivityAt)) / 1000))
      const state = this.inFlight ? 'firing' : (this.registry.size === 0 ? 'empty_registry' : 'armed')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] KA_HEARTBEAT pid=${process.pid} state=${state} regSize=${this.registry.size} idleSec=${idleSec} nextFireSec=${nextFireSec} cacheAgeSec=${cacheAge < 0 ? 'na' : Math.round(cacheAge / 1000)} cacheTtlSec=${Math.round(this.cacheTtlMs / 1000)} intervalSec=${Math.round(this.config.intervalMs / 1000)}\n`)
    } catch { /* logging best-effort */ }

    if (this.inFlight) return
    // Empty registry: try self-heal (re-prime a live idle session whose snapshot
    // was dropped by reload). If not eligible/possible, nothing to fire.
    if (this.registry.size === 0 && !this.trySelfHeal()) return

    // ── Layer 0a: owner-alive check (JIT PID-death gate) ───────────
    // Call BEFORE anything else — if consumer process is gone, instantly
    // disarm. Saves wasted KA fires into a dead owner's cache.
    try {
      if (!this.isOwnerAlive()) {
        this.logClearDiag('owner_dead', { ownerCheck: 'tick' })
        this.clearRegistry()
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
        // Visible audit trail — log the EXACT values that triggered disarm
        // so operators can distinguish:
        //   - Genuine cache-TTL expiry (cacheAge slightly > cacheTtlMs)
        //   - Stale-config bug (cacheAge tiny, cacheTtlMs is from old default)
        //   - Sleep/wake edge case (cacheAge huge from machine sleep)
        try {
          appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
            `[${new Date().toISOString()}] KA_DISARM_CACHE_EXPIRED pid=${process.pid} cacheAgeSec=${Math.round(cacheAge / 1000)} cacheTtlSec=${Math.round(this.cacheTtlMs / 1000)} overSec=${Math.round((cacheAge - this.cacheTtlMs) / 1000)}\n`)
        } catch { /* logging best-effort */ }
        this.logClearDiag('cache_expired_during_sleep', { overSec: Math.round((cacheAge - this.cacheTtlMs) / 1000) })
        this.clearRegistry()
        this.onDisarmed('cache_expired_during_sleep')
        return
      }
    }

    // ── Layer 0c: cross-engine eviction-storm disarm ───────────────
    // A sibling engine detected a GENUINE server-side cold-write eviction (no
    // local cause) and tripped the SHARED breaker. The server is evicting
    // prefixes unpredictably right now: our snapshot's warmth is no longer
    // trustworthy (the prefix may already be gone here too), and firing would
    // just pay a full cold rewrite for an IDLE session the user may not return
    // to. DISARM — drop the stale snapshot and stop. KA re-arms cleanly when the
    // next REAL request proves the user is back and hands us a current snapshot,
    // so idle sessions re-warm lazily on return instead of stampeding into N
    // cold rewrites mid-storm. (Mirrors Layer 5's self-disarm of the detector.)
    if (this.evictionBreaker?.isTripped(Date.now())) {
      try {
        appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
          `[${new Date().toISOString()}] KA_DISARM_EVICTION_BREAKER pid=${process.pid} regSize=${this.registry.size} cooldownRemainingSec=${Math.round(this.evictionBreaker.cooldownRemainingMs(Date.now()) / 1000)} — sibling detected server-side eviction; disarming until next real request\n`)
      } catch { /* logging best-effort */ }
      this.clearRegistry()
      this.stop()
      try { this.config.onDisarmed?.({ reason: 'eviction_breaker_tripped', at: Date.now() }) } catch {}
      return
    }

    // Live-reload config from SSOT (~/.claude/keepalive.json via keepalive-config.ts).
    // Cheap: mtime cache inside loadKeepaliveConfig(). Reflects intervalSec /
    // idleTimeoutSec / cacheTtlSec changes without restart.
    const liveConfig = loadKeepaliveConfig()
    if (!liveConfig.enabled) {
      this.logClearDiag('config_disabled', { liveConfigEnabled: liveConfig.enabled })
      this.clearRegistry()
      this.stop()
      return
    }

    // ── Critical: cache TTL live-reload ─────────────────────────────
    // Without this, long-lived pids that started before the SSOT update
    // keep using the construction-time TTL. Symptom (observed 2026-04-30):
    // `cache_expired_during_sleep` disarms every 5min despite SSOT now
    // declaring 3600s, because `this.cacheTtlMs` was `readonly` and frozen.
    //
    // Override exception: when the consumer pinned cacheTtlMs at construction
    // (proxy-mode forcing 5min for native CC), SSOT's value reflects a DIFFERENT
    // consumer's contract (opencode's 1h) — honoring it here is exactly the bug
    // that burned 906K tokens in the 2026-05-17 SDK-0.15 incident. Skip.
    //
    // Observed-lock exception: wire-autoscan has locked us down to a shorter
    // TTL than SSOT (proxy saw 5min `cache_control` markers in real traffic).
    // Don't let SSOT raise it back — once we've seen a short-TTL block, we
    // must keep firing on that cadence until the session ends, even if newer
    // requests carry only long-TTL markers (the short block may still be alive
    // on Anthropic side). Reset only happens on engine reconstruction.
    if (!this.cacheTtlOverridden && !this.cacheTtlObservedLocked
        && liveConfig.cacheTtlMs !== this.cacheTtlMs) {
      const oldTtl = this.cacheTtlMs
      this.cacheTtlMs = liveConfig.cacheTtlMs
      // Visible audit trail — operators tail claude-max-debug.log to see
      // long-lived pids picking up SSOT changes mid-flight without restart.
      // Critical for verifying that the live-reload mechanism actually
      // works (was previously silent on the readonly field — bug visible
      // only via observed disarm pattern).
      try {
        appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
          `[${new Date().toISOString()}] CACHE_TTL_RELOADED pid=${process.pid} oldMs=${oldTtl} newMs=${liveConfig.cacheTtlMs} oldMin=${Math.round(oldTtl / 60000)} newMin=${Math.round(liveConfig.cacheTtlMs / 60000)}\n`)
      } catch { /* logging best-effort */ }
    }
    if (liveConfig.safetyMarginMs !== this.safetyMarginMs) {
      const oldMargin = this.safetyMarginMs
      this.safetyMarginMs = liveConfig.safetyMarginMs
      try {
        appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
          `[${new Date().toISOString()}] SAFETY_MARGIN_RELOADED pid=${process.pid} oldMs=${oldMargin} newMs=${liveConfig.safetyMarginMs}\n`)
      } catch { /* logging best-effort */ }
    }

    // Only apply if values actually differ — keeps behavior identical when
    // file unchanged. Clamp to EFFECTIVE intervalClamp range — when our TTL
    // is locked (override or wire-observed) to a shorter value than SSOT,
    // SSOT's intervalClampMax reflects SSOT's longer TTL and would let the
    // KA interval exceed our actual cache lifetime. That's the exact wire
    // mismatch from the 2026-05-17 incident — fire after cache is long dead.
    const ttlLocked = this.cacheTtlOverridden || this.cacheTtlObservedLocked
    const effectiveClampMax = ttlLocked
      ? Math.max(liveConfig.intervalClampMin + 1, this.cacheTtlMs - this.safetyMarginMs - 60_000)
      : liveConfig.intervalClampMax
    // When SSOT intervalMs is too large for our effective TTL (e.g. SSOT=1800s
    // but TTL=300s), use TTL/2 as the default instead of accepting SSOT.intervalMs.
    const effectiveTargetInterval = ttlLocked
      ? Math.min(liveConfig.intervalMs, Math.max(liveConfig.intervalClampMin, Math.floor(this.cacheTtlMs / 2)))
      : liveConfig.intervalMs
    const newInterval = Math.max(liveConfig.intervalClampMin,
      Math.min(effectiveTargetInterval, effectiveClampMax))
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
      this.logClearDiag('idle_timeout', { realIdleMs: realIdle, idleTimeoutMs: this.config.idleTimeoutMs })
      this.clearRegistry()
      this.stop()
      return
    }

    // Pick heaviest model from registry — but Layer 3: only consider entries
    // that have at least one cache_control marker. Entries without markers
    // would burn input tokens on a fire that refreshes nothing on Anthropic's
    // side (no cached blocks exist).
    let best: RegistryEntry | null = null
    let skippedNoCacheControl = 0
    for (const entry of this.registry.values()) {
      if (!entry.hasCacheControl) { skippedNoCacheControl++; continue }
      if (!best) { best = entry; continue }
      // Prefer a confirmed `main` lineage over an `unknown` candidate; within
      // the same role tier, the heaviest context wins.
      const entryMain = entry.role === 'main'
      const bestMain = best.role === 'main'
      if (entryMain && !bestMain) { best = entry; continue }
      if (entryMain === bestMain && entry.inputTokens > best.inputTokens) best = entry
    }
    if (!best) {
      if (skippedNoCacheControl > 0) {
        // Layer 3 audit — visible reason we didn't fire. Operator sees "engine
        // had snapshots but none had cache_control" instead of silent no-op.
        try {
          appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
            `[${new Date().toISOString()}] KA_FIRE_SKIPPED pid=${process.pid} reason=no_cache_control_in_any_snapshot skippedEntries=${skippedNoCacheControl}\n`)
        } catch { /* logging best-effort */ }
      }
      return
    }

    // PER-LINEAGE idle: time since the lineage we are about to keep alive
    // (`best`) was last warmed — NOT the global `lastActivityAt`. The global
    // clock is reset by EVERY real request of EVERY lineage, so busy
    // sub-agent traffic masked the main agent's idleness and the fire below
    // never triggered. The per-lineage clock sees the main agent go idle.
    const bestStat = this.lineageStats.get(best.lineageKey)
    const idle = Date.now() - (bestStat ? bestStat.lastWarmedAt : this.lastActivityAt)

    // Jitter: prevents multi-session burst. Sentinel -1 = uninitialized; seed
    // a random offset on first eligible tick. Explicit 0 means "no jitter" and
    // is honored (tests rely on this to make fire-threshold deterministic).
    if (this.jitterMs < 0) {
      this.jitterMs = Math.floor(Math.random() * 30_000)
    }
    // Always emit onTick — gives provider/consumer a chance to log per-tick
    // visibility. The "should we fire now?" decision is made AFTER this hook.
    this.config.onTick?.({
      idleMs: idle,
      nextFireMs: Math.max(0, this.config.intervalMs - idle),
      model: best.model,
      tokens: best.inputTokens,
    })

    if (idle < this.config.intervalMs * 0.9 + this.jitterMs) {
      // Not yet time to fire — return after onTick so consumers see the tick.
      return
    }

    // Fire keepalive for heaviest model
    this.inFlight = true
    this.inFlightLineageKey = best.lineageKey

    try {
      const body = JSON.parse(JSON.stringify(best.body))
      const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
      body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1

      // While this lineage is org-switch-pending, replay the snapshot's OWN
      // (old-org) Authorization so the OLD cache stays warm until the user
      // decides. Otherwise rebuild auth from a fresh getToken() (refresh-safe).
      const headers = this.orgSwitchPending.has(best.lineageKey) && best.headers.Authorization
        ? { ...best.headers }
        : { ...best.headers, Authorization: `Bearer ${await this.getToken()}` }

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
      // A successful KA fire warmed THIS lineage — advance its per-lineage
      // idle clock so the next fire is spaced one interval out from here.
      const firedStat = this.lineageStats.get(best.lineageKey)
      if (firedStat) firedStat.lastWarmedAt = Date.now()

      const rl = this.getRateLimitInfo()
      this.config.onHeartbeat?.({
        usage,
        durationMs,
        idleMs: idle,
        model: best.model,
        lineageKey: best.lineageKey,
        rateLimit: {
          status: rl.status,
          claim: rl.claim,
          resetAt: rl.resetAt,
        },
      })

      // ── Layer 5: post-fire cache-eviction detection ───────────────────
      // If the response shows a large cache_creation paired with tiny
      // cache_read, the snapshot's cache was EVICTED on Anthropic's side
      // (typically because CC slid its cache_control marker forward in
      // subsequent real_requests, leaving our snapshot's hash stale).
      //
      // Continuing to fire on the stale snapshot would burn the same large
      // creation tokens every interval. Disarm immediately — the engine will
      // re-arm and re-snapshot when the next real_request_complete provides
      // a current snapshot matching live cache state.
      //
      // Empirical: 2026-05-18 cf04c946 incident showed identical 915K cw
      // fires 13 min apart, both with cr~46K. Without this guard, ~4M tokens
      // would burn per hour on the stale snapshot until next real_request.
      const cw = usage.cacheCreationInputTokens ?? 0
      const cr = usage.cacheReadInputTokens ?? 0
      const EVICTION_CW_THRESHOLD = 10_000
      const EVICTION_CR_RATIO_MAX = 0.1  // cache_read should be at least 10× cache_write for healthy refresh
      if (cw > EVICTION_CW_THRESHOLD && cr < cw * EVICTION_CR_RATIO_MAX) {
        try {
          appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
            `[${new Date().toISOString()}] KA_FIRE_EVICTION_DETECTED pid=${process.pid} cw=${cw} cr=${cr} ratio=${(cr/cw).toFixed(3)} — disarming to prevent cascade\n`)
        } catch { /* logging best-effort */ }
        // Trip the SHARED fleet breaker — but ONLY for a genuine server-side
        // eviction (cold write on a snapshot with NO local cause). A recent real
        // request (incl. a user-authorized [%cache-rewrite-ok%] rewrite) slides
        // the prefix locally and is the detecting session's own concern, not a
        // fleet signal; lastSeenAt is set by real requests only, so it is the
        // exact "did the user just move the prefix?" signal. Self-disarm above
        // still happens regardless; the breaker only governs OTHER sessions.
        try {
          const msSinceLastRealRequest = firedStat ? Date.now() - firedStat.lastSeenAt : Infinity
          if (isServerSideEviction({ cacheWrite: cw, cacheRead: cr, msSinceLastRealRequest, intervalMs: this.config.intervalMs })) {
            this.evictionBreaker?.trip(Date.now(), {
              lineageKey: best.lineageKey,
              cacheWrite: cw,
              cacheRead: cr,
            })
          }
        } catch { /* breaker is best-effort; never let it break a fire path */ }
        // Clear registry so we won't re-fire stale snapshot.
        this.clearRegistry()
        this.stop()
        // Notify consumer so they can log/alert
        try { this.config.onDisarmed?.({ reason: 'cache_evicted_post_fire', at: Date.now() }) } catch {}
        return
      }
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
        const status = (err as any)?.status
        if (status === 429) {
          // Quota-exhausted (NOT generic 5xx). retryChain with 30/60s backoff
          // is futile — quota doesn't return until resetAt (often minutes-hours
          // away). Use smart-pause: keep snapshot if cache will outlive the
          // wait, disarm if not. See handleQuotaRateLimit for the decision.
          this.handleQuotaRateLimit(best, err as any)
        } else {
          // 5xx / 503 / 529 / etc — Anthropic struggling, retry with backoff.
          this.retryChain(best)
        }
      } else if (category === 'auth') {
        // Token issue — disarm, token refresh is the consumer's responsibility
        // (they should refresh via credentialStore on 401). Engine will resume
        // on next real request with fresh creds.
        this.logClearDiag('auth_error', { category, errStatus: (err as any)?.status })
        this.clearRegistry()
        this.onDisarmed('auth_error')
      } else {
        // Permanent (400, malformed request, etc). Don't retry.
        this.logClearDiag('permanent_error', { category, errStatus: (err as any)?.status, errMessage: (err as any)?.message?.slice(0, 200) })
        this.clearRegistry()
        this.onDisarmed('permanent_error')
      }
    } finally {
      this.inFlight = false
      this.abortController = null
      this.inFlightLineageKey = null
    }
  }

  /**
   * Diagnostic logger — call BEFORE registry.clear() to capture exact
   * state at the moment of disarm. Enables post-mortem analysis without
   * needing to reproduce the incident.
   *
   * Writes to claude-max-debug.log with grep-friendly tag KA_CLEAR_DIAG.
   * Includes every variable that gates a clear() decision.
   */
  private logClearDiag(reason: string, extra?: Record<string, unknown>): void {
    try {
      const cacheAge = this.cacheWrittenAt > 0 ? Date.now() - this.cacheWrittenAt : -1
      const ttlRemaining = this.cacheTtlMs - cacheAge
      const idleMs = Date.now() - this.lastActivityAt
      const realIdleMs = Date.now() - this.lastRealActivityAt
      const fields = {
        reason,
        cacheAgeMs: cacheAge,
        cacheTtlMs: this.cacheTtlMs,
        ttlRemainingMs: ttlRemaining,
        safetyMarginMs: this.safetyMarginMs,
        idleMs,
        realIdleMs,
        regSize: this.registry.size,
        inFlight: this.inFlight,
        cacheWrittenAt: this.cacheWrittenAt,
        lastActivityAt: this.lastActivityAt,
        lastRealActivityAt: this.lastRealActivityAt,
        ...extra,
      }
      const line = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(' ')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] KA_CLEAR_DIAG pid=${process.pid} ${line}\n`)
    } catch { /* logging best-effort */ }
  }

  /**
   * Smart quota-exhaustion handler — invoked when upstream returns 429.
   *
   * The classic retryChain (with 30/60s backoff) is wrong for 429: quota
   * doesn't return until `resetAt` (often minutes to hours away). Retrying
   * before reset burns input tokens AND eats into the cache's remaining
   * TTL with zero chance of success.
   *
   * Decision (foundation: user's "fastest marker" rule):
   *
   *   cacheDiesAt = cacheWrittenAt + cacheTtlMs - safetyMargin
   *   resetAtMs   = err.resetAt × 1000  (Anthropic header is epoch seconds)
   *
   *   if cacheDiesAt >= resetAtMs:
   *     PAUSE — cache will outlive quota wait; replay after reset hits
   *     cache_read (cheap). Stop the tick timer, schedule wake at
   *     resetAt + jitter. Real request (notifyRealRequestStart) also wakes.
   *
   *   if cacheDiesAt < resetAtMs:
   *     DISARM — quota wait > cache lifetime; replay after reset would be
   *     a cold cache_write (~80K-500K tokens, see body-dump analysis).
   *     Better to drop and let the next real request prime a fresh snapshot.
   *
   *   if no resetAt available:
   *     Fall back to retryChain — preserves existing behavior so any future
   *     server-side regression doesn't make things strictly worse.
   */
  private handleQuotaRateLimit(
    entry: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number; lineageKey: string },
    err: { resetAt?: number | null; retryAfterSec?: number | null },
  ): void {
    const now = Date.now()

    // Resolve resetAtMs from either anthropic-ratelimit-unified-reset (epoch sec)
    // or the standard `retry-after` header (delta-seconds from now).
    let resetAtMs: number | null = null
    if (err.resetAt && err.resetAt > 0) {
      resetAtMs = err.resetAt * 1000
    } else if (err.retryAfterSec && err.retryAfterSec > 0) {
      resetAtMs = now + err.retryAfterSec * 1000
    }

    if (resetAtMs === null) {
      // No reset hint from upstream — fall back to retry-chain (existing
      // behaviour). 429 with no headers should be rare; if it becomes common
      // we'll see retry_exhausted disarms in the wild and revisit.
      this.logClearDiag('quota_429_no_reset_hint', {
        retryAfterSec: err.retryAfterSec ?? null,
        resetAt: err.resetAt ?? null,
      })
      this.retryChain(entry)
      return
    }

    const cacheDiesAt = this.cacheWrittenAt + this.cacheTtlMs - this.safetyMarginMs
    const waitMs = resetAtMs - now

    if (cacheDiesAt < resetAtMs) {
      // Cache won't survive — disarm now, save the cold cache_write that would
      // happen on next fire after reset.
      this.logClearDiag('quota_outlives_cache', {
        cacheDiesInMs: cacheDiesAt - now,
        quotaResetsInMs: waitMs,
        gapMs: resetAtMs - cacheDiesAt,
        cacheTtlMs: this.cacheTtlMs,
      })
      this.clearRegistry()
      this.onDisarmed('quota_outlives_cache')
      return
    }

    // PAUSE — stop tick timer + abort in-flight, schedule wake at resetAt+jitter.
    // Jitter: 0-30s to avoid thundering herd across N parallel sessions all
    // waking at the same resetAt.
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null }
    this.abortController?.abort()
    this.inFlight = false

    const jitterMs = Math.floor(Math.random() * 30_000)
    const wakeMs = waitMs + jitterMs
    this.quotaPauseUntil = resetAtMs + jitterMs

    this.logClearDiag('quota_paused', {
      cacheDiesInMs: cacheDiesAt - now,
      quotaResetsInMs: waitMs,
      wakeInMs: wakeMs,
      jitterMs,
      regSize: this.registry.size,
    })

    this.quotaPauseTimer = setTimeout(() => {
      this.quotaPauseTimer = null
      this.quotaPauseUntil = null
      // Resume timer — next tick will evaluate normally (cache might be near
      // TTL by now → tick's existing 'cache_expired_during_sleep' branch will
      // disarm cleanly if so; otherwise next idle threshold triggers a fire
      // and a successful 200 confirms quota is back).
      this.logClearDiag('quota_resumed_by_timer', {
        cacheAgeMs: this.cacheWrittenAt > 0 ? Date.now() - this.cacheWrittenAt : -1,
      })
      this.startTimer()
    }, wakeMs)
    if (this.quotaPauseTimer && typeof this.quotaPauseTimer === 'object' && 'unref' in this.quotaPauseTimer) {
      (this.quotaPauseTimer as any).unref()
    }
  }

  /**
   * Wake from quota-pause early. Called from notifyRealRequestStart: if a real
   * user request arrived, upstream is reachable from the consumer side, so
   * either quota has recovered or the consumer will get a fresh 429 themselves
   * (and we'll re-enter pause on next KA attempt). Either way: clear the
   * pause and resume normal cadence.
   */
  private wakeFromQuotaPause(): void {
    if (!this.quotaPauseTimer && this.quotaPauseUntil === null) return
    if (this.quotaPauseTimer) {
      clearTimeout(this.quotaPauseTimer)
      this.quotaPauseTimer = null
    }
    const pausedUntil = this.quotaPauseUntil
    this.quotaPauseUntil = null
    this.logClearDiag('quota_resumed_by_real_request', {
      pauseRemainingMs: pausedUntil ? pausedUntil - Date.now() : -1,
    })
    this.startTimer()
  }

  /**
   * Dedicated retry chain for transient keepalive failures.
   * Uses setTimeout with exact delays from cacheWrittenAt — no drift.
   */
  private retryChain(
    entry: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number; lineageKey: string },
    attemptIndex = 0,
  ): void {
    if (attemptIndex >= this.retryDelaysMs.length) {
      this.logClearDiag('retry_exhausted', { attemptIndex, retryDelaysMsLen: this.retryDelaysMs.length })
      this.clearRegistry()
      this.onDisarmed('retry_exhausted')
      return
    }

    const cacheAge = Date.now() - this.cacheWrittenAt
    const ttlRemaining = this.cacheTtlMs - cacheAge
    const nextDelay = this.retryDelaysMs[attemptIndex]!

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
      const reason = cacheAge < this.cacheTtlMs / 2
        ? 'retry_budget_exceeds_ttl'  // server failures consumed too much of the window
        : 'cache_ttl_exhausted'        // genuine TTL boundary hit
      // DIAGNOSTIC: capture the EXACT comparison values that triggered this.
      // If reason='retry_budget_exceeds_ttl' fires when ttlRemaining is
      // genuinely large (incident 2026-05-06T23:01:50 had cacheAgeSec=1694
      // ttlSec=3600 yet trigger fired), this log will show whether
      // cacheTtlMs, safetyMarginMs, nextDelay, or cacheWrittenAt held
      // unexpected values at the trigger moment.
      this.logClearDiag(reason, {
        cmpLeft: ttlRemaining,
        cmpRight: nextDelay + this.safetyMarginMs,
        nextDelayMs: nextDelay,
        attemptIndex,
        retryDelaysMsRaw: JSON.stringify(this.retryDelaysMs),
      })
      this.clearRegistry()
      this.onDisarmed(reason)
      return
    }

    this.retryTimer = setTimeout(async () => {
      this.retryTimer = null

      // JIT owner-alive check before retry — consumer PID may have died
      // between scheduled retry and fire time.
      try {
        if (!this.isOwnerAlive()) {
          this.logClearDiag('owner_dead', { ownerCheck: 'retry' })
          this.clearRegistry()
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
        this.logClearDiag('cache_ttl_expired_mid_retry', { ageNowMs: ageNow })
        this.clearRegistry()
        this.onDisarmed('cache_ttl_expired_mid_retry')
        return
      }

      this.inFlight = true
      try {
        const body = JSON.parse(JSON.stringify(entry.body))
        const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
        body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1
        const headers = this.orgSwitchPending.has(entry.lineageKey) && entry.headers.Authorization
          ? { ...entry.headers }
          : { ...entry.headers, Authorization: `Bearer ${await this.getToken()}` }

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
          const status = (err as any)?.status
          if (status === 429) {
            // 429 arriving mid-retry-chain: same smart-pause as in tick().
            // Don't keep retrying — wait for resetAt or disarm if cache won't survive.
            this.handleQuotaRateLimit(entry, err as any)
            return
          }
          this.retryChain(entry, attemptIndex + 1)
          return
        } else {
          this.logClearDiag('permanent_error_mid_retry', {
            category,
            attemptIndex,
            errStatus: (err as any)?.status,
            errMessage: (err as any)?.message?.slice(0, 200),
          })
          this.clearRegistry()
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
          const sock = connect({ host: ANTHROPIC_API_HOST, port: 443 })
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
        void this.tick().catch((e) => this.logAsyncReject('tick@network-recovered', e))
      }
      // If cache is dead or registry empty — do nothing. Engine stays in
      // post-disarm state, waiting for next real request from user which
      // will prime a new snapshot.
    }

    // First probe runs immediately (fastest reaction to network blip).
    void probe().catch((e) => this.logAsyncReject('health-probe', e))
  }

  private stopHealthProbe(): void {
    if (this.healthProbeTimer) {
      clearTimeout(this.healthProbeTimer)
      this.healthProbeTimer = null
    }
    this.healthProbeAttempt = 0
  }

  /**
   * Sink for fire-and-forget async rejections. A `void this.tick()` /
   * `void probe()` that rejects (e.g. a transient null-deref or upstream
   * throw during network recovery) would otherwise surface as a global
   * `unhandledRejection` with no stack and no context. Route it here so it
   * is contained + diagnosable instead of polluting the process-level handler.
   */
  private logAsyncReject(tag: string, e: unknown): void {
    try {
      const err = e as { message?: string; stack?: string } | null
      const msg = err?.message ?? String(e)
      const stack = (err?.stack ?? '').split('\n').slice(0, 4).join(' | ')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] KA_ASYNC_REJECT pid=${process.pid} tag=${tag} msg=${msg} stack=${stack}\n`)
    } catch { /* logging best-effort */ }
  }

  // ────────────────────────────────────────────────────────────
  // Debug snapshot writer
  // ────────────────────────────────────────────────────────────

  private writeSnapshotDebug(model: string, body: Record<string, unknown>, usage: TokenUsage): void {
    try {
      const snapshotDir = join(homedir(), '.claude', 'snapshots')
      mkdirSync(snapshotDir, { recursive: true })

      // Rotate: delete files older than configured TTL. MUST recurse into the
      // `bodies/` subdir — a non-recursive sweep left full-body dumps there
      // unpruned (they accumulated to hundreds of MB while the top-level meta
      // files rotated correctly). Recurse: prune old files at every level,
      // never unlink the directories themselves.
      try {
        const cutoff = Date.now() - KeepaliveEngine.SNAPSHOT_TTL_MS
        const sweep = (dir: string): void => {
          for (const f of readdirSync(dir)) {
            const fpath = join(dir, f)
            const st = statSync(fpath)
            if (st.isDirectory()) { sweep(fpath); continue }
            if (st.mtimeMs < cutoff) unlinkSync(fpath)
          }
        }
        sweep(snapshotDir)
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
  get _registry(): ReadonlyMap<string, RegistryEntry> {
    return this.registry
  }

  /** @internal — drive one tick directly (tests only). */
  async _tick(): Promise<void> {
    return this.tick()
  }

  /** @internal — per-lineage idle clocks (for tests). */
  get _lineageStats(): ReadonlyMap<string, { lastSeenAt: number; lastWarmedAt: number }> {
    return this.lineageStats
  }

  /** @internal — for test inspection */
  get _timer(): ReturnType<typeof setInterval> | null { return this.timer }

  /** @internal — for test inspection */
  get _config() { return this.config }

  /** @internal — for test inspection (per-consumer override audit) */
  get _cacheTtlMs(): number { return this.cacheTtlMs }
  get _cacheTtlOverridden(): boolean { return this.cacheTtlOverridden }
  get _cacheTtlObservedLocked(): boolean { return this.cacheTtlObservedLocked }

  /** @internal — for test inspection */
  get _lastKnownCacheTokensByModel(): ReadonlyMap<string, number> { return this.lastKnownCacheTokensByModel }

  /** @internal — mutable internal state getters/setters for test inspection */
  _setLastRealActivityAt(v: number): void { this.lastRealActivityAt = v }
  _setCacheWrittenAt(v: number): void { this.cacheWrittenAt = v }
  get _cacheWrittenAt(): number { return this.cacheWrittenAt }
  _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void {
    const key = lineageKey(body)
    this.pendingSnapshots.set(key, { model, body, headers, role: 'main' })
    this._legacyPendingLineage = key
  }

  /** @internal — for test inspection (smart-pause state) */
  get _quotaPauseTimer(): ReturnType<typeof setTimeout> | null { return this.quotaPauseTimer }
  get _quotaPauseUntil(): number | null { return this.quotaPauseUntil }

  /** @internal — for test invocation of the smart-pause handler */
  _testHandleQuotaRateLimit(
    entry: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number; lineageKey: string },
    err: { resetAt?: number | null; retryAfterSec?: number | null },
  ): void {
    this.handleQuotaRateLimit(entry, err)
  }

  /** Notify the consumer (best-effort) that the KA registry was mutated —
   *  used to trigger cross-restart persistence. Never throws. */
  private notifyRegistryChanged(): void {
    try { this.config.onRegistryChange?.() } catch { /* never break a fire/request */ }
  }

  /** Clear the registry + notify — the disarm/reload/evict mutation path. */
  private clearRegistry(): void {
    this.registry.clear()
    // A cleared registry has no snapshot to warm-old; drop any org-switch window
    // (e.g. the old token 401'd → auth-disarm cleared the registry here).
    this.orgSwitchPending.clear()
    // Every clear defaults to non-self-heal-eligible (terminal). reload() opts
    // back IN afterwards — it is the only re-primeable clear.
    this.selfHealEligible = false
    this.notifyRegistryChanged()
  }

  /**
   * Self-heal: re-prime the registry from the last-known snapshots when a LIVE
   * idle session's snapshot was dropped by a re-primeable clear (reload). Gated
   * so a dead (PID gone) or expired (cache past TTL) session is never
   * resurrected. Returns true if it re-primed. Called from tick() when the
   * registry is empty.
   */
  private trySelfHeal(): boolean {
    if (!this.selfHealEligible || this.lastSnapshots.size === 0) return false
    try { if (!this.isOwnerAlive()) return false } catch { /* assume alive */ }
    if (this.cacheWrittenAt <= 0) return false
    const cacheAge = Date.now() - this.cacheWrittenAt
    if (cacheAge >= this.cacheTtlMs - this.safetyMarginMs) return false // cache too old to keep alive
    for (const [k, entry] of this.lastSnapshots) this.registry.set(k, entry)
    this.notifyRegistryChanged()
    try {
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] KA_SELF_HEAL pid=${process.pid} reprimed=${this.lastSnapshots.size} cacheAgeSec=${Math.round(cacheAge / 1000)} — live idle session re-warmed without a real request\n`)
    } catch { /* logging best-effort */ }
    return true
  }

  /**
   * Reconstruct armed state from a persisted snapshot (ka-snapshot-store.ts).
   * Called ONCE on a fresh engine, before any real request: repopulates the
   * registry + timing scalars and starts the tick, leaving the engine
   * indistinguishable from one armed by a real request. From the first tick
   * onward every existing layer (owner-alive gate, wake-from-sleep TTL
   * recheck, network/429 handling) runs unmodified. Never throws.
   *
   * The caller (ProxyClient) is responsible for having decided, via
   * `assessRevival`, that this snapshot's cache is still warm enough — revive()
   * trusts that decision and does not re-check liveness here.
   */
  revive(state: PersistedEngineState): void {
    try {
      // Fresh-engine guard — never revive over a live/armed engine.
      if (this.registry.size > 0 || this.timer) return
      if (!state || !Array.isArray(state.registry) || state.registry.length === 0) return

      this.cacheWrittenAt = state.cacheWrittenAt
      // Seed BOTH activity clocks to the warm-up time: a revived engine whose
      // cache is already aging then fires its first KA promptly (idle is
      // measured from cacheWrittenAt) instead of waiting a full interval.
      this.lastActivityAt = state.cacheWrittenAt
      this.lastRealActivityAt = state.cacheWrittenAt
      this.lastObservedTtlMs = state.lastObservedTtlMs ?? null
      this.ttlEverObserved = !!state.ttlEverObserved
      // Keep the (already wire-downlocked) TTL — never let SSOT raise a TTL the
      // wire proved shorter. Take the stricter of the two; over-fire is safe.
      if (Number.isFinite(state.cacheTtlMs) && state.cacheTtlMs > 0) {
        this.cacheTtlMs = Math.min(this.cacheTtlMs, state.cacheTtlMs)
      }
      if (state.cacheTtlObservedLocked) this.cacheTtlObservedLocked = true
      this.lastKnownCacheTokensByModel = new Map(
        Object.entries(state.lastKnownCacheTokensByModel ?? {}),
      )
      for (const e of state.registry) {
        if (!e || typeof e.lineageKey !== 'string') continue
        this.registry.set(e.lineageKey, {
          body: JSON.parse(JSON.stringify(e.body)),
          headers: { ...e.headers },
          model: e.model,
          lineageKey: e.lineageKey,
          role: e.role as AgentRole,
          inputTokens: e.inputTokens,
          hasCacheControl: e.hasCacheControl,
        })
      }
      if (this.registry.size > 0) {
        this.notifyRegistryChanged()
        this.startTimer()
      }
    } catch {
      /* revive is best-effort — a failure just means no KA until a real request */
    }
  }

  /**
   * Serialise the armed state for cross-restart persistence (see
   * ka-snapshot-store.ts). Returns `null` when the engine holds no snapshot
   * worth persisting (registry empty — disarmed or never armed). Never throws.
   */
  serializeState(): PersistedEngineState | null {
    try {
      if (this.registry.size === 0) return null
      return {
        cacheWrittenAt: this.cacheWrittenAt,
        cacheTtlMs: this.cacheTtlMs,
        cacheTtlOverridden: this.cacheTtlOverridden,
        cacheTtlObservedLocked: this.cacheTtlObservedLocked,
        lastObservedTtlMs: this.lastObservedTtlMs,
        ttlEverObserved: this.ttlEverObserved,
        lastKnownCacheTokensByModel: Object.fromEntries(this.lastKnownCacheTokensByModel),
        registry: Array.from(this.registry.values()).map((e) => ({
          body: e.body,
          headers: e.headers,
          model: e.model,
          lineageKey: e.lineageKey,
          role: e.role,
          inputTokens: e.inputTokens,
          hasCacheControl: e.hasCacheControl,
        })),
      }
    } catch {
      return null
    }
  }
}
