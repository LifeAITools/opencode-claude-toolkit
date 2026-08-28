export declare function isServerSideEviction(p: {
    cacheWrite: number;
    cacheRead: number;
    msSinceLastRealRequest: number;
    intervalMs: number;
    cwThreshold?: number;
    crRatioMax?: number;
}): boolean;
export interface EvictionBreakerConfig {
    cooldownMs: number;
    minTripsToEngage?: number;
    windowMs?: number;
}
export interface EvictionTripMeta {
    sessionId?: string;
    lineageKey?: string;
    cacheWrite: number;
    cacheRead: number;
}
export declare function decideBreakerAction(p: {
    cooldownRemainingMs: number;
    cacheAgeMs: number;
    cacheTtlMs: number;
    safetyMarginMs: number;
}): "hold" | "disarm";
export type PostEvictionFate = "keep-warm" | "retire";
export declare function decidePostEvictionFate(p: {
    intervalMs: number;
    cacheTtlMs: number;
    safetyMarginMs: number;
    isMain: boolean;
}): PostEvictionFate;
export declare class EvictionCircuitBreaker {
    private readonly cooldownMs;
    private readonly minTripsToEngage;
    private readonly windowMs;
    private trips;
    constructor(cfg: EvictionBreakerConfig);
    trip(now: number, meta: EvictionTripMeta): void;
    isTripped(now: number): boolean;
    cooldownRemainingMs(now: number): number;
    tripCount(now: number): number;
    get lastTrippedAt(): number | null;
    get lastTrip(): EvictionTripMeta | null;
    private prune;
}
