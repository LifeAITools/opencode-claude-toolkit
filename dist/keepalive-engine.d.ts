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
}
export declare class KeepaliveEngine {
    private readonly cacheTtlMs;
    private readonly safetyMarginMs;
    private readonly retryDelaysMs;
    private readonly healthProbeIntervalsMs;
    private readonly healthProbeTimeoutMs;
    private static readonly SNAPSHOT_TTL_MS;
    private static readonly DUMP_BODY;
    private config;
    private readonly getToken;
    private readonly doFetch;
    private readonly getRateLimitInfo;
    private readonly isOwnerAlive;
    private lastKnownCacheTokensByModel;
    private networkState;
    private healthProbeTimer;
    private healthProbeAttempt;
    private registry;
    private _pendingSnapshotModel;
    private _pendingSnapshotBody;
    private _pendingSnapshotHeaders;
    private lastActivityAt;
    private lastRealActivityAt;
    private cacheWrittenAt;
    private timer;
    private retryTimer;
    private abortController;
    private inFlight;
    private jitterMs;
    private snapshotCallCount;
    constructor(opts: KeepaliveEngineOptions);
    /**
     * Call at the top of every real request. Primes the pending snapshot slot
     * with the body/headers about to be sent, and aborts any in-flight KA.
     */
    notifyRealRequestStart(model: string, body: Record<string, unknown>, headers: Record<string, string>): void;
    /**
     * Call after a real request completes successfully. Registers the pending
     * snapshot (heaviest-wins), updates activity timestamps, starts KA timer.
     */
    notifyRealRequestComplete(usage: TokenUsage): void;
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
    private startTimer;
    private tick;
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
    private writeSnapshotDebug;
    /** @internal — for test inspection */
    get _registry(): ReadonlyMap<string, {
        body: Record<string, unknown>;
        headers: Record<string, string>;
        model: string;
        inputTokens: number;
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
    };
    /** @internal — for test inspection */
    get _lastKnownCacheTokensByModel(): ReadonlyMap<string, number>;
    /** @internal — mutable internal state getters/setters for test inspection */
    _setLastRealActivityAt(v: number): void;
    _setCacheWrittenAt(v: number): void;
    get _cacheWrittenAt(): number;
    _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void;
}
//# sourceMappingURL=keepalive-engine.d.ts.map