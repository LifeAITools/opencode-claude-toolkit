import type { ClaudeCodeSDKOptions, CredentialStore, StoredCredentials, GenerateOptions, GenerateResponse, StreamEvent, RateLimitInfo } from './types.js';
export declare class ClaudeCodeSDK {
    private accessToken;
    private refreshToken;
    private expiresAt;
    private credentialStore;
    private sessionId;
    private deviceId;
    private accountUuid;
    private version;
    private timeout;
    private maxRetries;
    private lastRateLimitInfo;
    private pending401;
    private lastFailedToken;
    private keepaliveConfig;
    private keepaliveSnapshot;
    private keepaliveLastActivityAt;
    private keepaliveTimer;
    private keepaliveAbortController;
    private keepaliveInFlight;
    constructor(options?: ClaudeCodeSDKOptions);
    /** Non-streaming: send messages, get full response */
    generate(options: GenerateOptions): Promise<GenerateResponse>;
    /** Streaming: yields events as they arrive from SSE */
    stream(options: GenerateOptions): AsyncGenerator<StreamEvent>;
    getRateLimitInfo(): RateLimitInfo;
    private doStreamRequest;
    private parseSSE;
    private onStreamComplete;
    private startKeepaliveTimer;
    private keepaliveTick;
    stopKeepalive(): void;
    /** HTTP headers — mimics getAnthropicClient() + getAuthHeaders() */
    private buildHeaders;
    /** Request body — mirrors paramsFromContext() in claude.ts:1699 */
    private buildRequestBody;
    /** Add cache_control markers to system + last message — mirrors addCacheBreakpoints() */
    private addCacheMarkers;
    /** Beta headers — mirrors getAllModelBetas() in betas.ts:234 */
    private buildBetas;
    /**
     * Ensure valid auth token before API call.
     * Mirrors checkAndRefreshOAuthTokenIfNeeded() from auth.ts:1427.
     *
     * Triple-check pattern:
     * 1. Check cached token in memory
     * 2. If expired, check store (another process may have refreshed)
     * 3. If still expired, do the refresh
     */
    private ensureAuth;
    /** Load credentials from the credential store */
    private loadFromStore;
    /** 5-minute buffer before actual expiry — from oauth/client.ts:344-353 */
    private isTokenExpired;
    /**
     * Triple-check refresh — mirrors auth.ts:1472-1556.
     * Check store again (race), then refresh, then check store on error.
     */
    private refreshTokenWithTripleCheck;
    /**
     * Handle 401 error — mirrors handleOAuth401Error() from auth.ts:1338-1392.
     * Deduplicates concurrent 401 handlers for the same failed token.
     */
    handleAuth401(): Promise<void>;
    /** POST to platform.claude.com/v1/oauth/token — from oauth/client.ts:146 */
    private doTokenRefresh;
    computeFingerprint(messages: {
        role: string;
        content: string | unknown[];
    }[]): string;
    private hashFingerprint;
    private assembleResponse;
    private parseRateLimitHeaders;
    private getRetryDelay;
    private sleep;
    private readAccountUuid;
}
/**
 * File-based credential store with mtime detection.
 * Mirrors CLI's plainTextStorage.ts + invalidateOAuthCacheIfDiskChanged().
 */
export declare class FileCredentialStore implements CredentialStore {
    private path;
    private lastMtimeMs;
    constructor(path: string);
    read(): Promise<StoredCredentials | null>;
    write(credentials: StoredCredentials): Promise<void>;
    /** Detect cross-process changes via mtime — from auth.ts:1313-1336 */
    hasChanged(): Promise<boolean>;
    private getMtime;
}
/**
 * In-memory credential store for direct token injection.
 * No persistence — tokens live only in SDK instance.
 */
export declare class MemoryCredentialStore implements CredentialStore {
    private credentials;
    constructor(initial: StoredCredentials);
    read(): Promise<StoredCredentials | null>;
    write(credentials: StoredCredentials): Promise<void>;
}
//# sourceMappingURL=sdk.d.ts.map