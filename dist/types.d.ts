import type { AgentRole } from "./lineage.js";
export interface CredentialStore {
    read(): Promise<StoredCredentials | null>;
    write(credentials: StoredCredentials): Promise<void>;
    hasChanged?(): Promise<boolean>;
}
export interface StoredCredentials {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    scopes?: string[];
    subscriptionType?: string | null;
    rateLimitTier?: string | null;
}
export interface ClaudeCodeSDKOptions {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    credentialsPath?: string;
    credentialStore?: CredentialStore;
    deviceId?: string;
    accountUuid?: string;
    version?: string;
    timeout?: number;
    maxRetries?: number;
    keepalive?: KeepaliveConfig;
    contextTokensProvider?: () => number | null;
    onTokenStatus?: (event: TokenStatusEvent) => void;
}
export interface TokenStatusEvent {
    level: "rotated" | "warning" | "critical" | "expired";
    message: string;
    expiresInMs: number;
    failedAttempts: number;
    needsReLogin: boolean;
}
export interface KeepaliveConfig {
    enabled?: boolean;
    cacheTtlMs?: number;
    intervalMs?: number;
    idleTimeoutMs?: number;
    minTokens?: number;
    maxFiresPerTick?: number;
    rewriteWarnIdleMs?: number;
    rewriteWarnTokens?: number;
    rewriteBlockIdleMs?: number;
    rewriteBlockEnabled?: boolean;
    onHeartbeat?: (stats: KeepaliveStats) => void;
    onTick?: (tick: KeepaliveTick) => void;
    onDisarmed?: (info: {
        reason: string;
        at: number;
        errStatus?: number | null;
        errMessage?: string | null;
        detail?: Record<string, number>;
    }) => void;
    onHeld?: (info: {
        reason: string;
        at: number;
        holdMs: number;
        regSize: number;
    }) => void;
    onPartialRewrite?: (info: {
        lineageKey: string;
        role?: AgentRole;
        cacheRead: number;
        cacheWrite: number;
        msSinceLastRealRequest: number;
        at: number;
    }) => void;
    onRewriteWarning?: (info: {
        idleMs: number;
        estimatedTokens: number;
        blocked: boolean;
        model: string;
    }) => void;
    onFireStart?: (info: {
        lineageKey: string;
        idleMs: number;
        at: number;
        role?: AgentRole;
    }) => void;
    onFireError?: (info: {
        lineageKey: string;
        idleMs: number;
        status: number | null;
        category: string;
        message: string;
        durationMs: number;
    }) => void;
    onNetworkStateChange?: (info: {
        from: string;
        to: string;
        at: number;
    }) => void;
    onTtlScan?: (info: {
        minTtlMs: number | null;
        previousTtlMs: number | null;
        hasAnyCacheControl: boolean;
        at: number;
    }) => void;
    onRegistryChange?: () => void;
}
export interface KeepaliveTick {
    idleMs: number;
    nextFireMs: number;
    model: string;
    tokens: number;
}
export interface KeepaliveStats {
    usage: TokenUsage;
    durationMs: number;
    idleMs: number;
    model: string;
    lineageKey?: string;
    role?: AgentRole;
    rateLimit?: {
        status: string | null;
        claim: string | null;
        resetAt: number | null;
        utilization5h?: number | null;
        utilization7d?: number | null;
    };
}
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
export interface MessageParam {
    role: "user" | "assistant";
    content: string | ContentBlockParam[];
}
export type ContentBlockParam = TextBlockParam | {
    type: "image";
    source: {
        type: "base64";
        media_type: string;
        data: string;
    };
} | {
    type: "document";
    source: {
        type: "base64";
        media_type: "application/pdf";
        data: string;
    };
} | {
    type: "tool_use";
    id: string;
    name: string;
    input: unknown;
} | {
    type: "tool_result";
    tool_use_id: string;
    content: string | ContentBlockParam[];
    is_error?: boolean;
};
export interface TextBlockParam {
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
        ttl?: "1h";
        scope?: "global";
    };
}
export interface ToolDef {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
}
export type SystemParam = string | {
    type: "text";
    text: string;
}[];
export type ToolChoice = "auto" | "any" | {
    type: "tool";
    name: string;
};
export interface GenerateOptions {
    model: string;
    messages: MessageParam[];
    system?: SystemParam;
    maxTokens?: number;
    thinking?: {
        type: "enabled";
        budgetTokens: number;
    } | {
        type: "disabled";
    };
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    temperature?: number;
    topP?: number;
    effort?: "low" | "medium" | "high";
    signal?: AbortSignal;
    stopSequences?: string[];
    extraBetas?: string[];
    fast?: boolean;
    caching?: boolean;
}
export interface ConversationOptions {
    model: string;
    system?: SystemParam;
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
    maxTokens?: number;
    thinking?: {
        type: "enabled";
        budgetTokens: number;
    } | {
        type: "disabled";
    };
    effort?: "low" | "medium" | "high";
    fast?: boolean;
    signal?: AbortSignal;
    extraBetas?: string[];
    caching?: boolean;
}
export interface TurnOptions {
    signal?: AbortSignal;
    tools?: ToolDef[];
    toolChoice?: ToolChoice;
}
export type StreamEvent = {
    type: "text_delta";
    text: string;
} | {
    type: "thinking_delta";
    text: string;
} | {
    type: "thinking_end";
    signature?: string;
} | {
    type: "tool_use_start";
    id: string;
    name: string;
} | {
    type: "tool_use_delta";
    partialInput: string;
} | {
    type: "tool_use_end";
    id: string;
    name: string;
    input: unknown;
} | {
    type: "message_stop";
    usage: TokenUsage;
    stopReason: string | null;
} | {
    type: "error";
    error: Error;
};
export interface TokenUsage {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreation5mInputTokens?: number;
    cacheCreation1hInputTokens?: number;
    cacheDeletedInputTokens?: number;
}
export interface RateLimitInfo {
    status: string | null;
    resetAt: number | null;
    claim: string | null;
    retryAfter: number | null;
    utilization5h: number | null;
    utilization7d: number | null;
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
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock;
export interface TextBlock {
    type: "text";
    text: string;
}
export interface ThinkingBlock {
    type: "thinking";
    thinking: string;
}
export interface ToolUseBlock {
    type: "tool_use";
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
export declare class CacheRewriteBlockedError extends ClaudeCodeSDKError {
    idleMs: number;
    estimatedTokens: number;
    model: string;
    readonly code = "CACHE_REWRITE_BLOCKED";
    constructor(idleMs: number, estimatedTokens: number, model: string);
}
