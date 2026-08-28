import type { ClaudeCodeSDK } from "./sdk.js";
import type { MessageParam, ContentBlockParam, ConversationOptions, TurnOptions, GenerateResponse, StreamEvent, TokenUsage } from "./types.js";
export declare class Conversation {
    private sdk;
    private options;
    private _messages;
    private _totalUsage;
    constructor(sdk: ClaudeCodeSDK, options: ConversationOptions);
    get messages(): readonly MessageParam[];
    get totalUsage(): TokenUsage;
    get length(): number;
    send(content: string | ContentBlockParam[], turnOptions?: TurnOptions): Promise<GenerateResponse>;
    stream(content: string | ContentBlockParam[], turnOptions?: TurnOptions): AsyncGenerator<StreamEvent>;
    addToolResult(toolUseId: string, content: string | ContentBlockParam[], isError?: boolean): void;
    addToolResults(results: Array<{
        toolUseId: string;
        content: string | ContentBlockParam[];
        isError?: boolean;
    }>): void;
    continue(turnOptions?: TurnOptions): Promise<GenerateResponse>;
    continueStream(turnOptions?: TurnOptions): AsyncGenerator<StreamEvent>;
    rewind(toIndex: number): MessageParam[];
    undoLastTurn(): MessageParam[];
    branch(): Conversation;
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
