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
}
export declare class KeepaliveEngine {
    private static readonly CACHE_TTL_MS;
    private static readonly KEEPALIVE_RETRY_DELAYS;
    private static readonly SNAPSHOT_TTL_MS;
    private static readonly DUMP_BODY;
    private static readonly HEALTH_PROBE_INTERVAL_MS;
    private static readonly HEALTH_PROBE_TIMEOUT_MS;
    private config;
    private readonly getToken;
    private readonly doFetch;
    private readonly getRateLimitInfo;
    private lastKnownCacheTokensByModel;
    private networkState;
    private healthProbeTimer;
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
     *   - If gap > warnIdleMs AND estimated cache size > warnTokens → warning callback
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
    get _config(): Required<Pick<KeepaliveConfig, "enabled" | "intervalMs" | "idleTimeoutMs" | "minTokens" | "rewriteWarnIdleMs" | "rewriteWarnTokens" | "rewriteBlockIdleMs" | "rewriteBlockEnabled">> & {
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
    _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void;
}
//# sourceMappingURL=keepalive-engine.d.ts.map