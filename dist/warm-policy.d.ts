export type ProviderId = "anthropic" | "opencode-go" | string;
export interface WarmCadence {
    fireThresholdMs: number;
    safetyMarginMs: number;
    tickMs: number;
    idleTimeoutMs: number;
}
export interface WarmContext {
    provider: ProviderId;
    orgId: string | null;
    sessionId: string | null;
    idleMs: number;
    cacheAgeMs: number;
    realIdleMs: number;
    ttlMs: number;
    cadence: WarmCadence;
}
export type WarmDecision = {
    fire: true;
    reason: string;
} | {
    fire: false;
    release: boolean;
    reason: string;
};
export interface WarmPolicy {
    decide(ctx: WarmContext): WarmDecision;
}
export declare class SubscriptionCountersPolicy implements WarmPolicy {
    decide(ctx: WarmContext): WarmDecision;
}
