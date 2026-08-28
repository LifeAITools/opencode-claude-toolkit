import { type RoleWeights } from "./lineage.js";
export interface DumpConfig {
    readonly enabled: boolean;
    readonly initialCalls: number;
    readonly ringRetentionMs: number;
    readonly ringMaxMb: number;
    readonly suspiciousContextSize: number;
    readonly suspiciousRetentionMs: number;
    readonly suspiciousMaxMb: number;
    readonly coldCwThreshold: number;
    readonly metadataRetentionMs: number;
}
export interface ResolvedKeepaliveConfig {
    readonly cacheTtlMs: number;
    readonly safetyMarginMs: number;
    readonly intervalMs: number;
    readonly intervalClampMin: number;
    readonly intervalClampMax: number;
    readonly retryDelaysMs: readonly number[];
    readonly rewriteWarnIdleMs: number;
    readonly rewriteWarnTokens: number;
    readonly healthProbeIntervalsMs: readonly number[];
    readonly healthProbeTimeoutMs: number;
    readonly enabled: boolean;
    readonly idleTimeoutMs: number;
    readonly minTokens: number;
    readonly maxFiresPerTick: number;
    readonly maxWarmLineagesPerSession: number;
    readonly rewriteBlockEnabled: boolean;
    readonly dump: DumpConfig;
    readonly roleDetector: RoleWeights;
    readonly rewriteGuard: RewriteGuardConfig;
    readonly tokenRotationContextThreshold: number;
    readonly tokenRotationPollIntervalMs: number;
    readonly orgIdCacheTtlMs: number;
    readonly tokenRotationLogMaxBytes: number;
    readonly tokenRotationLogRetentionDays: number;
    readonly _source: "defaults" | "file" | "mixed";
}
export interface RewriteGuardConfig {
    readonly enabled: boolean;
    readonly minRewriteTokens: number;
    readonly minColdStartTokens: number;
    readonly overrideMarker: string;
    readonly reloadMarker: string;
    readonly dumpBlocked: boolean;
    readonly interactiveOnly: boolean;
    readonly consentGrantTtlSec: number;
    readonly consentGrantPath: string;
}
export declare const RECOMMENDED_1H_CONFIG: {
    readonly cacheTtlSec: 3600;
    readonly safetyMarginSec: 60;
    readonly intervalSec: 1800;
    readonly retryDelaysSec: readonly [
        2,
        3,
        5,
        10,
        15,
        20,
        30,
        60,
        120,
        300
    ];
};
export declare function loadKeepaliveConfig(): ResolvedKeepaliveConfig;
export declare function reloadKeepaliveConfig(): ResolvedKeepaliveConfig;
export declare function _resolve(raw: Record<string, unknown> | null): ResolvedKeepaliveConfig;
export declare function getConfigPath(): string;
export declare function getCacheTtlMs(): number;
export declare function getSafetyMarginMs(): number;
