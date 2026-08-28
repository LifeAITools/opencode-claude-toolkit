import type { CredentialStore, StoredCredentials } from "./types.js";
import type { ResolvedKeepaliveConfig } from "./keepalive-config.js";
export interface TokenRotatedPayload {
    pid: number;
    spawnDepth: number;
    sessionId: string | null;
    oldHint: string;
    newHint: string;
    oldOrgId: string | null;
    newOrgId: string | null;
    contextTokens: number | null;
    mode: "applied" | "deferred" | "forced" | "same-org";
    appliedAt: "immediate" | "turn-boundary" | "context-drop" | "forced-expired" | null;
    forcedReason: "old-token-expired" | "old-refresh-failed" | "old-api-rejected" | null;
    detectedAt: string;
}
export interface PendingRotation {
    oldHint: string;
    newHint: string;
    oldOrgId: string | null;
    newOrgId: string | null;
    detectedAt: number;
}
export type CheckPendingResult = {
    action: "apply-now";
    credentials: StoredCredentials;
    mode: "applied" | "forced" | "same-org";
    forcedReason?: "old-token-expired" | "old-refresh-failed" | "old-api-rejected";
} | {
    action: "continue-with-old";
    pending: PendingRotation;
} | {
    action: "no-pending";
};
export declare class TokenRotationManager {
    private credentialStore;
    private contextTokensProvider;
    private getConfig;
    private pendingRotation;
    private orgIdCache;
    private watcher;
    private pollTimer;
    private closed;
    private eventEmitter;
    private lastSeenHint;
    private contextProviderThrew;
    private appendCallCount;
    constructor(credentialStore: CredentialStore, contextTokensProvider: (() => number | null) | undefined, getConfig: () => Pick<ResolvedKeepaliveConfig, "tokenRotationContextThreshold" | "tokenRotationPollIntervalMs" | "orgIdCacheTtlMs" | "tokenRotationLogMaxBytes" | "tokenRotationLogRetentionDays">);
    checkPending(): Promise<CheckPendingResult>;
    applyPending(reason: "turn-boundary" | "context-drop" | "forced-expired", forcedReason?: "old-token-expired" | "old-refresh-failed" | "old-api-rejected"): Promise<void>;
    hasPending(): boolean;
    setEventEmitter(emit: (payload: TokenRotatedPayload) => void): void;
    close(): void;
    private startWatcher;
    private startPollFallback;
    private detectRotation;
    private extractOrgId;
    private getCachedOrgId;
    private appendRotationLog;
    private maybeRotateLog;
    private emitEvent;
    private logBestEffort;
}
