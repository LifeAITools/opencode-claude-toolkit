import type { ClaudeCodeSDKOptions, CredentialStore, StoredCredentials, GenerateOptions, GenerateResponse, StreamEvent, RateLimitInfo } from './types.js';
export declare class ClaudeCodeSDK {
    private accessToken;
    private refreshToken;
    private expiresAt;
    private credentialStore;
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
    private keepaliveConfig;
    private keepaliveRegistry;
    private _pendingSnapshotModel;
    private _pendingSnapshotBody;
    private _pendingSnapshotHeaders;
    private keepaliveLastActivityAt;
    private keepaliveTimer;
    private keepaliveAbortController;
    private keepaliveInFlight;
    private keepaliveJitterMs;
    private keepaliveCacheWrittenAt;
    private keepaliveRetryTimer;
    private keepaliveLastRealActivityAt;
    private cacheAnchorMessageCount;
    constructor(options?: ClaudeCodeSDKOptions);
    /** Non-streaming: send messages, get full response */
    generate(options: GenerateOptions): Promise<GenerateResponse>;
    /** Streaming: yields events as they arrive from SSE */
    stream(options: GenerateOptions): AsyncGenerator<StreamEvent>;
    getRateLimitInfo(): RateLimitInfo;
    private doStreamRequest;
    private parseSSE;
    private onStreamComplete;
    private static readonly SNAPSHOT_TTL_MS;
    private static readonly DUMP_BODY;
    private snapshotCallCount;
    private writeSnapshotDebug;
    private startKeepaliveTimer;
    private static readonly CACHE_TTL_MS;
    private keepaliveTick;
    private static readonly KEEPALIVE_RETRY_DELAYS;
    /**
     * Dedicated retry chain for transient keepalive failures.
     * Uses setTimeout with exact delays from a fixed timestamp — no drift, no timer reuse.
     * Checks remaining cache TTL before each attempt to avoid wasting a request on expired cache.
     */
    private keepaliveRetryChain;
    stopKeepalive(): void;
    /** HTTP headers — mimics getAnthropicClient() + getAuthHeaders() */
    private buildHeaders;
    /** Request body — mirrors paramsFromContext() in claude.ts:1699 */
    private buildRequestBody;
    /** Add cache_control markers to system + messages — anchor-based strategy for keepalive compatibility.
     *
     * Anthropic prompt cache is PREFIX-based: each cache_control breakpoint creates a cached prefix entry.
     * A new request reads cache only if it has a breakpoint at the SAME position (same content prefix).
     *
     * Follows Claude Code's proven strategy (from claude.ts):
     *   BP1: system prompt — stable across sessions
     *   BP2: last tool definition — stable within session
     *   BP3: messages[-1] — ONE message marker only
     *
     * Why only 1 message marker (from Claude Code source):
     *   "Exactly one message-level cache_control marker per request. Mycro's
     *    turn-to-turn eviction frees local-attention KV pages at any cached prefix
     *    position NOT in cache_store_int_token_boundaries. With two markers the
     *    second-to-last position is protected and its locals survive an extra turn
     *    even though nothing will ever resume from there — with one marker they're
     *    freed immediately."
     *
     * Why no anchor persistence needed:
     *   Anthropic's cache AUTOMATICALLY reads ANY matching prefix, regardless of
     *   where the NEW marker is placed. Markers only control where NEW entries are WRITTEN.
     *   So: keepalive writes cache at msg[K]. Next real request has marker at msg[K+2].
     *   API finds cached prefix [sys..msg[K]] → reads it → only processes msg[K+1..K+2].
     */
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
    private _doEnsureAuth;
    /** Load credentials from the credential store */
    private loadFromStore;
    /** 5-minute buffer before actual expiry — from oauth/client.ts:344-353 */
    private isTokenExpired;
    /**
     * Force an immediate token refresh (like what happens automatically).
     * Use when you know the token is stale or as a manual recovery.
     * Returns true on success, false on failure.
     */
    forceRefreshToken(): Promise<boolean>;
    /**
     * Trigger a full browser-based OAuth re-login flow.
     * Use as last resort when refresh_token itself is dead.
     * Imports and calls oauthLogin() from auth.ts.
     * Returns true on success (new tokens saved), false on failure/timeout.
     */
    forceReLogin(): Promise<boolean>;
    /**
     * Get current token health info — useful for UI status indicators.
     * Note: if called immediately after construction, tokens may still be loading.
     * Use the async version getTokenHealthAsync() for guaranteed data.
     */
    getTokenHealth(): {
        expiresAt: number | null;
        expiresInMs: number;
        lifetimePct: number;
        failedRefreshes: number;
        status: 'healthy' | 'warning' | 'critical' | 'expired' | 'unknown';
    };
    /** Async version — awaits initial token load before returning health. */
    getTokenHealthAsync(): Promise<{
        expiresAt: number | null;
        expiresInMs: number;
        lifetimePct: number;
        failedRefreshes: number;
        status: 'healthy' | 'warning' | 'critical' | 'expired' | 'unknown';
    }>;
    /**
     * Schedule a background refresh at ~50% of token lifetime.
     * With ~11h tokens, fires at ~5.5h — leaving 5.5h for retries.
     * Emits escalating warnings as token approaches expiry.
     */
    private scheduleProactiveRotation;
    /**
     * Background refresh — runs silently, never throws.
     * Emits escalating status events on failure.
     * On permanent failure: emits 'expired' so UI can trigger re-login.
     */
    private proactiveRefresh;
    private emitTokenStatus;
    private isRefreshOnCooldown;
    private setRefreshCooldown;
    private clearRefreshCooldown;
    private dbg;
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
    /** POST to platform.claude.com/v1/oauth/token — from oauth/client.ts:146
     *
     * Retry with backoff on 429/5xx (mirrors Claude Code's lockfile + triple-check pattern).
     * Multiple opencode sessions may try to refresh simultaneously — the first to succeed
     * writes to the credential store, others detect the fresh token on retry.
     *
     * @param force — if true, skip "already fresh" checks and always call the token endpoint.
     *   Used by proactive rotation to actually get a NEW token before the old one expires.
     */
    private doTokenRefresh;
    private assembleResponse;
    private parseRateLimitHeaders;
    private getRetryDelay;
    private sleep;
    /**
     * Compute message fingerprint — matches CC's computeFingerprintFromMessages().
     * Extracts chars at indices [4,7,20] from first user message, SHA256 with salt.
     * Returns 3-char hex string used in cc_version billing header.
     */
    private computeFingerprint;
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