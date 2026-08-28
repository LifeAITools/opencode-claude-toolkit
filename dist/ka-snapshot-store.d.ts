export declare const KA_SNAPSHOT_SCHEMA_VERSION = 1;
export declare const DEFAULT_KA_SNAPSHOT_PATH: string;
export declare const KA_SNAPSHOT_MAX_AGE_MS: number;
export interface PersistedRegistryEntry {
    body: Record<string, unknown> | string;
    headers: Record<string, string>;
    model: string;
    lineageKey: string;
    role: string;
    inputTokens: number;
    hasCacheControl: boolean;
}
export interface PersistedEngineState {
    cacheWrittenAt: number;
    cacheTtlMs: number;
    cacheTtlOverridden: boolean;
    cacheTtlObservedLocked: boolean;
    lastObservedTtlMs: number | null;
    ttlEverObserved: boolean;
    lastKnownCacheTokensByModel: Record<string, number>;
    registry: PersistedRegistryEntry[];
}
export interface PersistedSession extends PersistedEngineState {
    sessionId: string;
    ownerPid: number | null;
    model: string | null;
    orgId: string | null;
}
export interface KaSnapshotFile {
    version: number;
    savedAt: number;
    sessions: Record<string, PersistedSession>;
}
export declare function loadKaSnapshots(path: string): KaSnapshotFile;
export declare function saveKaSnapshots(sessions: Record<string, PersistedSession>, path: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export type RevivalDropReason = "no-snapshot" | "too-old" | "cache-already-dead" | "cache-dies-before-ka" | "owner-dead";
export type RevivalVerdict = {
    revive: true;
} | {
    revive: false;
    reason: RevivalDropReason;
};
export interface RevivalAssessmentOpts {
    safetyMarginMs: number;
    intervalMs: number;
    maxAgeMs: number;
    fireBudgetMs: number;
}
export declare function assessRevival(s: PersistedEngineState, now: number, opts: RevivalAssessmentOpts): RevivalVerdict;
