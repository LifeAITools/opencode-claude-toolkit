import type { ClaudeCodeSDK } from './sdk.js'
import type {
  MessageParam,
  ContentBlockParam,
  ConversationOptions,
  TurnOptions,
  GenerateOptions,
  GenerateResponse,
  StreamEvent,
  TokenUsage,
  ToolUseBlock,
} from './types.js'

/**
 * Multi-turn conversation wrapper around ClaudeCodeSDK.
 *
 * Accumulates messages across turns, handles prompt caching,
 * supports tool execution loop, rewind, and branching.
 *
 * Pattern mirrors CLI's query loop (query.ts:204-321):
 * messages accumulate in mutable state across iterations.
 */
export class Conversation {
  private sdk: ClaudeCodeSDK
  private options: ConversationOptions
  private _messages: MessageParam[] = []
  private _totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  constructor(sdk: ClaudeCodeSDK, options: ConversationOptions) {
    this.sdk = sdk
    this.options = options
  }

  /** Read-only access to conversation history */
  get messages(): readonly MessageParam[] {
    return this._messages
  }

  /** Cumulative token usage across all turns */
  get totalUsage(): TokenUsage {
    return { ...this._totalUsage }
  }

  /** Number of messages in conversation */
  get length(): number {
    return this._messages.length
  }

  // ----------------------------------------------------------
  // Send (non-streaming)
  // ----------------------------------------------------------

  /** Send a user message and get complete response */
  async send(
    content: string | ContentBlockParam[],
    turnOptions?: TurnOptions,
  ): Promise<GenerateResponse> {
    this.appendUserMessage(content)
    const opts = this.buildGenerateOptions(turnOptions)
    const response = await this.sdk.generate(opts)
    this.appendAssistantFromResponse(response)
    this.accumulateUsage(response.usage)
    return response
  }

  // ----------------------------------------------------------
  // Stream
  // ----------------------------------------------------------

