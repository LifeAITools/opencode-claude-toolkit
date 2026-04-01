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
export interface OAuthLoginOptions {
    /** Where to save credentials. Default: ~/.claude/.credentials.json */
    credentialsPath?: string;
    /** Port for localhost callback. Default: 0 (OS-assigned) */
    port?: number;
    /** Callback when the auth URL is ready — display to user. If not provided, prints to stdout. */
    onAuthUrl?: (url: string, manualUrl: string) => void;
    /** Try to open browser automatically. Default: true */
    openBrowser?: boolean;
}
export interface OAuthResult {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    credentialsPath: string;
}
export declare function oauthLogin(options?: OAuthLoginOptions): Promise<OAuthResult>;
//# sourceMappingURL=auth.d.ts.map