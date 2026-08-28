import type { KeepaliveConfig, KeepaliveStats, KeepaliveTick, RateLimitInfo, StreamEvent, TokenUsage } from "./types.js";
export interface KeepaliveEngineOptions {
    config?: KeepaliveConfig;
    getToken: () => Promise<string>;
    onAuthError?: (failedAccessToken: string) => Promise<void>;
    doFetch: (body: Record<string, unknown>, headers: Record<string, string>, signal?: AbortSignal) => AsyncGenerator<StreamEvent>;
    getRateLimitInfo: () => RateLimitInfo;
    isOwnerAlive?: () => boolean;
    evictionBreaker?: EvictionCircuitBreaker;
}
import { type AgentRole } from "./lineage.js";
import type { PersistedEngineState } from "./ka-snapshot-store.js";
import type { EvictionCircuitBreaker } from "./eviction-breaker.js";
export declare const RUNTIME_IDENTITY: string;
interface RegistryEntry {
    body: string;
    headers: Record<string, string>;
    model: string;
    lineageKey: string;
    role: AgentRole;
    inputTokens: number;
    hasCacheControl: boolean;
    provenAlive: boolean;
    lastFireColdWrote: boolean;
}
export declare function stripCredentials(headers: Record<string, string>): Record<string, string>;
export declare function detectCacheTtlFromBody(body: unknown): {
    minTtlMs: number | null;
    hasAnyCacheControl: boolean;
};
export declare function upgradeCacheControlTtl(body: unknown): {
    upgraded: number;
};
export declare class KeepaliveEngine {
    private cacheTtlMs;
    private readonly cacheTtlOverridden;
    private cacheTtlObservedLocked;
    private safetyMarginMs;
    private readonly retryDelaysMs;
    private readonly healthProbeIntervalsMs;
    private readonly healthProbeTimeoutMs;
    private static readonly SNAPSHOT_TTL_MS;
    private static readonly DUMP_BODY;
    private config;
    private lastObservedTtlMs;
    private ttlEverObserved;
    private readonly getToken;
    private readonly onAuthError?;
    private readonly doFetch;
    private readonly getRateLimitInfo;
    private readonly isOwnerAlive;
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
    get _orgSwitchPending(): Set<string>;
    private _legacyPendingLineage;
    private lastActivityAt;
    private lastRealActivityAt;
    private cacheWrittenAt;
    private rearmDelaysMs;
    private rearmEndgameWindowMs;
    private rearmEndgameIntervalMs;
    private rearmFinalWindowMs;
    private rearmFinalIntervalMs;
    private rearmSafeEdgeMs;
    private rearmAttempt;
    private rearmHoldUntil;
    private rearmTimer;
    private lastKaError;
    private timer;
    private retryTimer;
    private abortController;
    private inFlight;
    private inFlightLineageKey;
    private jitterMs;
    private quotaPauseTimer;
    private quotaPauseUntil;
    private evictionHoldTimer;
    private evictionHoldUntil;
    private snapshotCallCount;
    private lastFireToken;
    constructor(opts: KeepaliveEngineOptions);
    notifyRealRequestStart(model: string, body: Record<string, unknown>, headers: Record<string, string>): string;
    notifyRealRequestComplete(usage: TokenUsage, lineageKeyArg?: string): void;
    markOrgSwitchPending(lineageKeyArg: string): void;
    clearOrgSwitchPending(lineageKeyArg: string): void;
    clearAllOrgSwitchPending(): number;
    get _hasOrgSwitchPending(): (lineageKey: string) => boolean;
    private thawOrgSwitchPendingOnAuth;
    checkRewriteGuard(model: string): void;
    hasWarmLineage(lineageKeyArg: string): boolean;
    stop(): void;
    disarm(reason: string): void;
    reload(reason: string): void;
    private startTimer;
    private tick;
    private runAuthErrorBackstop;
    private fireLineage;
    private logClearDiag;
    private handleQuotaRateLimit;
    private handleEvictionBreakerTripped;
    private wakeFromEvictionHold;
    private wakeFromQuotaPause;
    private retryChain;
    private onDisarmed;
    private scheduleRearm;
    private resetRearmState;
    private noteKaError;
    private startHealthProbe;
    private stopHealthProbe;
    private logAsyncReject;
    private buildSnapshotMeta;
    private writeSnapshotDebug;
    get _registry(): ReadonlyMap<string, RegistryEntry>;
    _tick(): Promise<void>;
    get _lineageStats(): ReadonlyMap<string, {
        lastSeenAt: number;
        lastWarmedAt: number;
    }>;
    get _timer(): ReturnType<typeof setInterval> | null;
    get _config(): Required<Pick<KeepaliveConfig, "enabled" | "intervalMs" | "rewriteWarnIdleMs" | "rewriteWarnTokens" | "idleTimeoutMs" | "minTokens" | "maxFiresPerTick" | "rewriteBlockEnabled" | "rewriteBlockIdleMs">> & {
        onHeartbeat?: (stats: KeepaliveStats) => void;
        onTick?: (tick: KeepaliveTick) => void;
        onDisarmed?: (info: {
            reason: string;
            at: number;
            errStatus?: number | null;
            errMessage?: string | null;
        }) => void;
        onHeld?: (info: {
            reason: string;
            at: number;
            holdMs: number;
            regSize: number;
        }) => void;
        onPartialRewrite?: (info: {
            lineageKey: string;
            cacheRead: number;
            cacheWrite: number;
            msSinceLastRealRequest: number;
            at: number;
        }) => void;
        onRewriteWarning?: (info: {
            idleMs: number;
            estimatedTokens: number;
            blocked: boolean;
            model: string;
        }) => void;
        onFireStart?: (info: {
            lineageKey: string;
            idleMs: number;
            at: number;
        }) => void;
        onFireError?: (info: {
            lineageKey: string;
            idleMs: number;
            status: number | null;
            category: string;
            message: string;
            durationMs: number;
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
    get _cacheTtlMs(): number;
    get _cacheTtlOverridden(): boolean;
    get _cacheTtlObservedLocked(): boolean;
    get _lastKnownCacheTokensByModel(): ReadonlyMap<string, number>;
    _setLastRealActivityAt(v: number): void;
    _setCacheWrittenAt(v: number): void;
    _setLineageRole(key: string, role: AgentRole): void;
    _ageLineages(ms: number): void;
    get _cacheWrittenAt(): number;
    get _safetyMarginMs(): number;
    get _intervalMs(): number;
    _setPendingSnapshot(model: string, body: Record<string, unknown>, headers: Record<string, string>): void;
    get _quotaPauseTimer(): ReturnType<typeof setTimeout> | null;
    get _quotaPauseUntil(): number | null;
    get _rearm(): {
        attempt: number;
        holdUntil: number;
        timerArmed: boolean;
    };
    _testHandleQuotaRateLimit(entry: {
        body: string;
        headers: Record<string, string>;
        model: string;
        inputTokens: number;
        lineageKey: string;
    }, err: {
        resetAt?: number | null;
        retryAfterSec?: number | null;
    }): void;
    private notifyRegistryChanged;
    private clearRegistry;
    private trySelfHeal;
    revive(state: PersistedEngineState): void;
    serializeState(): PersistedEngineState | null;
}
export {};
