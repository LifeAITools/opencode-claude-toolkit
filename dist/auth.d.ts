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
/** Result of a refresh-token grant. The refresh token ROTATES — the caller
 *  MUST persist the new one immediately or the org's credential line dies. */
export interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
}
/**
 * Exchange a refresh token for a fresh access token (standard OAuth
 * `refresh_token` grant against the same TOKEN_URL/CLIENT_ID as login).
 *
 * Pure network call — does NOT touch `~/.claude/.credentials.json` (the
 * native CLI owns that file; the per-org vault persists these instead).
 * Throws on HTTP failure so the caller can distinguish "refresh denied"
 * (revoked grant → drop the vault entry) from network noise (keep + retry).
 */
export declare function refreshOAuthToken(refreshToken: string): Promise<RefreshedTokens>;
//# sourceMappingURL=auth.d.ts.map