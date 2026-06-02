/**
 * ProxyClient — the CORE orchestrator for subscription-based Anthropic proxying.
 *
 * ──────────────────────────────────────────────────────────────
 *  RESPONSIBILITIES
 * ──────────────────────────────────────────────────────────────
 *
 *  Given a consumer's HTTP request to /v1/messages (body + headers + session
 *  context), ProxyClient:
 *    1. Tracks per-session state (via ISessionStore port)
 *    2. Obtains fresh OAuth token (via ICredentialsProvider port)
 *    3. Rewrites headers (strip consumer auth, inject OAuth bearer, oauth beta)
 *    4. Notifies KeepaliveEngine so it knows there's a real request
 *    5. Forwards to api.anthropic.com (via IUpstreamFetcher port)
 *    6. Tees the SSE stream: one copy back to consumer, one parsed for usage
 *    7. Feeds usage back to engine which schedules keepalive fires
 *    8. Handles network-level errors with standards-compliant 503 response
 *
 *  What it does NOT do:
 *    - Listen on any port (that's the HTTP server's job — consumers wrap us)
 *    - Write logs directly (goes through IEventEmitter port)
 *    - Persist session state (goes through ISessionStore port)
 *    - Refresh OAuth tokens (ICredentialsProvider owns that)
 *
 *  ──────────────────────────────────────────────────────────────
 *  USAGE
 *  ──────────────────────────────────────────────────────────────
 *
 *  Zero-config (defaults):
 *    const client = new ProxyClient({
 *      config: { kaIntervalSec: 120, credentialsPath: '~/.claude/.credentials.json' },
 *      credentialsProvider: new FileCredentialsProvider(),
 *    })
 *
 *  HTTP proxy:
 *    Bun.serve({
 *      async fetch(req) {
 *        return client.handleRequest(
 *          await req.arrayBuffer(),
 *          headersToObject(req.headers),
 *          { sessionId: req.headers.get('x-claude-code-session-id') ?? randomId() }
 *        )
 *      }
 *    })
 *
 *  In-process (opencode-plugin):
 *    return {
 *      auth: {
 *        loader: () => ({
 *          fetch: (req, init) => client.handleRequest(init.body, headersFromInit(init), {
 *            sessionId: crypto.randomUUID(),
 *          }),
 *        }),
 *      },
 *    }
 */

import { KeepaliveEngine, detectCacheTtlFromBody, upgradeCacheControlTtl } from './keepalive-engine.js'
import { EvictionCircuitBreaker } from './eviction-breaker.js'
import { CacheMetricsCollector } from './cache-metrics.js'
import type {
  ICredentialsProvider,
  IEventEmitter,
  ILivenessChecker,
  ISessionStore,
  IUpstreamFetcher,
  Session,
} from './proxy-ports.js'
import {
  ConsoleEventEmitter,
  DefaultLivenessChecker,
  InMemorySessionStore,
  NativeFetchUpstream,
} from './proxy-adapters.js'
import type { StreamEvent, TokenUsage } from './types.js'
import { ANTHROPIC_API_BASE } from './anthropic-endpoints.js'
import { prefixHashes, classifyRewrite, lineageKey, type PrefixHashes } from './lineage.js'
import { loadKeepaliveConfig } from './keepalive-config.js'
import { FileOrgIdResolver, type OrgIdResolver } from './org-identity.js'
import {
  writeRewriteBlockDump,
  DEFAULT_REWRITE_DUMP_DIR,
  type CachePrefix,
} from './rewrite-dump.js'
import {
  loadKaSnapshots,
  saveKaSnapshots,
  assessRevival,
  DEFAULT_KA_SNAPSHOT_PATH,
  KA_SNAPSHOT_MAX_AGE_MS,
  type PersistedSession,
} from './ka-snapshot-store.js'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  HEADER_AUTHORIZATION,
  HEADER_ANTHROPIC_BETA,
  HEADER_CONTENT_TYPE,
  CONTENT_TYPE_JSON,
} from './anthropic-headers.js'

// ═══ Config ═══════════════════════════════════════════════════════

export interface ProxyClientConfig {
  /** Anthropic API base URL. Default: https://api.anthropic.com */
  anthropicBaseUrl?: string

  /**
   * Per-consumer cache TTL pin in SECONDS — the engine's INITIAL cache-lifetime
   * belief. The wire autoscan (detectCacheTtlFromBody in notifyRealRequestStart)
   * monotonically locks it DOWN if it ever observes a shorter cache_control
   * marker, so this value is a ceiling, not an unconditional override.
   *
   * Default: 3600 (1 h). `handleRequest` upgrades native Claude Code's
   * `cache_control:{type:'ephemeral'}` markers to `ttl:'1h'` before forwarding
   * (gated on the prompt-caching-scope beta), so the cache genuinely lives 1 h
   * on Anthropic's side — 3600 is the true wire TTL, not an assumption.
   *
   * The 2026-05-17 SDK-0.15 incident (906K cache_creation tokens wasted) was a
   * wire/model MISMATCH: the engine believed 1 h while the wire was still 5 m,
   * so KA fired every 30 min into caches dead for 25. That cannot recur here:
   * the proxy now CONTROLS the wire to 1 h, and the autoscan downlock still
   * catches any request that slips through un-upgraded (no beta → wire 5 m →
   * engine downlocks that session to 300 s).
   */
  kaCacheTtlSec?: number

  /**
   * Keepalive interval in seconds. Engine clamps to [intervalClampMin, intervalClampMax]
   * derived from the active cacheTtlMs (read from ~/.claude/keepalive.json SSOT,
   * or from kaCacheTtlSec when overridden).
   *
   * If undefined, engine uses SSOT.intervalMs (auto-scales: ~5m TTL → 150s, ~1h TTL → 1800s).
   * Explicit value overrides SSOT.
   */
  kaIntervalSec?: number

  /**
   * Idle timeout in seconds — how long without real requests before engine
   * disarms. 0 = never. Default: 0 (never, kept warm until PID dies).
   */
  kaIdleTimeoutSec?: number

  /** Minimum tokens for a snapshot to be eligible for KA. Default: 2000 */
  kaMinTokens?: number

  /** Rewrite-burst guard warn threshold (idle sec). Default: 300 */
  kaRewriteWarnIdleSec?: number

  /** Rewrite-burst guard warn token threshold. Default: 50000 */
  kaRewriteWarnTokens?: number

  /** Rewrite-burst guard block threshold (idle sec). 0 = never. Default: 0 */
  kaRewriteBlockIdleSec?: number

  /** Enable rewrite-burst hard block. Default: false (warn only) */
  kaRewriteBlockEnabled?: boolean

  /**
   * Cross-engine eviction-storm window, in seconds. When one session's KA fire
   * detects a GENUINE server-side cold-write eviction (cold write with no local
   * cause) it trips a SHARED breaker; for this many seconds every other engine,
   * at its next fire, DISARMS (drops its stale snapshot and stops) rather than
   * pay its own cold rewrite into the same storm. Disarmed sessions re-arm
   * cleanly on their next real request. Collapses an N-session cold-rewrite
   * cascade (observed 2026-05-28: ~6M tokens across ~8 sessions in 25 min) into
   * a single rewrite plus lazy re-warm on return. A few minutes is enough for
   * every armed engine to hit at least one tick. 0 disables the breaker.
   * Default: 300 (5 min).
   */
  kaEvictionHoldSec?: number

  /**
   * Trips required within the hold window before the breaker engages. 1 = a
   * single detected eviction holds the fleet (matches "one burns → others back
   * off"). 2+ requires corroboration, avoiding a hold on a lone per-session
   * marker-slide. Default: 1.
   */
  kaEvictionMinTrips?: number
}

// Note: kaIntervalSec intentionally NOT defaulted here.
// When undefined, KeepaliveEngine reads its default from
// ~/.claude/keepalive.json (SSOT) which auto-scales with cacheTtlMs.
//
// kaCacheTtlSec DEFAULTS to 3600 (1h): handleRequest upgrades native Claude
// Code's cache_control markers to ttl:'1h' before forwarding, so the wire TTL
// genuinely IS 1h. The autoscan downlock (notifyRealRequestStart) still pins a
// session to 5m if it ever observes an un-upgraded marker — so this default is
// a safe ceiling, not the 2026-05-17 wire-TTL mismatch. See ProxyClientConfig.
const DEFAULT_CONFIG: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & {
  kaIntervalSec: number | undefined
} = {
  anthropicBaseUrl: ANTHROPIC_API_BASE,
  kaCacheTtlSec: 3600,
  kaIntervalSec: undefined,
  kaIdleTimeoutSec: 0,
  kaMinTokens: 2000,
  kaRewriteWarnIdleSec: 300,
  kaRewriteWarnTokens: 50000,
  kaRewriteBlockIdleSec: 0,
  kaRewriteBlockEnabled: false,
  kaEvictionHoldSec: 300,
  kaEvictionMinTrips: 1,
}

export interface ProxyClientOptions {
  /** Config tuning — all fields optional (sensible defaults) */
  config?: ProxyClientConfig

  /** REQUIRED: how to get OAuth tokens */
  credentialsProvider: ICredentialsProvider

  /** Optional: where to emit events. Default: ConsoleEventEmitter (stderr) */
  eventEmitter?: IEventEmitter

  /** Optional: where to store sessions. Default: InMemorySessionStore */
  sessionStore?: ISessionStore<KeepaliveEngine>

