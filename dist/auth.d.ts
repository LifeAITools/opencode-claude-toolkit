/**
 * OAuth 2.0 Authorization Code + PKCE flow for Claude.
 *
 * Mirrors the Claude Code CLI OAuth implementation:
 * - Generates PKCE code_verifier + challenge (S256)
 * - Opens browser to Anthropic's auth page
 * - Listens on localhost for callback with auth code
 * - Exchanges code for access/refresh tokens
 * - Saves credentials to .credentials.json
 *
 * Usage:
 *   const creds = await oauthLogin({ credentialsPath: '~/.claude/.credentials.json' })
 */
export declare function getClaudeConfigDir(): string;
export declare function getDefaultCredentialsPath(): string;
export interface OAuthLoginOptions {
    /** Where to save credentials. Default: ~/.claude/.credentials.json */
    credentialsPath?: string;
    /** Port for localhost callback. Default: 0 (OS-assigned) */
    port?: number;
    /** Callback when the auth URL is ready — display to user. If not provided, prints to stdout. */
    onAuthUrl?: (url: string, manualUrl: string) => void;
    /** Try to open browser automatically. Default: true */
    openBrowser?: boolean;
    /** Prefer Claude.ai personal login route (better for Pro/Max users). Default: true */
    loginWithClaudeAi?: boolean;
    /** Optional login hint (email) */
    loginHint?: string;
    /** Optional login method hint (e.g. sso, google, magic_link) */
    loginMethod?: string;
    /** Optional organization UUID for enterprise flows */
    orgUUID?: string;
}
export interface OAuthResult {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    credentialsPath: string;
}
export declare function oauthLogin(options?: OAuthLoginOptions): Promise<OAuthResult>;
/** The `claudeAiOauth` block persisted in `~/.claude/.credentials.json`. */
export interface ClaudeAiOAuthCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
}
/**
 * Read the raw `.credentials.json` file. Returns the parsed object (with an
 * optional `claudeAiOauth` block) or `null` when the file is missing/malformed.
 * Fail-soft, never throws.
 */
export declare function readClaudeCredentials(credPath?: string): {
    claudeAiOauth?: ClaudeAiOAuthCredentials;
    [k: string]: unknown;
} | null;
/**
 * Atomically persist the `claudeAiOauth` block into `.credentials.json`
 * (tmp+rename + chmod 0600), merging into any existing top-level keys and
 * preserving `subscriptionType`/`rateLimitTier` when the fresh grant returns
 * null for them — byte-for-byte the native CLI's `saveOAuthTokensIfNeeded`
 * preserve-on-null contract (`claude-code-source/src/utils/auth.ts:1217`).
 *
 * The atomic tmp+rename is strictly SAFER than the native in-place write:
 * a concurrent reader (native CLI, opencode) never observes a torn file.
 * Callers that co-write the ACTIVE org MUST hold the config-dir lock
 * (see config-dir-lock.ts) so this write is serialized with the native CLI's
 * own refresh (`lockfile.lock(claudeDir)`).
 */
export declare function writeClaudeCredentials(credPath: string, oauth: ClaudeAiOAuthCredentials): void;
/** Result of a refresh-token grant. The refresh token ROTATES — the caller
 *  MUST persist the new one immediately or the org's credential line dies. */
export interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    /** Scopes returned by the grant (Anthropic allows scope expansion on refresh). */
    scopes?: string[];
}
/**
 * A refresh-token grant that failed at the HTTP layer. Carries the status +
 * body so the caller can distinguish a REVOKED grant (`400/401 invalid_grant`
 * → the org needs a fresh `claude login`, stop re-forcing) from transient
 * network/5xx noise (keep the entry + retry). Mirrors the expiry-vs-revoke
 * classification the KA force-on-401 backstop needs (architect-review H3).
 */
export declare class OAuthRefreshError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string);
    /** A revoked / no-longer-valid refresh_token — re-login required, not retryable. */
    get isInvalidGrant(): boolean;
}
/**
 * Exchange a refresh token for a fresh access token (standard OAuth
 * `refresh_token` grant against the same TOKEN_URL/CLIENT_ID as login).
 *
 * Pure network call — does NOT itself touch `~/.claude/.credentials.json`.
 * Persistence is the caller's job and depends on WHICH org this is:
 *   - the ACTIVE org co-writes `.credentials.json` under the native CLI's
 *     config-dir `proper-lockfile` lock (proxy-client `withFreshOrgToken`),
 *     because that file is the native CLI's source of truth and Anthropic
 *     rotates the refresh_token on every grant — writing only the vault would
 *     strand the disk token for the native CLI + every other consumer;
 *   - a non-active VAULT org persists into the per-org `OrgVault` instead.
 * Throws `OAuthRefreshError` (with .status/.isInvalidGrant) on HTTP failure so
 * the caller can distinguish a revoke from transient noise.
 */
export declare function refreshOAuthToken(refreshToken: string): Promise<RefreshedTokens>;
//# sourceMappingURL=auth.d.ts.map