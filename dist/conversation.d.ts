import type { ClaudeCodeSDK } from './sdk.js';
import type { MessageParam, ContentBlockParam, ConversationOptions, TurnOptions, GenerateResponse, StreamEvent, TokenUsage } from './types.js';
/**
 * Multi-turn conversation wrapper around ClaudeCodeSDK.
 *
 * Accumulates messages across turns, handles prompt caching,
 * supports tool execution loop, rewind, and branching.
 *
 * Pattern mirrors CLI's query loop (query.ts:204-321):
 * messages accumulate in mutable state across iterations.
 */
export declare class Conversation {
    private sdk;
    private options;
    private _messages;
    private _totalUsage;
    constructor(sdk: ClaudeCodeSDK, options: ConversationOptions);
    /** Read-only access to conversation history */
    get messages(): readonly MessageParam[];
    /** Cumulative token usage across all turns */
    get totalUsage(): TokenUsage;
    /** Number of messages in conversation */
    get length(): number;
    /** Send a user message and get complete response */
    send(content: string | ContentBlockParam[], turnOptions?: TurnOptions): Promise<GenerateResponse>;
    /** Send a user message and stream the response */
    stream(content: string | ContentBlockParam[], turnOptions?: TurnOptions): AsyncGenerator<StreamEvent>;
    /**
     * Add a tool result to the conversation.
     * Call this after executing a tool_use returned by the model.
     * Then call send() or stream() with the next user message (or empty)
     * to continue the conversation.
     */
    addToolResult(toolUseId: string, content: string | ContentBlockParam[], isError?: boolean): void;
    /**
     * Add multiple tool results at once (for parallel tool execution).
     */
    addToolResults(results: Array<{
        toolUseId: string;
        content: string | ContentBlockParam[];
        isError?: boolean;
    }>): void;
    /**
     * Continue conversation after adding tool results.
     * Sends accumulated tool results to the model.
     */
    continue(turnOptions?: TurnOptions): Promise<GenerateResponse>;
    /**
     * Continue conversation with streaming after adding tool results.
     */
    continueStream(turnOptions?: TurnOptions): AsyncGenerator<StreamEvent>;
    /**
     * Rewind conversation to a specific message index.
     * Removes all messages at and after the index.
     * Returns removed messages.
     */
    rewind(toIndex: number): MessageParam[];
    /**
     * Rewind to the last user message (undo last turn).
     * Removes the last assistant + any tool results after it.
     */
    undoLastTurn(): MessageParam[];
    /**
     * Branch conversation — create new Conversation with messages up to current point.
     * Like CLI's /branch command.
     */
    branch(): Conversation;
    /**
     * Get message history with indices for rewind UI.
     */
    getHistory(): Array<{
        index: number;
        role: string;
        preview: string;
    }>;
    private appendUserMessage;
    private appendAssistantFromResponse;
    private buildGenerateOptions;
    private accumulateUsage;
}
//# sourceMappingURL=conversation.d.ts.map