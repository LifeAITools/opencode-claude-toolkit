/**
 * Pluggable credential storage interface.
 * Implement this to store tokens in a database, Redis, KV store, etc.
 * Mirrors CLI's SecureStorage pattern (plainTextStorage.ts).
 */
export interface CredentialStore {
    /** Read current credentials. Return null if not found. */
    read(): Promise<StoredCredentials | null>;
    /** Write updated credentials after refresh. */
    write(credentials: StoredCredentials): Promise<void>;
    /**
     * Check if credentials changed externally (another process refreshed).
     * Return true if stale → SDK will re-read.
     * Optional: if not implemented, SDK always re-reads before refresh.
     */
    hasChanged?(): Promise<boolean>;
}
/** Credentials as stored/retrieved by CredentialStore */
export interface StoredCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
}
/** SDK init options. Tokens can come from file OR be passed directly. */
export interface ClaudeCodeSDKOptions {
    /** Direct access token. If provided, skips file reading. */
    accessToken?: string;
    /** Direct refresh token for auto-refresh. */
    refreshToken?: string;
    /** Expiry timestamp (ms). Required with accessToken if you want auto-refresh. */
    expiresAt?: number;
    /** Path to .credentials.json. Defaults to ~/.claude/.credentials.json */
    credentialsPath?: string;
    /**
     * Custom credential store (DB, Redis, etc.).
     * If provided, overrides credentialsPath and direct token options.
     */
    credentialStore?: CredentialStore;
    /** device_id for metadata. If omitted, generates random 64-byte hex. */
    deviceId?: string;
    /** account_uuid for metadata. If omitted, reads from ~/.claude/config.json. */
    accountUuid?: string;
    /** SDK version string used in fingerprint + User-Agent. */
    version?: string;
    /** Request timeout in ms. Default: 600_000 */
    timeout?: number;
    /** Max retries for 5xx/529. Default: 3. Note: 429 is NEVER retried for subscribers. */
    maxRetries?: number;
}
/** What we read from ~/.claude/.credentials.json */
export interface CredentialsFile {
    claudeAiOauth?: {
        accessToken: string;
        refreshToken: string;
        expiresAt: number;
        scopes?: string[];
        subscriptionType?: string | null;
        rateLimitTier?: string | null;
    };
}
/** Message param — mirrors Anthropic API */
export interface MessageParam {
    role: 'user' | 'assistant';
    content: string | ContentBlockParam[];
}
export type ContentBlockParam = TextBlockParam | {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
} | {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'tool_result';
    tool_use_id: string;
    content: string | ContentBlockParam[];
    is_error?: boolean;
};
export interface TextBlockParam {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
        ttl?: '1h';
        scope?: 'global';
    };
}
/** Tool definition */
export interface ToolDef {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
/** System prompt blocks */
export type SystemParam = string | {
    type: 'text';
    text: string;
}[];
/** Tool choice — how the model selects tools */
export type ToolChoice = 'auto' | 'any' | {
    type: 'tool';
    name: string;
};
/** Options for a single generate/stream call */
export interface GenerateOptions {
    model: string;
    messages: MessageParam[];
    system?: SystemParam;
    maxTokens?: number;
    thinking?: {
        type: 'enabled';
        budgetTokens: number;
    } | {
        type: 'disabled';
    };
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    temperature?: number;
    topP?: number;
    effort?: 'low' | 'medium' | 'high';
    signal?: AbortSignal;
    stopSequences?: string[];
    extraBetas?: string[];
    fast?: boolean;
    /** Enable prompt caching. Default: true */
    caching?: boolean;
}
/** Options for Conversation class */
export interface ConversationOptions {
    model: string;
    system?: SystemParam;
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    maxTokens?: number;
    thinking?: {
        type: 'enabled';
        budgetTokens: number;
    } | {
        type: 'disabled';
    };
    effort?: 'low' | 'medium' | 'high';
    fast?: boolean;
    signal?: AbortSignal;
    extraBetas?: string[];
    /** Enable prompt caching. Default: true */
    caching?: boolean;
}
/** Turn options — per-send overrides */
export interface TurnOptions {
    signal?: AbortSignal;
    /** Override tools for this turn */
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
}
/** Normalized stream events */
export type StreamEvent = {
    type: 'text_delta';
    text: string;
} | {
    type: 'thinking_delta';
    text: string;
} | {
    type: 'tool_use_start';
    id: string;
    name: string;
} | {
    type: 'tool_use_delta';
    partialInput: string;
} | {
    type: 'tool_use_end';
    id: string;
    name: string;
    input: unknown;
} | {
    type: 'message_stop';
    usage: TokenUsage;
    stopReason: string | null;
} | {
    type: 'error';
    error: Error;
};
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
}
export interface RateLimitInfo {
    status: string | null;
    resetAt: number | null;
    claim: string | null;
    retryAfter: number | null;
}
export interface GenerateResponse {
    content: ContentBlock[];
    thinking?: ThinkingBlock[];
    toolCalls?: ToolUseBlock[];
    usage: TokenUsage;
    stopReason: string | null;
    rateLimitInfo: RateLimitInfo;
    model: string;
}
/** Content blocks from API response */
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;
export interface TextBlock {
    type: 'text';
    text: string;
}
export interface ThinkingBlock {
    type: 'thinking';
    thinking: string;
}
export interface ToolUseBlock {
    type: 'tool_use';
    id: string;
    name: string;
    input: unknown;
}
export declare class ClaudeCodeSDKError extends Error {
    readonly cause?: unknown | undefined;
    constructor(message: string, cause?: unknown | undefined);
}
export declare class AuthError extends ClaudeCodeSDKError {
    constructor(message: string, cause?: unknown);
}
export declare class APIError extends ClaudeCodeSDKError {
    readonly status: number;
    readonly requestId: string | null;
    constructor(message: string, status: number, requestId: string | null, cause?: unknown);
}
export declare class RateLimitError extends ClaudeCodeSDKError {
    readonly rateLimitInfo: RateLimitInfo;
    readonly status: number;
    constructor(message: string, rateLimitInfo: RateLimitInfo, status?: number, cause?: unknown);
}
//# sourceMappingURL=types.d.ts.map