  /** Send a user message and stream the response */
  async *stream(
    content: string | ContentBlockParam[],
    turnOptions?: TurnOptions,
  ): AsyncGenerator<StreamEvent> {
    this.appendUserMessage(content)
    const opts = this.buildGenerateOptions(turnOptions)

    // Collect assistant content while streaming
    const textParts: string[] = []
    const thinkingParts: string[] = []
    const toolCalls: ToolUseBlock[] = []
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    for await (const event of this.sdk.stream(opts)) {
      yield event

      switch (event.type) {
        case 'text_delta':
          textParts.push(event.text)
          break
        case 'thinking_delta':
          thinkingParts.push(event.text)
          break
        case 'tool_use_end':
          toolCalls.push({
            type: 'tool_use',
            id: event.id,
            name: event.name,
            input: event.input,
          })
          break
        case 'message_stop':
          usage = event.usage
          break
      }
    }

    // Append assistant message to history
    const assistantContent: ContentBlockParam[] = []
    if (textParts.length > 0) {
      assistantContent.push({ type: 'text', text: textParts.join('') })
    }
    for (const tc of toolCalls) {
      assistantContent.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.input,
      })
    }

    if (assistantContent.length > 0) {
      this._messages.push({ role: 'assistant', content: assistantContent })
    }
    this.accumulateUsage(usage)
  }

  // ----------------------------------------------------------
  // Tool result handling
  // ----------------------------------------------------------

  /**
   * Add a tool result to the conversation.
   * Call this after executing a tool_use returned by the model.
   * Then call send() or stream() with the next user message (or empty)
   * to continue the conversation.
   */
  addToolResult(
    toolUseId: string,
    content: string | ContentBlockParam[],
    isError?: boolean,
  ): void {
    const block: ContentBlockParam = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content,
      ...(isError && { is_error: true }),
    }
    // Tool results go in a user message (API requirement)
    this._messages.push({ role: 'user', content: [block] })
  }

  /**
   * Add multiple tool results at once (for parallel tool execution).
   */
  addToolResults(
    results: Array<{
      toolUseId: string
      content: string | ContentBlockParam[]
      isError?: boolean
    }>,
  ): void {
    const blocks: ContentBlockParam[] = results.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.toolUseId,
      content: r.content,
      ...(r.isError && { is_error: true }),
    }))
    this._messages.push({ role: 'user', content: blocks })
  }

  /**
   * Continue conversation after adding tool results.
   * Sends accumulated tool results to the model.
   */
  async continue(turnOptions?: TurnOptions): Promise<GenerateResponse> {
    const opts = this.buildGenerateOptions(turnOptions)
    const response = await this.sdk.generate(opts)
    this.appendAssistantFromResponse(response)
    this.accumulateUsage(response.usage)
    return response
  }

  /**
   * Continue conversation with streaming after adding tool results.
   */
  async *continueStream(turnOptions?: TurnOptions): AsyncGenerator<StreamEvent> {
    const opts = this.buildGenerateOptions(turnOptions)
    const textParts: string[] = []
    const toolCalls: ToolUseBlock[] = []
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

    for await (const event of this.sdk.stream(opts)) {
      yield event
      switch (event.type) {
        case 'text_delta': textParts.push(event.text); break
        case 'tool_use_end':
          toolCalls.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
          break
        case 'message_stop': usage = event.usage; break
      }
    }

    const assistantContent: ContentBlockParam[] = []
    if (textParts.length > 0) {
      assistantContent.push({ type: 'text', text: textParts.join('') })
    }
    for (const tc of toolCalls) {
      assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
    }
    if (assistantContent.length > 0) {
      this._messages.push({ role: 'assistant', content: assistantContent })
    }
    this.accumulateUsage(usage)
  }

  // ----------------------------------------------------------
  // Rewind — mirrors REPL.tsx:3656-3707
  // ----------------------------------------------------------

  /**
   * Rewind conversation to a specific message index.
   * Removes all messages at and after the index.
   * Returns removed messages.
   */
  rewind(toIndex: number): MessageParam[] {
    if (toIndex < 0 || toIndex >= this._messages.length) {
      throw new Error(`Invalid rewind index: ${toIndex}`)
    }
    const removed = this._messages.splice(toIndex)
    return removed
  }

  /**
   * Rewind to the last user message (undo last turn).
   * Removes the last assistant + any tool results after it.
   */
  undoLastTurn(): MessageParam[] {
    // Find last user message that isn't a tool result
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i]
      if (msg.role === 'user') {
        const content = msg.content
        const isToolResult = Array.isArray(content) &&
          content.length > 0 &&
          (content[0] as Record<string, unknown>).type === 'tool_result'
        if (!isToolResult) {
          return this.rewind(i)
        }
      }
    }
    return []
  }

  /**
   * Branch conversation — create new Conversation with messages up to current point.
   * Like CLI's /branch command.
   */
  branch(): Conversation {
    const conv = new Conversation(this.sdk, { ...this.options })
    conv._messages = [...this._messages]
    conv._totalUsage = { ...this._totalUsage }
    return conv
  }

  /**
   * Get message history with indices for rewind UI.
   */
  getHistory(): Array<{ index: number; role: string; preview: string }> {
    return this._messages.map((msg, index) => {
      let preview = ''
      if (typeof msg.content === 'string') {
        preview = msg.content.slice(0, 100)
      } else if (Array.isArray(msg.content)) {
        const first = msg.content[0] as Record<string, string>
        if (first?.type === 'text') preview = first.text?.slice(0, 100) ?? ''
        else if (first?.type === 'tool_result') preview = `[tool_result: ${first.tool_use_id}]`
        else if (first?.type === 'tool_use') preview = `[tool_use: ${first.name}]`
      }
      return { index, role: msg.role, preview }
    })
  }

  // ----------------------------------------------------------
  // Internals
  // ----------------------------------------------------------

  private appendUserMessage(content: string | ContentBlockParam[]): void {
    this._messages.push({
      role: 'user',
      content: typeof content === 'string' ? content : content,
    })
  }

  private appendAssistantFromResponse(response: GenerateResponse): void {
    const assistantContent: ContentBlockParam[] = []

    for (const block of response.content) {
      if (block.type === 'text') {
        assistantContent.push({ type: 'text', text: block.text })
      } else if (block.type === 'tool_use') {
        assistantContent.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        })
      }
    }

    if (assistantContent.length > 0) {
      this._messages.push({ role: 'assistant', content: assistantContent })
    }
  }

  private buildGenerateOptions(turnOptions?: TurnOptions): GenerateOptions {
    return {
      model: this.options.model,
      messages: [...this._messages],
      system: this.options.system,
      tools: turnOptions?.tools ?? this.options.tools,
      toolChoice: turnOptions?.toolChoice ?? this.options.toolChoice,
      maxTokens: this.options.maxTokens,
      thinking: this.options.thinking,
      effort: this.options.effort,
      fast: this.options.fast,
      signal: turnOptions?.signal ?? this.options.signal,
      extraBetas: this.options.extraBetas,
      caching: this.options.caching,
    }
  }

  private accumulateUsage(usage: TokenUsage): void {
    this._totalUsage.inputTokens += usage.inputTokens
    this._totalUsage.outputTokens += usage.outputTokens
    this._totalUsage.cacheCreationInputTokens =
      (this._totalUsage.cacheCreationInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
    this._totalUsage.cacheReadInputTokens =
      (this._totalUsage.cacheReadInputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0)
  }
}