  /** Optional: how to talk to upstream. Default: native fetch */
  upstreamFetcher?: IUpstreamFetcher

  /** Optional: how to check PID liveness. Default: POSIX kill -0 */
  livenessChecker?: ILivenessChecker

  /**
   * Optional: how to resolve the current Anthropic org UUID — used by the
   * rewrite guard to detect a cross-org cache replay (`anomalous:org-switch`).
   * Default: FileOrgIdResolver reading `~/.claude.json`.
   */
  orgIdResolver?: OrgIdResolver

  /**
   * Optional: where to persist the cache-prefix history (so the miss
   * predictor + rewrite guard survive a proxy restart). Default:
   * `~/.claude-local/proxy-prefix-history.json`. Injectable for test
   * isolation — production never sets it.
   */
  prefixHistoryPath?: string

  /**
   * Optional: directory for rewrite-guard block dumps (the rejected request
   * + prefix diff, written on every block for offline analysis). Default:
   * `~/.claude-local/rewrite-guard-blocks/`. Injectable for test isolation.
   */
  rewriteBlockDumpDir?: string

  /**
   * Optional: wall-clock time (ms) this proxy process started. Default:
   * `Date.now()` at construction. Used to recognise a TTL expiry that spans
   * a proxy restart (the KA engine could not have kept the cache warm across
   * a gap in which it did not exist) so the guard does not block it.
   * Injectable for tests.
   */
  proxyStartedAt?: number

  /**
   * Optional: where to persist the KA snapshot registry so KA survives a
   * proxy restart (idle sessions keep their cache warm across a deploy).
   * Default: `~/.claude-local/proxy-ka-snapshots.json`. Injectable for tests.
   */
  kaSnapshotPath?: string
}

/** One persisted cache-prefix fingerprint, keyed by `${sessionId}:${lineageKey}`. */
interface PrefixHistoryEntry {
  hashes: PrefixHashes
  /** Timestamp of the last REAL request for this lineage. */
  lastReqAt: number
  /** Org UUID under which this prefix was last cached — `null` when unknown.
   *  Absent in entries written before org-awareness; loaded as `null`. */
  orgId: string | null
  /** Timestamp of the last KA fire that warmed this lineage's cache. A KA
   *  fire refreshes the Anthropic-side prefix TTL just like a real request —
   *  so the cache-miss predictor must treat it as a cache touch. Without
   *  this, a user who idles past TTL while KA keeps the cache warm gets a
   *  FALSE `avoidable:ttl-expiry` (the predictor saw only real-request idle)
   *  and the rewrite guard blocks a request whose cache is actually hot. */
  lastKaAt?: number
}

// ═══ Request context (per handleRequest call) ══════════════════════

export interface HandleRequestContext {
  /** Unique identifier for the logical session. */
  sessionId: string

  /** OS PID of the consumer process (for JIT liveness check). */
  sourcePid?: number | null

  /** Abort signal for the upstream fetch. */
  signal?: AbortSignal

  /**
   * Whether this request comes from an INTERACTIVE human (native Claude Code),
   * as opposed to a programmatic endpoint client (OpenAI-compat /v1/chat/
   * completions, or an external Anthropic-API consumer). The rewrite guard is a
   * human consent checkpoint — when `rewriteGuard.interactiveOnly` is true
   * (default), guard blocking applies ONLY to interactive requests; programmatic
   * clients (interactive=false) are let through (logged) since they cannot
   * re-send with an override marker. Default true (preserves native-CC behavior).
   */
  interactive?: boolean
}

// ═══ Rate limit snapshot (exposed for introspection) ═══════════════

export interface RateLimitSnapshot {
  status: string | null
  resetAt: number | null
  claim: string | null
  retryAfter: number | null
  utilization5h: number | null
  utilization7d: number | null
}

// ═══ ProxyClient ═══════════════════════════════════════════════════

/**
 * Per-session pinned account: the org + token a session is bound to. Captured at
 * bind time (first request, or a rebind via `[%reload-ok%]` / cli reload).
 * In-memory only — a proxy restart rebinds every session to the current account.
 * `expiresAt` is the pinned token's expiry (null = unknown ⇒ treat as alive,
 * the upstream-401 path is the stop condition).
 */
interface SessionPin {
  orgId: string | null
  token: string
  expiresAt: number | null
}

