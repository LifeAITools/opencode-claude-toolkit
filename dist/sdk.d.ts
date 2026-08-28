import type { ClaudeCodeSDKOptions, CredentialStore, StoredCredentials, GenerateOptions, GenerateResponse, StreamEvent, RateLimitInfo } from "./types.js";
export declare class ClaudeCodeSDK {
    private accessToken;
    private refreshToken;
    private expiresAt;
    private credentialStore;
    private tokenRotation;
    private sessionId;
    private deviceId;
    private accountUuid;
    private timeout;
    private maxRetries;
    private lastRateLimitInfo;
    private pending401;
    private lastFailedToken;
    private pendingAuth;
    private initialLoad;
    private tokenRotationTimer;
    private lastRefreshAttemptAt;
    private refreshConsecutive429s;
    private proactiveRefreshFailures;
    private tokenIssuedAt;
    private onTokenStatus;
    private keepalive;
    private _lastStreamUsage;
    constructor(options?: ClaudeCodeSDKOptions);
    close(): void;
    generate(options: GenerateOptions): Promise<GenerateResponse>;
    stream(options: GenerateOptions): AsyncGenerator<StreamEvent>;
    getRateLimitInfo(): RateLimitInfo;
    private doStreamRequest;
    private parseSSE;
    stopKeepalive(): void;
    private buildHeaders;
    private buildRequestBody;
    private addCacheMarkers;
    private buildBetas;
    private ensureAuth;
    private _doEnsureAuth;
    private loadFromStore;
    private isTokenExpired;
    forceRefreshToken(): Promise<boolean>;
    forceReLogin(): Promise<boolean>;
    getTokenHealth(): {
        expiresAt: number | null;
        expiresInMs: number;
        lifetimePct: number;
        failedRefreshes: number;
        status: "healthy" | "warning" | "critical" | "expired" | "unknown";
    };
    getTokenHealthAsync(): Promise<{
        expiresAt: number | null;
        expiresInMs: number;
        lifetimePct: number;
        failedRefreshes: number;
        status: "healthy" | "warning" | "critical" | "expired" | "unknown";
    }>;
    private scheduleProactiveRotation;
    private proactiveRefresh;
    private emitTokenStatus;
    private isRefreshOnCooldown;
    private setRefreshCooldown;
    private clearRefreshCooldown;
    private dbg;
    private refreshTokenWithTripleCheck;
    handleAuth401(): Promise<void>;
    private doTokenRefresh;
    private assembleResponse;
    private parseRateLimitHeaders;
    private getRetryDelay;
    private sleep;
    private computeFingerprint;
    private readAccountUuid;
}
export declare class FileCredentialStore implements CredentialStore {
    readonly path: string;
    private lastMtimeMs;
    constructor(path: string);
    read(): Promise<StoredCredentials | null>;
    write(credentials: StoredCredentials): Promise<void>;
    hasChanged(): Promise<boolean>;
    private getMtime;
}
export declare class MemoryCredentialStore implements CredentialStore {
    private credentials;
    constructor(initial: StoredCredentials);
    read(): Promise<StoredCredentials | null>;
    write(credentials: StoredCredentials): Promise<void>;
}
