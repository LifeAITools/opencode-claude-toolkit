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
import type { KeepaliveConfig, KeepaliveStats, KeepaliveTick, RateLimitInfo, StreamEvent, TokenUsage } from './types.js';
export interface KeepaliveEngineOptions {
    /** Keepalive config (see KeepaliveConfig for all options). Defaults applied internally. */
    config?: KeepaliveConfig;
    /** Returns a fresh access_token. Implementation handles refresh/triple-check/etc. */
    getToken: () => Promise<string>;
    /**
     * Performs the actual Anthropic API request and yields SSE events.
     * Engine uses this for KA fires; consumer uses whatever transport it wants.
     * Must throw APIError/RateLimitError with .status for error classification.
     */
    doFetch: (body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal) => AsyncGenerator<StreamEvent>;
    /** Returns current rate limit snapshot (used by onHeartbeat callback). */
    getRateLimitInfo: () => RateLimitInfo;
    /**
     * Optional just-in-time liveness check. Called BEFORE every KA fire.
     * If returns false → engine stops (registry cleared, timer dead).
     * Use case: proxy-side PID-of-owner check — don't burn quota firing
     * KA into a cache whose consumer process already exited.
     *
     * If omitted → engine assumes owner is always alive (current behavior).
     */
    isOwnerAlive?: () => boolean;
    /**
     * Optional SHARED cross-engine eviction circuit breaker. When this engine's
     * Layer 5 detects a server-side cold-write eviction it trips the breaker;
     * before firing, every engine consults it and HOLDS (skips the fire) while it
     * is tripped — turning an N-session eviction-rewrite cascade into one rewrite
     * plus a brief fleet-wide hold. Pass the SAME instance to every engine in the
     * process (the proxy does this via SessionTracker). Omit for single-session
     * SDK use — then the engine behaves exactly as before.
     */
    evictionBreaker?: EvictionCircuitBreaker;
}
import { type AgentRole } from './lineage.js';
import type { PersistedEngineState } from './ka-snapshot-store.js';
import type { EvictionCircuitBreaker } from './eviction-breaker.js';
/** One KA registry entry — keyed by cache lineage, not by model. */
interface RegistryEntry {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    model: string;
    lineageKey: string;
    role: AgentRole;
    inputTokens: number;
    hasCacheControl: boolean;
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
export declare function detectCacheTtlFromBody(body: unknown): {
    minTtlMs: number | null;
    hasAnyCacheControl: boolean;
};
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
export declare function upgradeCacheControlTtl(body: unknown): {
    upgraded: number;
};
export declare class KeepaliveEngine {
    private cacheTtlMs;
    /**
     * When the consumer passes `config.cacheTtlMs` to the constructor, we LOCK
     * the TTL to that value and stop honoring SSOT live-reload AND wire-autoscan
     * for it. This is the "admin pinned" escape hatch — explicit caller wins.
     * See KeepaliveConfig.cacheTtlMs (types.ts) for full rationale.
     */
    private readonly cacheTtlOverridden;
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
    private cacheTtlObservedLocked;
    private safetyMarginMs;
    private readonly retryDelaysMs;
    private readonly healthProbeIntervalsMs;
    private readonly healthProbeTimeoutMs;
    private static readonly SNAPSHOT_TTL_MS;
    private static readonly DUMP_BODY;
    private config;
    /** Last observed wire cache_control min-TTL (ms). null = none seen yet / no markers. */
    private lastObservedTtlMs;
    /** True once the first TTL scan has run — distinguishes "never seen" from "seen null". */
    private ttlEverObserved;
    private readonly getToken;
    private readonly doFetch;
    private readonly getRateLimitInfo;
    private readonly isOwnerAlive;
    /** Shared cross-engine eviction breaker (null in single-session SDK use). */
    private readonly evictionBreaker;
    private lastKnownCacheTokensByModel;
    private networkState;
    private healthProbeTimer;
    private healthProbeAttempt;
    private registry;
    private lastSnapshots;
    private selfHealEligible;
    private pendingSnapshots;
    private lineageStats;
    private orgSwitchPending;
    /** Test accessor. */
    get _orgSwitchPending(): Set<string>;
    private _legacyPendingLineage;
    private lastActivityAt;
    private lastRealActivityAt;
    private cacheWrittenAt;
    private timer;
    private retryTimer;
    private abortController;
    private inFlight;
    /** Lineage of the KA fire currently in flight — so a real request of a
     *  DIFFERENT lineage does not abort it (master-warm-while-sub-agents-run). */
    private inFlightLineageKey;
    private jitterMs;
    private quotaPauseTimer;
    private quotaPauseUntil;
    private snapshotCallCount;
    constructor(opts: KeepaliveEngineOptions);
    /**
     * Call at the top of every real request. Primes the pending snapshot slot
     * with the body/headers about to be sent, and aborts any in-flight KA.
     */
    notifyRealRequestStart(model: string, body: Record<string, unknown>, headers: Record<string, string>): string;
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
    notifyRealRequestComplete(usage: TokenUsage, lineageKeyArg?: string): void;
    /** Flag a lineage as awaiting the user's org-switch decision. While set, the
     *  KA fire replays the snapshot's own (old-org) Authorization to keep the OLD
     *  cache warm. Called by ProxyClient when an org-switch rewrite is blocked. */
    markOrgSwitchPending(lineageKeyArg: string): void;
    /** Clear the org-switch-pending flag for a lineage. */
    clearOrgSwitchPending(lineageKeyArg: string): void;
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
    checkRewriteGuard(model: string): void;
    /** Full shutdown — clears all timers, aborts in-flight. */
    stop(): void;
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
    disarm(reason: string): void;
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
    reload(reason: string): void;
    private startTimer;
    private tick;
    /**
     * Diagnostic logger — call BEFORE registry.clear() to capture exact
     * state at the moment of disarm. Enables post-mortem analysis without
     * needing to reproduce the incident.
     *
     * Writes to claude-max-debug.log with grep-friendly tag KA_CLEAR_DIAG.
     * Includes every variable that gates a clear() decision.
     */
    private logClearDiag;
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
    private handleQuotaRateLimit;
    /**
     * Wake from quota-pause early. Called from notifyRealRequestStart: if a real
     * user request arrived, upstream is reachable from the consumer side, so
     * either quota has recovered or the consumer will get a fresh 429 themselves
     * (and we'll re-enter pause on next KA attempt). Either way: clear the
     * pause and resume normal cadence.
     */
    private wakeFromQuotaPause;
    /**
     * Dedicated retry chain for transient keepalive failures.
     * Uses setTimeout with exact delays from cacheWrittenAt — no drift.
     */
    private retryChain;
    /**
     * Called when KA fire logic decides to "disarm" (stop firing) without
     * killing the interval timer. Timer remains cheap+unref'd, becomes no-op
     * with empty registry, and auto-resumes on next real request.
     */
    private onDisarmed;
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
    private startHealthProbe;
    private stopHealthProbe;
    /**
     * Sink for fire-and-forget async rejections. A `void this.tick()` /
     * `void probe()` that rejects (e.g. a transient null-deref or upstream
     * throw during network recovery) would otherwise surface as a global
     * `unhandledRejection` with no stack and no context. Route it here so it
     * is contained + diagnosable instead of polluting the process-level handler.
     */
    private logAsyncReject;
    private writeSnapshotDebug;
    /** @internal — for test inspection */
    get _registry(): ReadonlyMap<string, RegistryEntry>;
    /** @internal — drive one tick directly (tests only). */
    _tick(): Promise<void>;
    /** @internal — per-lineage idle clocks (for tests). */
    get _lineageStats(): ReadonlyMap<string, {
        lastSeenAt: number;
        lastWarmedAt: number;
    }>;
    /** @internal — for test inspection */
    get _timer(): ReturnType<typeof setInterval> | null;
    /** @internal — for test inspection */
    get _config(): Required<Pick<KeepaliveConfig, "enabled" | "intervalMs" | "rewriteWarnIdleMs" | "rewriteWarnTokens" | "idleTimeoutMs" | "minTokens" | "rewriteBlockEnabled" | "rewriteBlockIdleMs">> & {
        onHeartbeat?: (stats: KeepaliveStats) => void;
        onTick?: (tick: KeepaliveTick) => void;
        onDisarmed?: (info: {
            reason: string;
            at: number;
        }) => void;
        onRewriteWarning?: (info: {
            idleMs: number;
            estimatedTokens: number;
            blocked: boolean;
            model: string;
        }) => void;
        onNetworkStateChange?: (info: {
            from: string;
            to: string;
            at: number;
        }) => void;
        onTtlScan?: (info: {
            minTtlMs: number | null;
            previousTtlMs: number | null;
            hasAnyCacheControl: boolean;
            at: number;
        }) => void;
        onRegistryChange?: () => void;
    };
    /** @internal — for test inspection (per-consumer override audit) */
    get _cacheTtlMs(): number;
    get _cacheTtlOverridden(): boolean;
    get _cacheTtlObservedLocked(): boolean;
    /** @internal — for test inspection */
    get _lastKnownCacheTokensByModel(): ReadonlyMap<string, number>;
    /** @internal — mutable internal state getters/setters for test inspection */
    _setLastRealActivityAt(v: number): void;
    _setCacheWrittenAt(v: number): void;
    get _cacheWrittenAt(): number;
    _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void;
    /** @internal — for test inspection (smart-pause state) */
    get _quotaPauseTimer(): ReturnType<typeof setTimeout> | null;
    get _quotaPauseUntil(): number | null;
    /** @internal — for test invocation of the smart-pause handler */
    _testHandleQuotaRateLimit(entry: {
        body: Record<string, unknown>;
        headers: Record<string, string>;
        model: string;
        inputTokens: number;
        lineageKey: string;
    }, err: {
        resetAt?: number | null;
        retryAfterSec?: number | null;
    }): void;
    /** Notify the consumer (best-effort) that the KA registry was mutated —
     *  used to trigger cross-restart persistence. Never throws. */
    private notifyRegistryChanged;
    /** Clear the registry + notify — the disarm/reload/evict mutation path. */
    private clearRegistry;
    /**
     * Self-heal: re-prime the registry from the last-known snapshots when a LIVE
     * idle session's snapshot was dropped by a re-primeable clear (reload). Gated
     * so a dead (PID gone) or expired (cache past TTL) session is never
     * resurrected. Returns true if it re-primed. Called from tick() when the
     * registry is empty.
     */
    private trySelfHeal;
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
    revive(state: PersistedEngineState): void;
    /**
     * Serialise the armed state for cross-restart persistence (see
     * ka-snapshot-store.ts). Returns `null` when the engine holds no snapshot
     * worth persisting (registry empty — disarmed or never armed). Never throws.
     */
    serializeState(): PersistedEngineState | null;
}
export {};
//# sourceMappingURL=keepalive-engine.d.ts.map