export class ProxyClient {
  private readonly config: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }
  private readonly metrics: CacheMetricsCollector
  private readonly credentials: ICredentialsProvider
  private readonly events: IEventEmitter
  private readonly store: ISessionStore<KeepaliveEngine>
  private readonly upstream: IUpstreamFetcher
  private readonly liveness: ILivenessChecker

  private readonly reaperTimer: ReturnType<typeof setInterval>
  private lastRateLimit: RateLimitSnapshot = {
    status: null, resetAt: null, claim: null, retryAfter: null,
    utilization5h: null, utilization7d: null,
  }

  /** Previous request's cacheable-prefix fingerprint per `${sessionId}:${lineageKey}`.
   *  Persisted to disk (loadPrefixHistory) so the cache-miss predictor + rewrite
   *  guard survive a proxy restart — otherwise the first request of every
   *  session post-restart looks like a cold-start and the guard is blind. */
  private readonly prefixHistory: Map<string, PrefixHistoryEntry>

  /** Where prefixHistory is persisted — configurable for test isolation. */
  private readonly prefixHistoryPath: string

  /** Directory for rewrite-guard block dumps. */
  private readonly rewriteBlockDumpDir: string

  /** Wall-clock ms this proxy process started — a cache warm-up older than
   *  this means the TTL gap spans a restart (KA could not have prevented it). */
  private readonly proxyStartedAt: number

  /** Last Claude Code version seen in a request's billing header — a change
   *  churns the cacheable prefix; tracked to emit CC_VERSION_CHANGED. */
  private lastCcVersion: string | null = null

  /** Where the KA snapshot registry is persisted (configurable for tests). */
  private readonly kaSnapshotPath: string

  /** Set when a KA registry mutated since the last persist — bounds writes
   *  to "only when something changed" (bodies are large; no blind 10s saves). */
  private kaSnapshotDirty = false

  /** Lineage keys (`${sessionId}:${lineageKey}`) whose persisted KA snapshot
   *  was DROPPED at startup (cache already dead). The next real request for
   *  such a lineage is a genuine rewrite the guard should surface — see
   *  predictCacheMiss / classifyRewrite's `kaRevivalDropped`. */
  private readonly kaReviveDropped: Set<string> = new Set()

  /** Last cacheable prefix (system + tools) seen per `${sessionId}:${lineageKey}`.
   *  In-memory only (never persisted — bodies are large) — feeds the prefix
   *  diff written into a guard-block dump. Reaped with prefixHistory. */
  private readonly lineagePrefix: Map<string, CachePrefix> = new Map()

  /** Per-session pinned account (org+token). Keyed by sessionId. In-memory only;
   *  reaped with the session. Drives forward token selection (hold cross-org /
   *  adopt same-org / rebind on marker+reload / 401 on cross-org expiry). */
  private readonly sessionPins: Map<string, SessionPin> = new Map()

  /** Resolves the current Anthropic org UUID — drives org-switch detection. */
  private readonly orgIdResolver: OrgIdResolver

  /** Shared across every per-session KA engine — fleet-wide eviction-storm hold. */
  private readonly evictionBreaker: EvictionCircuitBreaker

  constructor(opts: ProxyClientOptions) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.evictionBreaker = new EvictionCircuitBreaker({
      cooldownMs: this.config.kaEvictionHoldSec * 1000,
      minTripsToEngage: this.config.kaEvictionMinTrips,
    })
    this.credentials = opts.credentialsProvider
    this.events = opts.eventEmitter ?? new ConsoleEventEmitter()
    // Startup confirmation: the eviction breaker is otherwise silent until it
    // trips, so emit one line at boot so operators can verify the fleet-wide
    // cache-eviction guard is armed (and with what thresholds).
    this.events.emit({
      level: 'info',
      kind: 'EVICTION_BREAKER_ARMED',
      cooldownSec: this.config.kaEvictionHoldSec,
      minTrips: this.config.kaEvictionMinTrips,
      enabled: this.config.kaEvictionHoldSec > 0,
    })
    this.liveness = opts.livenessChecker ?? new DefaultLivenessChecker()
    this.store = opts.sessionStore ?? new InMemorySessionStore<KeepaliveEngine>(this.liveness)
    this.upstream = opts.upstreamFetcher ?? new NativeFetchUpstream()
    this.orgIdResolver = opts.orgIdResolver ?? new FileOrgIdResolver()
    this.prefixHistoryPath = opts.prefixHistoryPath ?? PREFIX_HISTORY_PATH
    this.rewriteBlockDumpDir = opts.rewriteBlockDumpDir ?? DEFAULT_REWRITE_DUMP_DIR
    this.proxyStartedAt = opts.proxyStartedAt ?? Date.now()
    this.kaSnapshotPath = opts.kaSnapshotPath ?? DEFAULT_KA_SNAPSHOT_PATH
    this.prefixHistory = loadPrefixHistory(this.prefixHistoryPath)

    // Cache metrics collector — emits CACHE_METRICS_SUMMARY every 60s and
    // CACHE_REGRESSION_DETECTED if hit_rate drops below threshold.
    this.metrics = new CacheMetricsCollector({
      windowMs: 60_000,
      reportIntervalMs: 60_000,
      onSummary: (summary) => this.events.emit({
        level: 'info',
        kind: 'CACHE_METRICS_SUMMARY',
        ...summary,
      }),
      onRegression: (info) => this.events.emit({
        level: 'error',
        kind: 'CACHE_REGRESSION_DETECTED',
        ...info,
      }),
    })

    // Periodic reaper — every 10s, remove sessions whose owner PID is dead.
    // Keeps state clean + stops KA engines for dead consumers.
    this.reaperTimer = setInterval(() => {
      const reaped = this.store.reapDead()
      for (const sid of reaped) {
        this.events.emit({ level: 'info', kind: 'SESSION_DEAD', sessionId: sid, reason: 'pid_gone' })
        // Drop this session's prefix-history (keys are `${sid}:${lineageKey}`).
        for (const k of this.prefixHistory.keys()) {
          if (k.startsWith(sid + ':')) this.prefixHistory.delete(k)
        }
        for (const k of this.lineagePrefix.keys()) {
          if (k.startsWith(sid + ':')) this.lineagePrefix.delete(k)
        }
        for (const k of this.kaReviveDropped) {
          if (k.startsWith(sid + ':')) this.kaReviveDropped.delete(k)
        }
        this.sessionPins.delete(sid)  // drop the per-session org/token pin
        this.kaSnapshotDirty = true   // a reaped session must leave the KA file
      }
      // Persist prefix history each reaper tick so it survives a proxy restart.
      savePrefixHistory(this.prefixHistory, this.prefixHistoryPath)
      // Persist the KA snapshot registry, but only when something changed —
      // snapshot bodies are large, so no unconditional 10s writes.
      if (this.kaSnapshotDirty) {
        this.persistKaSnapshots()
        this.kaSnapshotDirty = false
      }
    }, 10_000)
    if (this.reaperTimer && typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      (this.reaperTimer as any).unref()
    }

    // Revive KA engines for sessions whose cache is provably still warm —
    // last step of construction so every dependency above is ready.
    this.reviveKaSnapshots()
  }

  // ─── Public getters ─────────────────────────────────────────────

  /** Current rate-limit snapshot from last upstream response. */
  get rateLimitSnapshot(): Readonly<RateLimitSnapshot> { return this.lastRateLimit }

  /** List all tracked sessions (for stats endpoints). */
  listSessions(): Session<KeepaliveEngine>[] { return this.store.list() }

  /** Total session count. */
  sessionCount(): number { return this.store.size() }

  /** Mark a session as Worker-managed (heartbeat-based liveness instead of PID). */
  markManagedSession(sessionId: string, workerId: string, ttlMs?: number): boolean {
    return (this.store as any).markManaged?.(sessionId, workerId, ttlMs) ?? false
  }

  /** Worker heartbeat — refresh liveness for all Worker's sessions. */
  workerHeartbeat(workerId: string, activeSessionIds: string[]): number {
    return (this.store as any).workerHeartbeat?.(workerId, activeSessionIds) ?? 0
  }

  /** Unmark a session as Worker-managed. */
  unmarkManagedSession(sessionId: string): boolean {
    return (this.store as any).unmarkManaged?.(sessionId) ?? false
  }

  /** Config used by this client (read-only). */
  get configSnapshot(): Readonly<Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }> { return this.config }

  /** Snapshot of current rolling cache-metrics window. */
  get cacheMetricsSnapshot() { return this.metrics.summary() }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Clean shutdown — stops reaper, metrics collector, and all KA engines in store. */
  stop(): void {
    clearInterval(this.reaperTimer)
    savePrefixHistory(this.prefixHistory, this.prefixHistoryPath)
    // Final KA-snapshot persist — must run BEFORE store.stopAll() empties the
    // engines, so a clean shutdown leaves a current registry to revive from.
    this.persistKaSnapshots()
    this.metrics.stop()
    this.store.stopAll()
  }

  /**
   * Disarm one or all KA engines and invalidate cached credentials.
   *
   * Use case: user swapped Anthropic org via `claude login` and wants the
   * proxy to drop all stale snapshots before next request. Without this,
   * the next KA fire would replay the previous session's accumulated
   * snapshot against the NEW org — paying full cold-cache-write cost
   * (~80K-500K tokens, see body-dump analysis) on the wrong account.
   *
   * Pass sessionId to target a single session, omit to disarm all.
   * Returns the list of sessionIds that were disarmed.
   */
  disarmSessions(reason: string, sessionId?: string): string[] {
    const disarmed: string[] = []
    if (sessionId) {
      const s = this.store.list().find(x => x.sessionId === sessionId)
      if (s) {
        s.engine.disarm(reason)
        disarmed.push(s.sessionId)
      }
    } else {
      for (const s of this.store.list()) {
        s.engine.disarm(reason)
        disarmed.push(s.sessionId)
      }
    }
    // Always invalidate token cache too — caller may have just rotated
    // credentials (org swap is the canonical case for this method).
    this.credentials.invalidate()
    this.events.emit({
      level: 'info',
      kind: 'ADMIN_DISARM',
      reason,
      sessionIdRequested: sessionId ?? null,
      disarmedCount: disarmed.length,
      sessionIds: disarmed,
    })
    return disarmed
  }

  /**
   * Reload one or all KA engines: drop stale snapshots + invalidate the
   * credential cache, but — unlike disarmSessions — leave each engine's tick
   * timer running so it auto-resumes the moment the next real request
   * re-registers a snapshot.
   *
   * This is the correct primitive for org-swap (`claude login` to a new org):
   * the old org's cached prefix is useless against the new org, so it must be
   * dropped — but the KA must NOT die. The user keeps working, and the parked
   * main agent's cache must be re-warmed as soon as traffic resumes. The old
   * disarmSessions() killed the timer, so a single org-swap silently disabled
   * KA for the rest of the session.
   *
   * Pass sessionId to target one session, omit to reload all.
   */
  reloadSessions(reason: string, sessionId?: string): string[] {
    const reloaded: string[] = []
    if (sessionId) {
      const s = this.store.list().find(x => x.sessionId === sessionId)
      if (s) { s.engine.reload(reason); reloaded.push(s.sessionId) }
    } else {
      for (const s of this.store.list()) { s.engine.reload(reason); reloaded.push(s.sessionId) }
    }
    // Same credential-cache invalidation as disarmSessions — the canonical
    // caller just rotated credentials (org swap).
    this.credentials.invalidate()
    this.events.emit({
      level: 'info',
      kind: 'ADMIN_RELOAD',
      reason,
      sessionIdRequested: sessionId ?? null,
      reloadedCount: reloaded.length,
      sessionIds: reloaded,
    })
    return reloaded
  }

  /**
   * Credentials file changed on disk (the daemon's fs.watch on
   * `~/.claude/.credentials.json`). Invalidate the token cache AND the org-id
   * cache **in lock-step**, so the pin/rewrite logic never sees a fresh token
   * paired with a stale org-id — the 2026-06-02 incident, where the org-id's
   * independent 5-min TTL let real traffic slip onto a new org silently while
   * the guard still believed it was the old org.
   *
   * Does NOT touch session pins: a same-org refresh must stay seamless, and a
   * cross-org switch must HOLD each session on its old org until an explicit
   * reload (`reloadSessions` / `[%reload-ok%]`). Layer 1 only re-syncs the two
   * caches; Layer 2 (pins) decides what each session does with the result.
   */
  notifyCredentialsChanged(reason: string): void {
    this.credentials.invalidate()
    this.orgIdResolver.invalidate()
    this.events.emit({ level: 'info', kind: 'CREDENTIALS_CHANGED', reason })
  }

  /**
   * Decide which token a session's request uses, given the live account snapshot
   * and the session's existing pin. The whole per-session model lives here:
   *
   *  - no pin OR explicit reload (`[%reload-ok%]`) → (re)bind to the current
   *    account and use its token (new session / deliberate switch);
   *  - same org (incl. a safe same-org refresh, or an unknown/null org on either
   *    side) → adopt the fresh token, keep the pin on this org;
   *  - cross-org, old token still alive → HOLD: keep posting to the OLD org+token
   *    (no block, no migration);
   *  - cross-org, old token expired → force-stop (401) — never silently migrate
   *    onto the new org's quota.
   *
   * Mutates `sessionPins`. Pure w.r.t. I/O (no awaits) so it is unit-testable.
   */
  private selectSessionToken(
    sessionId: string,
    account: { orgId: string | null; token: string; expiresAt: number | null },
    reloadAsked: boolean,
    now: number,
  ): { token: string; stop: boolean; held: boolean } {
    const pin = this.sessionPins.get(sessionId)
    if (!pin || reloadAsked) {
      this.sessionPins.set(sessionId, { ...account })
      return { token: account.token, stop: false, held: false }
    }
    if (pin.orgId === null || account.orgId === null || pin.orgId === account.orgId) {
      pin.token = account.token            // same org → adopt the fresh token
      pin.expiresAt = account.expiresAt
      return { token: account.token, stop: false, held: false }
    }
    if (pin.expiresAt === null || now < pin.expiresAt) {
      return { token: pin.token, stop: false, held: true }   // cross-org, alive → HOLD
    }
    return { token: pin.token, stop: true, held: false }      // cross-org, expired → force-stop
  }

  // ─── Main entry point ──────────────────────────────────────────

  /**
   * Handle one /v1/messages request end-to-end. Returns a Response whose
   * body streams SSE bytes from Anthropic directly to the caller.
   *
   * Network errors produce 503 with Retry-After: 2. Upstream 401 invalidates
   * cached OAuth. Upstream 4xx/5xx pass through unchanged.
   */
  async handleRequest(
    rawBody: ArrayBuffer | Uint8Array | string,
    headers: Record<string, string>,
    ctx: HandleRequestContext,
  ): Promise<Response> {
    const sessionId = ctx.sessionId
    const sourcePid = ctx.sourcePid ?? null

    // Get or create session with KA engine
    const session = this.store.getOrCreate(
      sessionId,
      sourcePid,
      () => this.createEngine(sessionId),
    )
    session.lastRequestAt = Date.now()

    // Normalize body
    const rawBodyStr = typeof rawBody === 'string'
      ? rawBody
      : new TextDecoder().decode(rawBody as ArrayBuffer)
    const bodyBytes = typeof rawBody === 'string'
      ? new TextEncoder().encode(rawBody).byteLength
      : (rawBody as ArrayBuffer | Uint8Array).byteLength

    // Parse body minimally (for model extraction + KA snapshot)
    let parsedBody: any
    try {
      parsedBody = JSON.parse(rawBodyStr)
    } catch {
      this.events.emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: 'Invalid JSON body' })
      return jsonResponse(400, { error: 'Invalid JSON' })
    }

    const model = parsedBody.model ?? 'unknown'
    session.model = model

    // Detect a Claude Code version change. A CC version bump rewrites the
    // cached system text + tool definitions → a new lineage → one cold cache
    // rewrite per active session. It is otherwise invisible (it happens in
    // the background); surfacing it as an explicit event makes the rewrite
    // spike attributable instead of a silent mystery.
    {
      const ccVersion = extractCcVersion(parsedBody)
      if (ccVersion && ccVersion !== this.lastCcVersion) {
        const prev = this.lastCcVersion
        this.lastCcVersion = ccVersion
        if (prev !== null) {
          this.events.emit({
            level: 'info',
            kind: 'CC_VERSION_CHANGED',
            sessionId,
            previousVersion: prev,
            version: ccVersion,
            msg: `Claude Code version ${prev} -> ${ccVersion} — the cacheable `
              + `prefix changed; expect one cold cache rewrite per active session`,
          })
        }
      }
    }

    // Build upstream headers: strip hop-by-hop + consumer auth, force identity encoding
    const upstreamHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (HOP_BY_HOP_OR_AUTH.includes(lk)) continue
      upstreamHeaders[k] = v
    }
    upstreamHeaders['accept-encoding'] = 'identity'

    // Inject OAuth bearer — per-session org/token pin selection (Layer 2).
    // A cross-org login does NOT migrate a live session: it HOLDS the old
    // org+token until an explicit switch (`[%reload-ok%]` / cli reload) or a
    // force condition (old token expired). Same-org refresh adopts the fresh
    // token seamlessly.
    let orgHeld = false   // this session is holding a previous org (KA must warm the OLD cache)
    try {
      const account = {
        orgId: this.orgIdResolver.current(),
        token: await this.credentials.getAccessToken(),
        expiresAt: this.credentials.currentExpiresAt?.() ?? null,
      }
      const reloadAsked = inspectLastUserMessage(
        parsedBody, loadKeepaliveConfig().rewriteGuard.reloadMarker,
      ).hasMarker
      const sel = this.selectSessionToken(sessionId, account, reloadAsked, Date.now())
      if (sel.stop) {
        this.events.emit({
          level: 'error',
          kind: 'ORG_PIN_EXPIRED',
          sessionId,
          msg: 'pinned previous-org token expired — reload required to continue on the current org',
        })
        return jsonResponse(401, {
          error: {
            type: 'authentication_error',
            message: 'This session was pinned to a previous organization whose access token has now '
              + 'expired. Re-send your message with [%reload-ok%] (or run a proxy reload) to continue '
              + 'on the current organization — expect a one-time large cache rewrite.',
          },
        })
      }
      if (sel.held) {
        orgHeld = true
        this.events.emit({
          level: 'info',
          kind: 'ORG_PIN_HELD',
          sessionId,
          msg: 'cross-org login detected — holding this session on its previous org+token (no migration)',
        })
      }
      upstreamHeaders[HEADER_AUTHORIZATION] = `Bearer ${sel.token}`
    } catch (credErr: any) {
      this.events.emit({
        level: 'error',
        kind: 'TOKEN_NEEDS_RELOGIN',
        sessionId,
        msg: credErr?.message ?? 'No OAuth credentials',
      })
      return jsonResponse(401, {
        error: { type: 'authentication_error', message: credErr?.message ?? 'No OAuth credentials' },
      })
    }

    // Ensure oauth beta flag present
    const existingBeta = upstreamHeaders[HEADER_ANTHROPIC_BETA] ?? upstreamHeaders['Anthropic-Beta'] ?? ''
    if (!existingBeta.includes('oauth-2025-04-20')) {
      const prefix = existingBeta ? existingBeta + ',' : ''
      upstreamHeaders[HEADER_ANTHROPIC_BETA] = prefix + 'oauth-2025-04-20'
      delete upstreamHeaders['Anthropic-Beta']
    }

    // Lift native Claude Code's cache_control markers from the implicit 5-minute
    // ephemeral TTL to ttl:'1h'. Native CC marks its stable system+tools+history
    // prefix with `cache_control:{type:'ephemeral'}`; a coding turn routinely
    // runs longer than 5 minutes, so that prefix dies mid-turn and the next turn
    // re-caches ~140K tokens (cache_creation ≈ 111× a cache_read). Anthropic
    // honors ttl:'1h' only under the prompt-caching-scope beta — which native CC
    // already sends — so gate on it. Done BEFORE notifyRealRequestStart +
    // predictCacheMiss so the KA engine's wire autoscan and the rewrite guard
    // both measure against the cache TTL actually forwarded upstream.
    let forwardBodyStr = rawBodyStr
    {
      const beta = upstreamHeaders[HEADER_ANTHROPIC_BETA] ?? upstreamHeaders['Anthropic-Beta'] ?? ''
      if (beta.includes('prompt-caching-scope-2026-01-05')) {
        const { upgraded } = upgradeCacheControlTtl(parsedBody)
        if (upgraded > 0) forwardBodyStr = JSON.stringify(parsedBody)
      }
    }

    // Compute the lineage key WITHOUT priming — lineageKey(body) is pure, so the
    // rewrite guard can decide BEFORE any keepalive mutation. (Matches the value
    // notifyRealRequestStart returns on the proceed path below.)
    const reqLineageKey = lineageKey(parsedBody)

    // Assess (PURE — no history writes) so a blocked request never advances
    // state. The commit (prefix-history write + KA prime) happens only if the
    // request proceeds past the guard.
    const assessed = this.assessCacheMiss(sessionId, reqLineageKey, parsedBody, bodyBytes)
    const rewriteAssessment = assessed?.assessment ?? null

    // Rewrite guard — opt-in, default OFF. When enabled, an avoidable/anomalous
    // rewrite above the configured token threshold that the user has NOT
    // confirmed (via the override marker in their latest message) is rejected
    // with 400 instead of silently spending quota. `expected:*` rewrites
    // (cold-start / compact / tools-changed) are never blocked. This does NOT
    // save the cost — the re-sent request re-caches the same — it converts a
    // silent quota spend into an explicit, consented one.
    {
      const guard = loadKeepaliveConfig().rewriteGuard
      const lastMsg = inspectLastUserMessage(parsedBody, guard.overrideMarker)
      if (guard.enabled && rewriteAssessment && !rewriteAssessment.expected
          && !rewriteAssessment.signals.orgChanged   // org no longer BLOCKS — it HOLDS (per-session pin, Layer 2)
          && rewriteAssessment.predictedTokens >= guard.minRewriteTokens
          && !lastMsg.isContinuation        // never block an agent tool-loop continuation
          && !lastMsg.hasMarker) {
        // Dump the request + prefix diff for offline analysis — both the
        // blocked and the let-through (automated) path.
        let dumpPath: string | null = null
        if (guard.dumpBlocked) {
          dumpPath = writeRewriteBlockDump(this.rewriteBlockDumpDir, {
            sessionId,
            lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass,
            predictedTokens: rewriteAssessment.predictedTokens,
            signals: rewriteAssessment.signals,
            blockedRequest: parsedBody,
            previousPrefix: rewriteAssessment.prevPrefix,
          })
        }
        // The guard is an INTERACTIVE consent checkpoint: a human sees the 400
        // and re-sends with the override marker. Two classes of consumer CANNOT
        // consent and must be let through (log + dump, no 400):
        //   1. An automated agent — Agent-SDK cognitive worker or CC sub-agent
        //      (detected by header / metadata).
        //   2. A programmatic endpoint client — OpenAI-compat or external
        //      Anthropic-API consumer (interactive=false), when the guard is in
        //      its default interactive-only mode. Set rewriteGuard.interactiveOnly
        //      =false to enforce on these too.
        const programmaticEndpoint = guard.interactiveOnly && ctx.interactive === false
        const bypassReason = isAutomatedAgent(parsedBody, headers)
          ? 'an automated agent'
          : (programmaticEndpoint ? 'a programmatic endpoint client' : null)
        if (bypassReason) {
          this.events.emit({
            level: 'info',
            kind: 'CACHE_REWRITE_UNGUARDED',
            sessionId,
            lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass,
            predictedTokens: rewriteAssessment.predictedTokens,
            dumpPath,
            msg: `rewrite guard would block ${rewriteAssessment.rewriteClass} `
              + `(~${rewriteAssessment.predictedTokens} tok) — consumer is ${bypassReason} `
              + `(cannot consent); passed through`
              + (dumpPath ? ` — dump: ${dumpPath}` : ''),
          })
        } else {
          this.events.emit({
            level: 'error',
            kind: 'CACHE_REWRITE_BLOCKED',
            sessionId,
            lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass,
            predictedTokens: rewriteAssessment.predictedTokens,
            dumpPath,
            msg: `rewrite guard blocked ${rewriteAssessment.rewriteClass} `
              + `(~${rewriteAssessment.predictedTokens} tok) — awaiting user override marker`
              + (dumpPath ? ` — dump: ${dumpPath}` : ''),
          })
          return jsonResponse(400, {
            error: {
              type: 'cache_rewrite_guard',
              message: `Cache-rewrite guard: this turn would re-cache ~${rewriteAssessment.predictedTokens} `
                + `tokens (${rewriteAssessment.rewriteClass}) — an unconfirmed quota spend. To proceed, `
                + `re-send your message with ${guard.overrideMarker} in it. `
                + `(Disable: keepalive.json → rewriteGuard.enabled=false.)`,
            },
          })
        }
      }
    }

    // Cross-org login → this session HOLDS its old org+token for real traffic
    // (Layer 2 forward selection above). Keep the OLD org's cache warm during
    // the hold: while held, KA replays the snapshot's old token. The flag tracks
    // the PIN state (source of truth), not the assess-time orgChanged: set while
    // held, cleared on rebind / same-org so KA resumes fresh-token warming.
    if (orgHeld) session.engine.markOrgSwitchPending(reqLineageKey)
    else session.engine.clearOrgSwitchPending(reqLineageKey)

    // PROCEED path — the request will be forwarded. ONLY NOW mutate keepalive:
    // prime the engine (aborts any in-flight KA, records the pending snapshot)
    // and advance prefix history. A blocked request returned above without
    // reaching here, so it never disturbs keepalive's warming of the OLD cache.
    this.events.emit({ level: 'info', kind: 'REAL_REQUEST_START', sessionId, model, bodyBytes })
    session.engine.notifyRealRequestStart(model, parsedBody, upstreamHeaders)
    if (assessed) this.commitPrefixHistory(assessed.commit)

    // Pre-request rewrite-burst guard
    try {
      session.engine.checkRewriteGuard(model)
    } catch (err: any) {
      if (err?.code === 'CACHE_REWRITE_BLOCKED') {
        return jsonResponse(429, {
          error: { type: 'cache_rewrite_blocked', message: err.message },
        })
      }
      throw err
    }

    const t0 = Date.now()

    // Forward upstream
    let upstream: Response
    try {
      upstream = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: forwardBodyStr,
        signal: ctx.signal,
      })
    } catch (fetchErr: any) {
      return this.handleNetworkError(sessionId, fetchErr)
    }

    // Parse rate-limit headers into snapshot
    this.lastRateLimit = parseRateLimitHeaders(upstream.headers)

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      if (upstream.status === 401) this.credentials.invalidate()

      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        status: upstream.status,
        msg: errText.slice(0, 200),
      })

      if (upstream.status === 429) {
        this.events.emit({
          level: 'error',
          kind: 'UPSTREAM_RATE_LIMITED',
          sessionId,
          resetAt: this.lastRateLimit.resetAt,
          retryAfterSec: this.lastRateLimit.retryAfter,
          requestKind: 'real',
          status: 429,
        })
      }

      return new Response(errText, {
        status: upstream.status,
        headers: upstream.headers,
      })
    }

    if (!upstream.body) {
      return new Response('No upstream body', { status: 502 })
    }

    // Tee SSE stream: one to caller, one for usage parsing
    let toClient: ReadableStream<Uint8Array>
    let toParse: ReadableStream<Uint8Array>
    try {
      const teed = upstream.body.tee()
      toClient = teed[0]
      toParse = teed[1]
    } catch (teeErr: any) {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `tee() failed: ${teeErr?.message}`,
      })
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
    }

    // Parse in background — extract usage + notify engine. Never crashes.
    void this.parseSSEAndNotify(toParse, session, sessionId, model, t0, reqLineageKey).catch((e) => {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `parse promise rejected: ${e?.message}`,
      })
    })

    // Return byte-for-byte stream to caller
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    return new Response(toClient, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }

  // ─── Internal: engine factory per session ──────────────────────

  private createEngine(sessionId: string): KeepaliveEngine {
    const cfg = this.config
    return new KeepaliveEngine({
      evictionBreaker: this.evictionBreaker,
      config: {
        // Per-consumer TTL pin — see ProxyClientConfig.kaCacheTtlSec docs.
        // Default 3600s: handleRequest upgrades native CC's cache_control to
        // ttl:'1h', so KA fires every ~30 min against a genuinely 1h cache.
        // The wire autoscan downlocks this per-session if a 5m marker appears.
        cacheTtlMs: cfg.kaCacheTtlSec * 1000,
        // undefined → engine reads from SSOT (~/.claude/keepalive.json)
        intervalMs: cfg.kaIntervalSec !== undefined ? cfg.kaIntervalSec * 1000 : undefined,
        idleTimeoutMs: cfg.kaIdleTimeoutSec > 0 ? cfg.kaIdleTimeoutSec * 1000 : Infinity,
        minTokens: cfg.kaMinTokens,
        rewriteWarnIdleMs: cfg.kaRewriteWarnIdleSec * 1000,
        rewriteWarnTokens: cfg.kaRewriteWarnTokens,
        rewriteBlockIdleMs: cfg.kaRewriteBlockIdleSec > 0 ? cfg.kaRewriteBlockIdleSec * 1000 : Infinity,
        rewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
        onHeartbeat: (stats) => {
          // A successful KA fire just refreshed this lineage's Anthropic-side
          // cache prefix — record the warm-up so predictCacheMiss does not
          // later mistake KA-kept-warm idle for a TTL expiry and false-block.
          if (stats.lineageKey) {
            const e = this.prefixHistory.get(`${sessionId}:${stats.lineageKey}`)
            if (e) e.lastKaAt = Date.now()
          }
          // Record KA fire into metrics — they're the canonical hit-rate signal
          // since they replay the exact prompt prefix.
          this.metrics.recordRequest({
            kind: 'ka',
            cacheRead: stats.usage.cacheReadInputTokens ?? 0,
            cacheWrite: stats.usage.cacheCreationInputTokens ?? 0,
            input: stats.usage.inputTokens ?? 0,
            model: stats.model,
          })
          this.events.emit({
            level: 'info',
            kind: 'KA_FIRE_COMPLETE',
            sessionId,
            lineageKey: stats.lineageKey,
            model: stats.model,
            durationMs: stats.durationMs,
            idleMs: stats.idleMs,
            usage: {
              inputTokens: stats.usage.inputTokens,
              outputTokens: stats.usage.outputTokens,
              cacheReadInputTokens: stats.usage.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: stats.usage.cacheCreationInputTokens ?? 0,
            },
            rateLimit: stats.rateLimit,
          })
        },
        onTick: (tick) => {
          // Use the engine's resolved intervalMs for "idle" threshold.
          // If kaIntervalSec was unset, fall back to a reasonable estimate (90% of resolved interval).
          const resolvedIntervalMs = (cfg.kaIntervalSec ?? 120) * 1000
          if (tick.idleMs > resolvedIntervalMs * 0.9) {
            this.events.emit({
              level: 'debug',
              kind: 'KA_TICK_IDLE',
              sessionId,
              idleMs: tick.idleMs,
              nextFireMs: tick.nextFireMs,
              model: tick.model,
              tokens: tick.tokens,
            })
          }
        },
        onDisarmed: (info) => this.events.emit({
          level: 'error',
          kind: 'KA_DISARM',
          sessionId,
          reason: info.reason,
          msg: `KA disarmed for session ${sessionId.slice(0, 8)} — reason=${info.reason}`,
        }),
        onRewriteWarning: (info) => this.events.emit({
          level: info.blocked ? 'error' : 'info',
          kind: info.blocked ? 'REWRITE_BLOCK' : 'REWRITE_WARN',
          sessionId,
          idleMs: info.idleMs,
          estimatedTokens: info.estimatedTokens,
          blocked: info.blocked,
          model: info.model,
        }),
        onNetworkStateChange: (info) => this.events.emit({
          level: info.to === 'degraded' ? 'error' : 'info',
          kind: info.to === 'degraded' ? 'NETWORK_DEGRADED' : 'NETWORK_HEALTHY',
          sessionId,
          from: info.from,
          to: info.to,
        }),
        onTtlScan: (info) => this.events.emit({
          level: 'info',
          kind: 'CACHE_TTL_CHANGED',
          sessionId,
          minTtlMs: info.minTtlMs,
          previousTtlMs: info.previousTtlMs,
          hasAnyCacheControl: info.hasAnyCacheControl,
          msg: `cache_control TTL ${info.previousTtlMs === null ? 'first-seen' : 'changed'} for session ${sessionId.slice(0, 8)} — ${info.previousTtlMs === null ? '?' : Math.round(info.previousTtlMs / 60000) + 'm'} → ${info.minTtlMs === null ? 'none' : Math.round(info.minTtlMs / 60000) + 'm'}`,
        }),
        // Registry mutated → mark the KA snapshot file dirty so the reaper
        // persists the fresh state on its next tick.
        onRegistryChange: () => { this.kaSnapshotDirty = true },
      },
      getToken: () => this.credentials.getAccessToken(),
      doFetch: (body, headers, signal) => this.engineDoFetch(body, headers, signal),
      getRateLimitInfo: () => this.lastRateLimit,
      isOwnerAlive: () => this.store.isOwnerAlive(sessionId),
    })
  }

  // ─── Internal: KA snapshot persistence (survives a proxy restart) ──────

  /** Serialise every armed engine's KA registry into a persistable map. */
  private collectKaSnapshots(): Record<string, PersistedSession> {
    const out: Record<string, PersistedSession> = {}
    for (const s of this.store.list()) {
      const state = s.engine.serializeState()
      if (!state) continue                       // disarmed / never-armed — skip
      out[s.sessionId] = {
        ...state,
        sessionId: s.sessionId,
        ownerPid: s.pid ?? null,
        model: s.model ?? null,
      }
    }
    return out
  }

  /** Persist the KA snapshot registry. Best-effort — never throws. */
  private persistKaSnapshots(): void {
    saveKaSnapshots(this.collectKaSnapshots(), this.kaSnapshotPath)
  }

  /**
   * Startup: revive KA engines for sessions whose cache is provably still
   * warm. A snapshot too stale to revive is DROPPED — never re-armed (firing
   * KA on a dead cache is itself a cold write = quota burn). Each dropped
   * lineage is recorded in `kaReviveDropped` so the next real request for it
   * is surfaced as a genuine rewrite, not silently passed as proxy-restart.
   */
  private reviveKaSnapshots(): void {
    let sessions: Record<string, PersistedSession>
    try {
      sessions = loadKaSnapshots(this.kaSnapshotPath).sessions
    } catch {
      return
    }
    const ssot = loadKeepaliveConfig()
    const intervalMs = this.config.kaIntervalSec !== undefined
      ? this.config.kaIntervalSec * 1000
      : ssot.intervalMs
    const opts = {
      safetyMarginMs: ssot.safetyMarginMs,
      intervalMs,
      maxAgeMs: KA_SNAPSHOT_MAX_AGE_MS,
      fireBudgetMs: ssot.healthProbeTimeoutMs,
    }
    const now = Date.now()
    for (const [sid, ps] of Object.entries(sessions)) {
      // Owner-PID gate first — never revive a session whose consumer exited
      // (pid 1 = reparented to init = parent dead).
      if (ps.ownerPid != null && (ps.ownerPid === 1 || !this.liveness.isAlive(ps.ownerPid))) {
        this.recordReviveDrop(sid, ps, 'owner-dead')
        continue
      }
      const verdict = assessRevival(ps, now, opts)
      if (!verdict.revive) {
        this.recordReviveDrop(sid, ps, verdict.reason)
        continue
      }
      try {
        const session = this.store.getOrCreate(sid, ps.ownerPid, () => this.createEngine(sid))
        session.model = ps.model
        session.engine.revive(ps)
        this.kaSnapshotDirty = true
        this.events.emit({
          level: 'info',
          kind: 'KA_REVIVED',
          sessionId: sid,
          lineageCount: ps.registry.length,
          model: ps.model,
          cacheAgeMs: now - ps.cacheWrittenAt,
          msg: `KA revived for session ${sid.slice(0, 8)} — ${ps.registry.length} lineage(s), `
            + `cache ${Math.round((now - ps.cacheWrittenAt) / 1000)}s old`,
        })
      } catch {
        this.recordReviveDrop(sid, ps, 'revive-error')
      }
    }
  }

  /** Record a dropped KA snapshot: tag its lineages (so the guard surfaces the
   *  next real request as a real rewrite) and emit KA_REVIVE_DROP.
   *
   *  A drop only feeds `kaReviveDropped` (→ the rewrite guard treats the next
   *  real request as a blockable `avoidable:ttl-expiry`) when the cache death
   *  was AVOIDABLE — i.e. the cache was still alive at restart and a prompt KA
   *  could have kept it warm (`cache-dies-before-ka`), or revival hit a bug
   *  (`revive-error`). When the cache had ALREADY lapsed (`cache-already-dead`)
   *  or aged out (`too-old`), the gap exceeded the TTL — typically host
   *  downtime (reboot / power loss) during which no keepalive could possibly
   *  run. That rewrite is unavoidable, so we must NOT flag it: classifyRewrite
   *  then yields `expected:proxy-restart` and the guard lets the legitimate
   *  session-resume request through instead of 400-blocking it. */
  private static readonly AVOIDABLE_DROP_REASONS = new Set([
    'cache-dies-before-ka',
    'revive-error',
  ])

  private recordReviveDrop(sessionId: string, ps: PersistedSession, reason: string): void {
    const avoidable = ProxyClient.AVOIDABLE_DROP_REASONS.has(reason)
    if (avoidable) {
      for (const e of ps.registry ?? []) {
        if (e && typeof e.lineageKey === 'string') {
          this.kaReviveDropped.add(`${sessionId}:${e.lineageKey}`)
        }
      }
    }
    this.events.emit({
      level: 'info',
      kind: 'KA_REVIVE_DROP',
      sessionId,
      reason,
      lineageCount: ps.registry?.length ?? 0,
      msg: `KA snapshot not revived for session ${sessionId.slice(0, 8)} — ${reason}`
        + (avoidable ? ' [blockable]' : ' [unavoidable downtime — guard will pass]'),
    })
  }

  // ─── Internal: SSE-generator wrapper used by engine ────────────
  //
  // KeepaliveEngine expects doFetch to yield StreamEvent objects. We wrap
  // the IUpstreamFetcher (which returns a Response) into an async generator
  // that parses SSE and yields typed events.

  private async *engineDoFetch(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const bodyStr = JSON.stringify(body)
    const response = await this.upstream.fetch(
      `${this.config.anthropicBaseUrl}/v1/messages?beta=true`,
      { method: 'POST', headers, body: bodyStr, signal },
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const err: Error & {
        status?: number
        resetAt?: number | null     // epoch SECONDS (Anthropic convention) — engine multiplies by 1000
        retryAfterSec?: number | null
      } = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      err.status = response.status
      if (response.status === 401) this.credentials.invalidate()
      if (response.status === 429) {
        // Parse rate-limit headers (engine path bypasses the real-request
        // header parser; do it inline so the emitted event carries resetAt).
        const rl = parseRateLimitHeaders(response.headers)
        this.lastRateLimit = rl
        // Attach to the thrown error so the KA engine can apply smart-pause
        // policy (cache_dies_at vs resetAt) instead of plain retry-chain.
        err.resetAt = rl.resetAt
        err.retryAfterSec = rl.retryAfter
        this.events.emit({
          level: 'error',
          kind: 'UPSTREAM_RATE_LIMITED',
          sessionId: null,
          resetAt: rl.resetAt,
          retryAfterSec: rl.retryAfter,
          requestKind: 'ka',
          status: 429,
        })
      }
      throw err
    }

    if (!response.body) throw new Error('No response body')

    // Parse SSE and yield StreamEvents (only what engine cares about)
    yield* parseSSEToEvents(response.body, signal)
  }

  // ─── Internal: parse consumer-facing stream for usage ──────────

  private async parseSSEAndNotify(
    stream: ReadableStream<Uint8Array>,
    session: Session<KeepaliveEngine>,
    sessionId: string,
    model: string,
    t0: number,
    lineageKey: string,
  ): Promise<void> {
    try {
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      let buffer = ''
      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          const r = await reader.read()
          done = r.done
          value = r.value
        } catch (readErr: any) {
          this.events.emit({
            level: 'debug',
            kind: 'REAL_REQUEST_ERROR',
            sessionId,
            msg: `stream read aborted: ${readErr?.message}`,
          })
          return
        }
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') continue
          try {
            const p = JSON.parse(raw)
            if (p.type === 'message_start' && p.message?.usage) {
              const u = p.message.usage
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
              }
              // Phase 3.B (REQ-05, OQ-02): TTL-split + deletion subfields.
              // Present only on responses that used 1h cache_control or
              // experienced compact_20260112 / cache_edits.clear_at. Forward
              // `undefined` when absent (not 0) — omit-when-absent contract.
              const cc = u.cache_creation
              if (cc && typeof cc === 'object') {
                if (typeof cc.ephemeral_5m_input_tokens === 'number') {
                  usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
                }
                if (typeof cc.ephemeral_1h_input_tokens === 'number') {
                  usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
                }
              }
              if (typeof u.cache_deleted_input_tokens === 'number') {
                usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
              }
            } else if (p.type === 'message_delta' && p.usage?.output_tokens) {
              usage.outputTokens = p.usage.output_tokens
            }
          } catch { /* malformed line, skip */ }
        }
      }

      const isFirstCall = session.lastUsage === null
      session.lastUsage = usage
      try {
        session.engine.notifyRealRequestComplete(usage, lineageKey)
      } catch (e: any) {
        this.events.emit({
          level: 'error',
          kind: 'REAL_REQUEST_ERROR',
          sessionId,
          msg: `engine.notifyRealRequestComplete: ${e?.message}`,
        })
      }

      // Record into rolling metrics for hit-rate / regression tracking.
      this.metrics.recordRequest({
        kind: 'real',
        cacheRead: usage.cacheReadInputTokens ?? 0,
        cacheWrite: usage.cacheCreationInputTokens ?? 0,
        input: usage.inputTokens ?? 0,
        model,
        firstCall: isFirstCall,
      })

      this.events.emit({
        level: 'info',
        kind: 'REAL_REQUEST_COMPLETE',
        sessionId,
        // lineageKey lets offline analysis attribute a cache hit/rewrite to a
        // specific agent (main vs each sub-agent) — needed to verify the main
        // agent's cache survives a sub-agent (Task-tool) excursion.
        lineageKey,
        model,
        durationMs: Date.now() - t0,
        usage,
        rateLimit: {
          util5h: this.lastRateLimit.utilization5h,
          util7d: this.lastRateLimit.utilization7d,
          status: this.lastRateLimit.status,
        },
      })
    } catch (err: any) {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `SSE parse error: ${err?.message ?? err}`,
      })
    }
  }

  // ─── Internal: predicted cache-miss observability ──────────────
  //
  // Before forwarding, compare this request's cacheable-prefix fingerprint to
  // the previous request of the same (session, lineage). A divergence at the
  // system/tools block — or an idle gap past the cache TTL — predicts a
  // cache_creation rewrite. We NEVER block (the request is the user's work);
  // we classify + emit PREDICTED_CACHE_MISS so every rewrite is visible with
  // its cause: expected:* (cold-start / compact / tools-change — incl. the
  // user's "первичный запуск = норм") logs at info; avoidable:* / anomalous:*
  // log at error. Never throws — observability must not affect throughput.

  /**
   * Pure assessment of whether this request incurs a cache rewrite — does NOT
   * mutate prefix history. Returns a `commit` payload (always, so the PROCEED
   * path can advance history) and an `assessment` (null on an expected cache
   * HIT — nothing to surface/block). A blocked request calls this and skips
   * commit, so an unconsented rewrite never advances state or poisons the
   * marker-carrying retry's classification.
   */
  private assessCacheMiss(
    sessionId: string,
    lineageKey: string,
    body: Record<string, unknown>,
    bodyBytes: number,
  ): {
    commit: { key: string; ph: ReturnType<typeof prefixHashes>; now: number; orgId: string | null; prevLastKaAt: number | undefined; system: unknown; tools: unknown }
    assessment: {
      rewriteClass: string
      expected: boolean
      predictedTokens: number
      signals: { systemChanged: boolean; toolsChanged: boolean; orgChanged: boolean; idleMs: number | null; ttlMs: number }
      /** Previous cacheable prefix of this lineage (for a guard-block dump). */
      prevPrefix: CachePrefix | null
    } | null
  } | null {
    try {
      const key = `${sessionId}:${lineageKey}`
      const now = Date.now()
      const ph = prefixHashes(body)
      const prev = this.prefixHistory.get(key)
      const orgId = this.orgIdResolver.current()
      // Capture the previous cacheable prefix (read-only) so a guard-block dump
      // can diff old vs new system/tools. The actual history WRITE is deferred
      // to commitPrefixHistory (proceed path only).
      const prevPrefix = this.lineagePrefix.get(key) ?? null
      // commit payload — caller persists this ONLY when the request proceeds.
      const commit = { key, ph, now, orgId, prevLastKaAt: prev?.lastKaAt, system: body.system, tools: body.tools }

      const isFirstRequest = !prev
      const systemChanged = !!prev && prev.hashes.system !== ph.system
      const toolsChanged = !!prev && prev.hashes.toolNames !== ph.toolNames
      // Effective idle = time since the cache was last WARMED — by a real
      // request OR a KA fire. KA fires replay the prefix and refresh its
      // Anthropic-side TTL, so a lineage that KA kept warm must NOT read as
      // idle-past-TTL (that false `avoidable:ttl-expiry` made the rewrite
      // guard block requests whose cache was in fact hot).
      const lastWarmAt = prev ? Math.max(prev.lastReqAt, prev.lastKaAt ?? 0) : undefined
      const idleMs = lastWarmAt !== undefined ? now - lastWarmAt : undefined
      // TTL the guard measures idle against = the cache lifetime actually on the
      // wire, read from THIS request's cache_control markers (post-1h-upgrade if
      // the proxy lifted them). The static kaCacheTtlSec is only a fallback for
      // a body that carries no cache_control marker at all. Reading the wire —
      // not a config constant — is what stops a 1h-cached lineage idle 19 min
      // from false-classifying as avoidable:ttl-expiry (the 405d1df5 block).
      const ttlMs = detectCacheTtlFromBody(body).minTtlMs ?? this.config.kaCacheTtlSec * 1000
      // The cache's last warm-up predates this proxy process → the TTL gap
      // spans a restart. KA could not have kept it warm (its engine did not
      // exist), so an expiry here is NOT avoidable — see classifyRewrite.
      const spansProxyRestart = lastWarmAt !== undefined && lastWarmAt < this.proxyStartedAt
      // ...UNLESS KA-persistence had a snapshot for this lineage and dropped it
      // as already-dead at startup — then the rewrite IS blockable. One-shot:
      // consume the flag so only the first post-restart request is surfaced.
      // Read-only here; the one-shot consume (delete) is deferred to
      // commitPrefixHistory so a blocked request does not consume it — the
      // marker-carrying retry must still see the dropped-snapshot signal.
      const kaRevivalDropped = this.kaReviveDropped.has(key)
      // org-switch: this lineage's prefix was last cached under a different
      // org than the one billing the current request. Tripped ONLY when both
      // org-ids are known and differ — an unknown org (`null`) never trips it.
      // This is deliberate: a routine ~8h same-org token refresh leaves
      // `oauthAccount.organizationUuid` untouched, so it never false-blocks;
      // and a transient read failure (null) degrades to "can't prove a
      // switch" rather than to a false 400.
      const prevOrgId = prev?.orgId ?? null
      const orgChanged = !!prev && orgId !== null && prevOrgId !== null && orgId !== prevOrgId

      // Prefix unchanged + within TTL + same org → a cache HIT is expected; stay
      // quiet. Still return the commit payload so the proceed path advances
      // lastReqAt (a normal hit must refresh the idle clock).
      if (!isFirstRequest && !systemChanged && !toolsChanged && !orgChanged
          && (idleMs === undefined || idleMs <= ttlMs)) {
        return { commit, assessment: null }
      }

      const verdict = classifyRewrite({ isFirstRequest, toolsChanged, idleMs, ttlMs, orgChanged, spansProxyRestart, kaRevivalDropped })
      // When the cacheable prefix diverges or expires, ~the whole context
      // re-caches. bodyBytes/4 is a rough token estimate — adequate for a
      // threshold check (the guard) and a human-readable log figure.
      const predictedTokens = Math.round(bodyBytes / 4)
      this.events.emit({
        level: verdict.expected ? 'info' : 'error',
        kind: 'PREDICTED_CACHE_MISS',
        sessionId,
        lineageKey,
        rewriteClass: verdict.class,
        expected: verdict.expected,
        systemChanged,
        toolsChanged,
        orgChanged,
        predictedTokens,
        idleMs: idleMs ?? null,
        ttlMs,
        msg: `predicted cache rewrite — ${verdict.class} (~${predictedTokens} tok)`
          + (systemChanged ? ' [system changed]' : '')
          + (toolsChanged ? ' [tools changed]' : '')
          + (orgChanged ? ' [org switched]' : '')
          + (spansProxyRestart ? ' [spans proxy restart]' : '')
          + (kaRevivalDropped ? ' [ka snapshot dropped — unrevivable]' : '')
          + (idleMs !== undefined && idleMs > ttlMs
              ? ` [idle ${Math.round(idleMs / 1000)}s > ttl ${Math.round(ttlMs / 1000)}s]` : ''),
      })
      return {
        commit,
        assessment: {
          rewriteClass: verdict.class,
          expected: verdict.expected,
          predictedTokens,
          signals: { systemChanged, toolsChanged, orgChanged, idleMs: idleMs ?? null, ttlMs },
          prevPrefix,
        },
      }
    } catch {
      // Predictor is observability-only — never affect the request path.
      return null
    }
  }

  /** Persist this lineage's new prefix fingerprint + advance its idle clock.
   *  Call ONLY when the request PROCEEDS (never when the rewrite guard blocks
   *  it — a blocked, unconsented request must not advance history or it poisons
   *  the marker-carrying retry's classification). Also consumes the one-shot
   *  ka-revival-dropped flag. */
  private commitPrefixHistory(c: {
    key: string; ph: ReturnType<typeof prefixHashes>; now: number
    orgId: string | null; prevLastKaAt: number | undefined; system: unknown; tools: unknown
  }): void {
    this.lineagePrefix.set(c.key, { system: c.system, tools: c.tools })
    // Carry prevLastKaAt forward — a real request resets lastReqAt, but the
    // KA-fire timeline is independent and must survive this overwrite.
    this.prefixHistory.set(c.key, { hashes: c.ph, lastReqAt: c.now, orgId: c.orgId, lastKaAt: c.prevLastKaAt })
    this.kaReviveDropped.delete(c.key)
  }

  // ─── Internal: network error handler ───────────────────────────

  private handleNetworkError(sessionId: string, fetchErr: any): Response {
    const code = fetchErr?.code ?? fetchErr?.cause?.code ?? ''
    const msg = String(fetchErr?.message ?? '').toLowerCase()
    const isNetworkErr =
      NETWORK_ERROR_CODES.has(code) ||
      msg.includes('unable to connect') || msg.includes('failed to open socket') ||
      msg.includes('connection refused') || msg.includes('network')

    this.events.emit({
      level: 'error',
      kind: 'REAL_REQUEST_ERROR',
      sessionId,
      status: isNetworkErr ? 503 : 502,
      msg: `upstream fetch threw: ${code || ''} ${msg}`.trim().slice(0, 200),
    })

    if (isNetworkErr) {
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Upstream network error — proxy cannot reach Anthropic. Retrying will help once network is restored.',
        },
      }), {
        status: 503,
        headers: {
          [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON,
          'retry-after': '2',
        },
      })
    }

    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `Upstream request failed: ${msg || code || 'unknown'}` },
    }), { status: 502, headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON } })
  }
}

