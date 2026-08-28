export declare function getClaudeConfigDir(): string;
export declare function getDefaultCredentialsPath(): string;
export interface OAuthLoginOptions {
    credentialsPath?: string;
    port?: number;
    onAuthUrl?: (url: string, manualUrl: string) => void;
    openBrowser?: boolean;
    loginWithClaudeAi?: boolean;
    loginHint?: string;
    loginMethod?: string;
    orgUUID?: string;
}
export interface OAuthResult {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    credentialsPath: string;
}
export declare function oauthLogin(options?: OAuthLoginOptions): Promise<OAuthResult>;
export interface ClaudeAiOAuthCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
}
export declare function readClaudeCredentials(credPath?: string): {
    claudeAiOauth?: ClaudeAiOAuthCredentials;
    [k: string]: unknown;
} | null;
export declare function writeClaudeCredentials(credPath: string, oauth: ClaudeAiOAuthCredentials): void;
export interface RefreshedTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
}
export declare class OAuthRefreshError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string);
    get isInvalidGrant(): boolean;
}
export declare function refreshOAuthToken(refreshToken: string): Promise<RefreshedTokens>;