// ═══ Module-level helpers ═══════════════════════════════════════════

const HOP_BY_HOP_OR_AUTH = [
  'host', 'content-length', 'connection', 'authorization',
  'x-api-key',        // strip consumer API key — proxy injects its own OAuth bearer
  'accept-encoding',  // force uncompressed SSE
]

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
])

function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  return {
    status: headers.get('anthropic-ratelimit-unified-status'),
    resetAt: headers.get('anthropic-ratelimit-unified-reset')
      ? Number(headers.get('anthropic-ratelimit-unified-reset')) : null,
    claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
    retryAfter: headers.get('retry-after')
      ? parseFloat(headers.get('retry-after')!) : null,
    utilization5h: headers.get('anthropic-ratelimit-unified-5h-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-5h-utilization')!) : null,
    utilization7d: headers.get('anthropic-ratelimit-unified-7d-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-7d-utilization')!) : null,
  }
}

// ─── Prefix-history persistence (survives a proxy restart) ─────────
// In-memory prefix fingerprints were wiped on restart → first request of every
// session post-restart classified cold-start → rewrite guard blind. Persisting
// bridges restarts.

const PREFIX_HISTORY_PATH = join(homedir(), '.claude-local', 'proxy-prefix-history.json')
const PREFIX_HISTORY_MAX_AGE_MS = 60 * 60 * 1000   // prune entries older than 1h on load

function loadPrefixHistory(path: string): Map<string, PrefixHistoryEntry> {
  const m = new Map<string, PrefixHistoryEntry>()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<PrefixHistoryEntry>>
    const cutoff = Date.now() - PREFIX_HISTORY_MAX_AGE_MS
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.lastReqAt === 'number' && v.lastReqAt >= cutoff && v.hashes) {
        // `orgId` is absent in entries written before org-awareness — normalize
        // to `null` so a pre-upgrade prefix never reads as a (false) org-switch.
        m.set(k, {
          hashes: v.hashes,
          lastReqAt: v.lastReqAt,
          orgId: typeof v.orgId === 'string' ? v.orgId : null,
          lastKaAt: typeof v.lastKaAt === 'number' ? v.lastKaAt : undefined,
        })
      }
    }
  } catch { /* missing or corrupt → start empty */ }
  return m
}

function savePrefixHistory(m: Map<string, PrefixHistoryEntry>, path: string): void {
  try {
    writeFileSync(path, JSON.stringify(Object.fromEntries(m)))
  } catch { /* best-effort — never break the request path */ }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON },
  })
}

/**
 * Extract the Claude Code version from a request body's billing header.
 * Claude Code prepends a `x-anthropic-billing-header: cc_version=X.Y.Z.<fp>`
 * text block to `system`; the trailing `.<fp>` is a per-request fingerprint
 * (volatile) — we return only the stable `X.Y.Z`. Never throws.
 */
function extractCcVersion(body: unknown): string | null {
  try {
    const system = (body as { system?: unknown })?.system
    if (!Array.isArray(system)) return null
    for (const b of system) {
      const t = b && typeof b === 'object' ? (b as { text?: unknown }).text : undefined
      if (typeof t === 'string' && t.includes('x-anthropic-billing-header')) {
        const m = t.match(/cc_version=(\d+\.\d+\.\d+)/)
        if (m) return m[1]
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Extract the Claude Code session id from a request body's `metadata.user_id`.
 *
 * Claude Code embeds the session UUID in `metadata.user_id` even when the
 * `x-claude-code-session-id` HTTP header is absent — interactive CC writes it
 * as a JSON `{"...","session_id":"<uuid>"}`, an Agent-SDK-spawned agent writes
 * it as `user_<device>_account_<acct>_session_<uuid>`. The proxy front-end can
 * therefore key a HEADER-LESS agent (every SDK-spawned cognitive worker) to
 * its real, stable session id instead of a throwaway `anon-*` — which is what
 * makes per-session KA + cross-restart cache persistence work for them.
 *
 * Never throws — a parse failure / absent field yields `null`.
 */
export function extractSessionIdFromBody(
  rawBody: ArrayBuffer | Uint8Array | string,
): string | null {
  try {
    const s = typeof rawBody === 'string'
      ? rawBody
      : new TextDecoder().decode(rawBody as ArrayBuffer)
    if (!s.includes('session')) return null              // cheap bail-out
    const body = JSON.parse(s) as { metadata?: { user_id?: unknown } }
    const uid = body?.metadata?.user_id
    if (typeof uid !== 'string') return null
    // Matches both `"session_id":"<uuid>"` and `..._session_<uuid>` — the
    // optional `_id` covers the JSON `session_id` key.
    const m = uid.match(
      /session(?:_?id)?["'_:\s]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
    )
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Is this request from an AUTOMATED agent (vs an interactive human)?
 *
 * The rewrite guard is an interactive consent checkpoint — a 400 the human
 * answers by re-sending with the override marker. An automated agent cannot
 * do that, so the guard must not hard-block it. Two automated cases:
 *   - a Claude Code sub-agent — carries the `x-claude-code-agent-id` header;
 *   - an Agent-SDK-spawned agent (every CWE/CWA cognitive worker) — its
 *     `metadata.user_id` is the underscore form `user_..._session_<uuid>`,
 *     whereas interactive Claude Code writes `user_id` as a JSON object.
 * Never throws.
 */
function isAutomatedAgent(body: unknown, headers: Record<string, string>): boolean {
  try {
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === 'x-claude-code-agent-id' && typeof v === 'string' && v) return true
    }
    const uid = (body as { metadata?: { user_id?: unknown } })?.metadata?.user_id
    if (typeof uid === 'string' && !uid.trimStart().startsWith('{') && uid.includes('_session_')) {
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * Inspect the LATEST user message for rewrite-guard purposes. Never throws.
 *
 *   isContinuation — the message carries a `tool_result` block → it is an
 *     agent tool-loop continuation, NOT a fresh user turn. The guard must NOT
 *     apply: the user has no message to add a marker to, so blocking would
 *     strand the loop forever. Such a request is always let through (the
 *     PREDICTED_CACHE_MISS log still records it).
 *   hasMarker — the override marker is present in this message's text. Only
 *     the latest user message is scanned, so a marker left in conversation
 *     history does NOT count — fresh-consent: the marker must be in the turn
 *     being sent now. This is why no marker-counting is needed: an old marker
 *     is structurally excluded by "latest message only".
 */
function inspectLastUserMessage(
  body: unknown,
  marker: string,
): { isContinuation: boolean; hasMarker: boolean } {
  const NONE = { isContinuation: false, hasMarker: false }
  try {
    const msgs = (body as { messages?: unknown })?.messages
    if (!Array.isArray(msgs)) return NONE
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m || typeof m !== 'object' || (m as { role?: unknown }).role !== 'user') continue
      const content = (m as { content?: unknown }).content
      let isContinuation = false
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'tool_result') isContinuation = true
          if (typeof b.text === 'string') text += b.text + '\n'
        }
      }
      return { isContinuation, hasMarker: !!marker && text.includes(marker) }
    }
    return NONE
  } catch {
    return NONE
  }
}

/**
 * Parse Anthropic SSE stream into StreamEvent objects.
 * Only yields message_start / message_delta / message_stop — engine only
 * cares about usage. Other events (content_block_delta etc) are drained but
 * not yielded.
 */
async function* parseSSEToEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }

  try {
    while (true) {
      if (signal?.aborted) { reader.cancel(); return }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') continue
        let p: any
        try { p = JSON.parse(raw) } catch { continue }

        if (p.type === 'message_start' && p.message?.usage) {
          const u = p.message.usage
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          }
          // Phase 3.B (REQ-05): same TTL-split + deletion capture as
          // upstream.ts. Optional subfields forwarded `undefined` on absent.
          const cc = u.cache_creation
          if (cc && typeof cc === 'object') {
            if (typeof cc.ephemeral_5m_input_tokens === 'number') {
              usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
            }
            if (typeof cc.ephemeral_1h_input_tokens === 'number') {
              usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
            }
          }
          if (typeof u.cache_deleted_input_tokens === 'number') {
            usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
          }
        } else if (p.type === 'message_delta' && p.usage?.output_tokens) {
          usage.outputTokens = p.usage.output_tokens
        } else if (p.type === 'message_stop') {
          yield { type: 'message_stop', usage, stopReason: null }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
