/**
 * OpenAI-compatible endpoint for claude-max-proxy.
 *
 * Translates OpenAI Chat Completions API ↔ Anthropic Messages API so that
 * ANY OpenAI-compatible client (Hermes, OpenClaw, Cursor, LobeChat, openai
 * Python SDK, etc.) can connect to claude-max-proxy and get the full safety
 * stack (KA, rewrite guard, session tracking) for free.
 *
 * Architecture:
 *   OpenAI request → translateToAnthropicBody() → proxyClient.handleRequest()
 *   → Anthropic SSE Response → transformAnthropicSSEToOpenAI() → OpenAI SSE
 */

// ═══ OpenAI Types ═══════════════════════════════════════════════════

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | OAIContentPart[] | null
  tool_calls?: OAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OAIContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface OAIToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface OAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
    strict?: boolean
  }
}

export interface OAIChatRequest {
  model: string
  messages: OAIMessage[]
  stream?: boolean
  stream_options?: { include_usage?: boolean }
  max_tokens?: number
  temperature?: number
  top_p?: number
  stop?: string | string[]
  tools?: OAITool[]
  tool_choice?: 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } }
  response_format?: {
    type: 'text' | 'json_object' | 'json_schema'
    json_schema?: { name: string; strict?: boolean; schema: Record<string, unknown> }
  }
  reasoning_effort?: 'low' | 'medium' | 'high'
  parallel_tool_calls?: boolean
  n?: number
}

// ═══ Translation Result ═════════════════════════════════════════════

export interface TranslationResult {
  body: string
  model: string
  isJsonSchema: boolean
  schemaToolName: string | null
}

// ═══ Model Mapping ══════════════════════════════════════════════════
//
// Three layers:
//   1. GPT model names → best comparable Claude model (seamless for OpenAI agents)
//   2. Proxy-style IDs (claude-v4.6-sonnet) → API model names
//   3. Direct Anthropic model names → normalized (passthrough / short→full)

const GPT_TO_CLAUDE: Record<string, string> = {
  // GPT-4o family → Sonnet (fast, capable, best daily driver match)
  'gpt-4o': 'claude-sonnet-4-6',
  'gpt-4o-2024-08-06': 'claude-sonnet-4-6',
  'gpt-4o-2024-11-20': 'claude-sonnet-4-6',
  'gpt-4o-mini': 'claude-haiku-4-5-20251001',
  'gpt-4o-mini-2024-07-18': 'claude-haiku-4-5-20251001',
  // GPT-4 family → Opus (heavyweight reasoning match)
  'gpt-4': 'claude-opus-4-6',
  'gpt-4-turbo': 'claude-opus-4-6',
  'gpt-4-turbo-2024-04-09': 'claude-opus-4-6',
  'gpt-4-0613': 'claude-opus-4-6',
  // GPT-3.5 → Haiku (fast, cheap match)
  'gpt-3.5-turbo': 'claude-haiku-4-5-20251001',
  'gpt-3.5-turbo-0125': 'claude-haiku-4-5-20251001',
  'gpt-3.5-turbo-16k': 'claude-haiku-4-5-20251001',
  // o-series reasoning → Opus (deepest reasoning)
  'o1': 'claude-opus-4-7',
  'o1-preview': 'claude-opus-4-7',
  'o1-mini': 'claude-sonnet-4-6',
  'o3': 'claude-opus-4-7',
  'o3-mini': 'claude-sonnet-4-6',
  'o4-mini': 'claude-sonnet-4-6',
}

const PROXY_MODEL_MAP: Record<string, string> = {
  'claude-v4.6-sonnet': 'claude-sonnet-4-6',
  'claude-v4.6-opus': 'claude-opus-4-6',
  'claude-v4.7-opus': 'claude-opus-4-7',
  'claude-v4.5-haiku': 'claude-haiku-4-5-20251001',
}

const DIRECT_MODEL_MAP: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-4-6',
  'claude-opus-4-6': 'claude-opus-4-6',
  'claude-opus-4-7': 'claude-opus-4-7',
  'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-20250514': 'claude-sonnet-4-20250514',
  'claude-opus-4-20250514': 'claude-opus-4-20250514',
}

export function resolveModel(model: string): string {
  return GPT_TO_CLAUDE[model] ?? PROXY_MODEL_MAP[model] ?? DIRECT_MODEL_MAP[model] ?? model
}

export const SUPPORTED_MODELS = [
  // Claude native names
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6' },
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7' },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5' },
  // Proxy-style IDs
  { id: 'claude-v4.6-sonnet', name: 'Claude V4.6 Sonnet' },
  { id: 'claude-v4.6-opus', name: 'Claude V4.6 Opus' },
  { id: 'claude-v4.7-opus', name: 'Claude V4.7 Opus' },
  { id: 'claude-v4.5-haiku', name: 'Claude V4.5 Haiku' },
  // GPT aliases (for OpenAI agents that hardcode GPT model names)
  { id: 'gpt-4o', name: 'GPT-4o → Claude Sonnet 4.6' },
  { id: 'gpt-4o-mini', name: 'GPT-4o Mini → Claude Haiku 4.5' },
  { id: 'gpt-4', name: 'GPT-4 → Claude Opus 4.6' },
  { id: 'gpt-4-turbo', name: 'GPT-4 Turbo → Claude Opus 4.6' },
  { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo → Claude Haiku 4.5' },
  { id: 'o1', name: 'o1 → Claude Opus 4.7' },
  { id: 'o3', name: 'o3 → Claude Opus 4.7' },
  { id: 'o3-mini', name: 'o3-mini → Claude Sonnet 4.6' },
]

// ═══ Request Translation ════════════════════════════════════════════

export function translateToAnthropicBody(req: OAIChatRequest): TranslationResult {
  const model = resolveModel(req.model)
  const system = extractSystem(req.messages)
  const messages = toAnthropicMessages(req.messages)
  let tools = toAnthropicTools(req.tools)
  let toolChoice = toAnthropicToolChoice(req.tool_choice)

  let isJsonSchema = false
  let schemaToolName: string | null = null

  // json_schema enforcement via forced tool_use
  if (req.response_format?.type === 'json_schema' && req.response_format.json_schema) {
    const js = req.response_format.json_schema
    schemaToolName = js.name
    isJsonSchema = true
    const schemaTool = {
      name: js.name,
      description: 'Return structured output matching the requested JSON schema.',
      input_schema: js.schema,
    }
    tools = tools ? [...tools, schemaTool] : [schemaTool]
    toolChoice = { type: 'tool' as const, name: js.name }
  }

  // json_object mode: inject system instruction
  if (req.response_format?.type === 'json_object' && !isJsonSchema) {
    const jsonInstruction = 'You must respond with valid JSON only. No markdown, no explanation, just the JSON object.'
    if (system) {
      (system as string) // will be handled below
    }
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: req.max_tokens ?? 16384,
  }

  if (system) {
    if (req.response_format?.type === 'json_object' && !isJsonSchema) {
      body.system = system + '\n\nIMPORTANT: You must respond with valid JSON only. No markdown, no explanation, just the JSON object.'
    } else {
      body.system = system
    }
  } else if (req.response_format?.type === 'json_object' && !isJsonSchema) {
    body.system = 'You must respond with valid JSON only. No markdown, no explanation, just the JSON object.'
  }

  if (tools?.length) body.tools = tools
  if (toolChoice) body.tool_choice = toolChoice
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.top_p !== undefined) body.top_p = req.top_p
  if (req.stop) {
    body.stop_sequences = Array.isArray(req.stop) ? req.stop : [req.stop]
  }

  // reasoning_effort → thinking config
  if (req.reasoning_effort) {
    body.thinking = { type: 'enabled', budget_tokens: thinkingBudget(req.reasoning_effort, req.max_tokens ?? 16384) }
  }

  // Inject cache markers at strategic breakpoints so Anthropic caches the
  // prefix and KA engine can keep it warm. OpenAI clients never send
  // cache_control — without this, every request is uncached.
  injectCacheMarkers(body)

  return { body: JSON.stringify(body), model, isJsonSchema, schemaToolName }
}

function thinkingBudget(effort: 'low' | 'medium' | 'high', maxTokens: number): number {
  const budgets = { low: 2048, medium: 8192, high: 32768 }
  return Math.min(budgets[effort], maxTokens * 4)
}

// ═══ Message Translation ════════════════════════════════════════════

function extractSystem(messages: OAIMessage[]): string | null {
  const systemMsgs = messages.filter(m => m.role === 'system')
  if (systemMsgs.length === 0) return null
  return systemMsgs.map(m => extractText(m)).join('\n')
}

function extractText(msg: OAIMessage): string {
  if (typeof msg.content === 'string') return msg.content ?? ''
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b.type === 'text')
      .map(b => b.text ?? '')
      .join('')
  }
  return ''
}

function extractContentBlocks(msg: OAIMessage): unknown[] {
  if (typeof msg.content === 'string') {
    return msg.content ? [{ type: 'text', text: msg.content }] : []
  }
  if (Array.isArray(msg.content)) {
    const blocks: unknown[] = []
    for (const part of msg.content) {
      if (part.type === 'text' && part.text) {
        blocks.push({ type: 'text', text: part.text })
      } else if (part.type === 'image_url' && part.image_url?.url) {
        const url = part.image_url.url
        // base64 data URL → Anthropic image block
        const match = url.match(/^data:(image\/\w+);base64,(.+)$/)
        if (match) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: match[1], data: match[2] },
          })
        }
        // HTTP URL → not supported natively by Anthropic, skip with placeholder
      }
    }
    return blocks
  }
  return []
}

function toAnthropicMessages(messages: OAIMessage[]): unknown[] {
  const result: unknown[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]

    if (msg.role === 'system') { i++; continue }

    if (msg.role === 'user') {
      const blocks = extractContentBlocks(msg)
      result.push({
        role: 'user',
        content: blocks.length === 1 && (blocks[0] as any).type === 'text'
          ? (blocks[0] as any).text
          : blocks,
      })
      i++
      continue
    }

    if (msg.role === 'assistant') {
      const content: unknown[] = []
      const text = extractText(msg)
      if (text) content.push({ type: 'text', text })

      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let input: unknown = {}
          try { input = JSON.parse(tc.function.arguments) } catch { /* keep empty */ }
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input })
        }
      }

      result.push({ role: 'assistant', content: content.length > 0 ? content : '' })
      i++

      // Consecutive tool results → single user message with tool_result blocks
      const toolResults: unknown[] = []
      while (i < messages.length && messages[i].role === 'tool') {
        const toolMsg = messages[i]
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolMsg.tool_call_id ?? '',
          content: extractText(toolMsg),
        })
        i++
      }
      if (toolResults.length > 0) {
        result.push({ role: 'user', content: toolResults })
      }
      continue
    }

    // tool without preceding assistant (shouldn't happen, but handle gracefully)
    if (msg.role === 'tool') {
      result.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id ?? '', content: extractText(msg) }],
      })
      i++
      continue
    }

    i++
  }

  return result
}

// ═══ Tool Translation ═══════════════════════════════════════════════

function toAnthropicTools(tools?: OAITool[]): unknown[] | undefined {
  if (!tools?.length) return undefined
  return tools.map(t => ({
    name: t.function.name,
    description: t.function.description ?? '',
    input_schema: t.function.parameters ?? { type: 'object', properties: {} },
  }))
}

function toAnthropicToolChoice(
  tc: OAIChatRequest['tool_choice'],
): { type: string; name?: string } | undefined {
  if (!tc || tc === 'none') return undefined
  if (tc === 'auto') return { type: 'auto' }
  if (tc === 'required') return { type: 'any' }
  if (typeof tc === 'object' && tc.type === 'function') {
    return { type: 'tool', name: tc.function.name }
  }
  return { type: 'auto' }
}

// ═══ SSE Transformer: Anthropic → OpenAI ════════════════════════════

export interface TransformOpts {
  completionId: string
  model: string
  created: number
  systemFingerprint: string
  isJsonSchema: boolean
  schemaToolName: string | null
  includeUsage: boolean
  thinkingMode: 'strip' | 'field'
}

export function transformAnthropicSSEToOpenAI(
  upstreamResponse: Response,
  opts: TransformOpts,
): Response {
  if (!upstreamResponse.body) {
    return openaiErrorResponse(502, 'No upstream body', 'server_error')
  }

  const reader = upstreamResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  // State machine
  let currentBlockType: 'text' | 'tool_use' | 'thinking' | null = null
  let currentToolId: string | null = null
  let currentToolName: string | null = null
  let toolIndex = -1
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let reasoningTokens = 0
  // For json_schema: accumulate tool input to emit as content
  let jsonSchemaBuffer = ''
  let isSchemaToolBlock = false
  let firstChunk = true

  function makeChunk(choices: unknown[], usage?: unknown): string {
    const obj: Record<string, unknown> = {
      id: opts.completionId,
      object: 'chat.completion.chunk',
      created: opts.created,
      model: opts.model,
      system_fingerprint: opts.systemFingerprint,
      choices,
    }
    if (usage !== undefined) obj.usage = usage
    return `data: ${JSON.stringify(obj)}\n\n`
  }

  function mapFinishReason(reason: string | null): string {
    if (!reason) return 'stop'
    switch (reason) {
      case 'end_turn': return 'stop'
      case 'stop_sequence': return 'stop'
      case 'max_tokens': return 'length'
      case 'tool_use': return opts.isJsonSchema ? 'stop' : 'tool_calls'
      default: return 'stop'
    }
  }

  function buildUsage(): unknown {
    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const encoder = new TextEncoder()

      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          const r = await reader.read()
          done = r.done; value = r.value
        } catch {
          controller.close(); return
        }

        if (done) {
          // Emit finish if not already emitted by message_stop
          controller.close()
          return
        }

        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
            return
          }

          let event: any
          try { event = JSON.parse(raw) } catch { continue }

          // First chunk: emit role
          if (firstChunk && event.type !== 'error') {
            controller.enqueue(encoder.encode(makeChunk([{
              index: 0,
              delta: { role: 'assistant', content: '' },
              finish_reason: null,
              logprobs: null,
            }])))
            firstChunk = false
          }

          switch (event.type) {
            case 'message_start': {
              const u = event.message?.usage
              if (u) {
                inputTokens = u.input_tokens ?? 0
                cacheReadTokens = u.cache_read_input_tokens ?? 0
                cacheWriteTokens = u.cache_creation_input_tokens ?? 0
              }
              break
            }

            case 'content_block_start': {
              const cb = event.content_block
              if (!cb) break
              if (cb.type === 'text') {
                currentBlockType = 'text'
              } else if (cb.type === 'thinking') {
                currentBlockType = 'thinking'
              } else if (cb.type === 'tool_use') {
                currentBlockType = 'tool_use'
                currentToolId = cb.id ?? null
                currentToolName = cb.name ?? null
                toolIndex++

                // json_schema mode: accumulate instead of emitting tool_calls
                if (opts.isJsonSchema && cb.name === opts.schemaToolName) {
                  isSchemaToolBlock = true
                  jsonSchemaBuffer = ''
                } else {
                  isSchemaToolBlock = false
                  controller.enqueue(encoder.encode(makeChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        id: cb.id,
                        type: 'function',
                        function: { name: cb.name, arguments: '' },
                      }],
                    },
                    finish_reason: null,
                    logprobs: null,
                  }])))
                }
              }
              break
            }

            case 'content_block_delta': {
              const delta = event.delta
              if (!delta) break

              if (delta.type === 'text_delta' && currentBlockType === 'text') {
                controller.enqueue(encoder.encode(makeChunk([{
                  index: 0,
                  delta: { content: delta.text },
                  finish_reason: null,
                  logprobs: null,
                }])))
              } else if (delta.type === 'thinking_delta' && currentBlockType === 'thinking') {
                reasoningTokens += Math.ceil((delta.thinking?.length ?? 0) / 4)
                if (opts.thinkingMode === 'field') {
                  controller.enqueue(encoder.encode(makeChunk([{
                    index: 0,
                    delta: { reasoning: delta.thinking },
                    finish_reason: null,
                    logprobs: null,
                  }])))
                }
                // 'strip' mode: count tokens but don't emit
              } else if (delta.type === 'input_json_delta' && currentBlockType === 'tool_use') {
                if (isSchemaToolBlock) {
                  // json_schema: accumulate and stream as content
                  jsonSchemaBuffer += (delta.partial_json ?? '')
                  controller.enqueue(encoder.encode(makeChunk([{
                    index: 0,
                    delta: { content: delta.partial_json ?? '' },
                    finish_reason: null,
                    logprobs: null,
                  }])))
                } else {
                  controller.enqueue(encoder.encode(makeChunk([{
                    index: 0,
                    delta: {
                      tool_calls: [{
                        index: toolIndex,
                        function: { arguments: delta.partial_json ?? '' },
                      }],
                    },
                    finish_reason: null,
                    logprobs: null,
                  }])))
                }
              }
              break
            }

            case 'content_block_stop': {
              if (isSchemaToolBlock) isSchemaToolBlock = false
              currentBlockType = null
              currentToolId = null
              currentToolName = null
              break
            }

            case 'message_delta': {
              if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
              if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens
              break
            }

            case 'message_stop': {
              // Finish chunk with reason
              controller.enqueue(encoder.encode(makeChunk([{
                index: 0,
                delta: {},
                finish_reason: mapFinishReason(stopReason),
                logprobs: null,
              }])))

              // Usage chunk (when requested)
              if (opts.includeUsage) {
                controller.enqueue(encoder.encode(makeChunk([], buildUsage())))
              }

              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
              return
            }

            case 'error': {
              const errMsg = event.error?.message ?? 'Unknown upstream error'
              controller.enqueue(encoder.encode(makeChunk([{
                index: 0,
                delta: { content: `\n\n[ERROR] ${errMsg}` },
                finish_reason: null,
                logprobs: null,
              }])))
              controller.enqueue(encoder.encode(makeChunk([{
                index: 0, delta: {}, finish_reason: 'stop', logprobs: null,
              }])))
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
              return
            }
          }
        }
      }
    },
    cancel() { reader.cancel() },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    },
  })
}

// ═══ Non-Streaming Buffer ═══════════════════════════════════════════

export async function bufferToNonStreaming(
  upstreamResponse: Response,
  opts: TransformOpts,
): Promise<Response> {
  if (!upstreamResponse.body) {
    return openaiErrorResponse(502, 'No upstream body', 'server_error')
  }

  const reader = upstreamResponse.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  let content = ''
  const toolCalls: { id: string; type: 'function'; function: { name: string; arguments: string } }[] = []
  let currentToolArgs = ''
  let currentToolId = ''
  let currentToolName = ''
  let isSchemaToolBlock = false
  let stopReason: string | null = null
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let reasoningTokens = 0
  let currentBlockType: string | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const raw = line.slice(6)
      if (raw === '[DONE]') continue

      let event: any
      try { event = JSON.parse(raw) } catch { continue }

      switch (event.type) {
        case 'message_start': {
          const u = event.message?.usage
          if (u) {
            inputTokens = u.input_tokens ?? 0
            cacheReadTokens = u.cache_read_input_tokens ?? 0
          }
          break
        }
        case 'content_block_start': {
          const cb = event.content_block
          if (!cb) break
          currentBlockType = cb.type
          if (cb.type === 'tool_use') {
            currentToolId = cb.id ?? ''
            currentToolName = cb.name ?? ''
            currentToolArgs = ''
            isSchemaToolBlock = opts.isJsonSchema && cb.name === opts.schemaToolName
          }
          break
        }
        case 'content_block_delta': {
          const d = event.delta
          if (!d) break
          if (d.type === 'text_delta') content += d.text ?? ''
          else if (d.type === 'thinking_delta') {
            reasoningTokens += Math.ceil((d.thinking?.length ?? 0) / 4)
          }
          else if (d.type === 'input_json_delta') {
            if (isSchemaToolBlock) content += d.partial_json ?? ''
            else currentToolArgs += d.partial_json ?? ''
          }
          break
        }
        case 'content_block_stop': {
          if (currentBlockType === 'tool_use' && !isSchemaToolBlock && currentToolId) {
            toolCalls.push({
              id: currentToolId,
              type: 'function',
              function: { name: currentToolName, arguments: currentToolArgs },
            })
          }
          currentBlockType = null
          isSchemaToolBlock = false
          break
        }
        case 'message_delta': {
          if (event.delta?.stop_reason) stopReason = event.delta.stop_reason
          if (event.usage?.output_tokens) outputTokens = event.usage.output_tokens
          break
        }
      }
    }
  }

  const finishReason = (() => {
    if (!stopReason) return 'stop'
    switch (stopReason) {
      case 'end_turn': return 'stop'
      case 'stop_sequence': return 'stop'
      case 'max_tokens': return 'length'
      case 'tool_use': return opts.isJsonSchema ? 'stop' : 'tool_calls'
      default: return 'stop'
    }
  })()

  const response = {
    id: opts.completionId,
    object: 'chat.completion',
    created: opts.created,
    model: opts.model,
    system_fingerprint: opts.systemFingerprint,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: content || null,
        refusal: null,
        annotations: [],
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: finishReason,
      logprobs: null,
    }],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  }

  return new Response(JSON.stringify(response), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  })
}

// ═══ Models Endpoint ════════════════════════════════════════════════

export function handleModelsRequest(): Response {
  const models = SUPPORTED_MODELS.map(m => ({
    id: m.id,
    object: 'model',
    created: 1700000000,
    owned_by: 'anthropic',
  }))
  return new Response(JSON.stringify({ object: 'list', data: models }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  })
}

// ═══ Error Helper ═══════════════════════════════════════════════════

export function openaiErrorResponse(
  status: number,
  message: string,
  type: string,
  code?: string,
): Response {
  return new Response(JSON.stringify({
    error: { message, type, code: code ?? null },
  }), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    },
  })
}

// ═══ CORS Helper ════════════════════════════════════════════════════

export function corsPreflightResponse(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': '*',
      'access-control-max-age': '86400',
    },
  })
}

// ═══ Smart Cache Marker Injection ════════════════════════════════════
//
// OpenAI clients and bare Anthropic SDK clients don't send cache_control
// markers. Without markers, Anthropic doesn't cache the prefix, and KA
// engine can't keep it warm → every request pays full input token cost.
//
// This function injects cache markers at the same 3 breakpoints the SDK
// uses (sdk.ts:1056-1087): last system block, last tool, last message.
// The marker uses `ttl:'1h'` which ProxyClient's upgradeCacheControlTtl
// will recognize (requires prompt-caching-scope-2026-01-05 beta — always
// injected by enrichAnthropicRequest).
//
// IMPORTANT: Only injects markers where NONE exist. If the client already
// placed cache_control markers (e.g. native CC, advanced Anthropic SDK
// user), their markers are PRESERVED — we don't overwrite or conflict.

const CACHE_MARKER = { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }

export function injectCacheMarkers(body: Record<string, unknown>): number {
  let injected = 0

  // BP1: last system block
  const sys = body.system
  if (typeof sys === 'string' && sys.length > 0) {
    body.system = [{ type: 'text', text: sys, ...CACHE_MARKER }]
    injected++
  } else if (Array.isArray(sys) && sys.length > 0) {
    const last = sys[sys.length - 1] as Record<string, unknown>
    if (last && typeof last === 'object' && !last.cache_control) {
      sys[sys.length - 1] = { ...last, ...CACHE_MARKER }
      injected++
    }
  }

  // BP2: last tool definition
  const tools = body.tools as Record<string, unknown>[] | undefined
  if (tools && tools.length > 0) {
    const last = tools[tools.length - 1]
    if (last && typeof last === 'object' && !last.cache_control) {
      tools[tools.length - 1] = { ...last, ...CACHE_MARKER }
      injected++
    }
  }

  // BP3: last message content block
  const messages = body.messages as { role: string; content: string | Record<string, unknown>[] }[]
  if (messages && messages.length > 0) {
    const lastMsg = messages[messages.length - 1]
    if (typeof lastMsg.content === 'string' && lastMsg.content.length > 0) {
      if (!(lastMsg as any).cache_control) {
        lastMsg.content = [{ type: 'text', text: lastMsg.content, ...CACHE_MARKER }] as any
        injected++
      }
    } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1]
      if (lastBlock && typeof lastBlock === 'object' && !lastBlock.cache_control) {
        lastMsg.content[lastMsg.content.length - 1] = { ...lastBlock, ...CACHE_MARKER }
        injected++
      }
    }
  }

  return injected
}

// ═══ Anthropic-Compatible Facade ════════════════════════════════════
//
// Enriches a raw Anthropic SDK request with subscription-required headers,
// metadata, betas, and billing attribution so that the standard `anthropic`
// Python/JS SDK "just works" against the proxy. Without this enrichment,
// non-haiku models return 429 (Anthropic rejects requests missing the
// claude-code beta + billing header for subscription-based accounts).

const CC_COMPAT_VERSION = '2.1.152'

const OAUTH_BETA = 'oauth-2025-04-20'
const CLAUDE_CODE_BETA = 'claude-code-20250219'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'
const EFFORT_BETA = 'effort-2025-11-24'
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'
const TASK_BUDGETS_BETA = 'task-budgets-2026-03-13'
const REDACT_THINKING_BETA = 'redact-thinking-2026-02-12'
const PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'

export interface AnthropicEnrichResult {
  body: string
  headers: Record<string, string>
}

/**
 * Enrich a raw Anthropic API request so it works via subscription OAuth.
 *
 * Injects:
 *   - Required beta flags (claude-code, oauth, thinking, caching, etc.)
 *   - metadata.user_id with device_id + session_id
 *   - x-anthropic-billing-header in system prompt
 *   - Subscription-compatible User-Agent and x-app headers
 *   - anthropic-dangerous-direct-browser-access: true
 *
 * The consumer sends a standard `anthropic` SDK request; we make it
 * indistinguishable from a native Claude Code CLI request.
 */
export function enrichAnthropicRequest(
  rawBody: string,
  consumerHeaders: Record<string, string>,
  sessionId: string,
): AnthropicEnrichResult {
  let body: Record<string, unknown>
  try {
    body = JSON.parse(rawBody)
  } catch {
    return { body: rawBody, headers: consumerHeaders }
  }

  const model = String(body.model ?? '').toLowerCase()
  const isHaiku = model.includes('haiku')

  // ── Build subscription-required betas ───────────────────────────
  const betas: string[] = []
  if (!isHaiku) betas.push(CLAUDE_CODE_BETA)
  betas.push(OAUTH_BETA)
  if (!isHaiku) betas.push(INTERLEAVED_THINKING_BETA)
  if (!isHaiku) betas.push(CONTEXT_MANAGEMENT_BETA)
  betas.push(TASK_BUDGETS_BETA)
  betas.push(REDACT_THINKING_BETA)
  betas.push(PROMPT_CACHING_SCOPE_BETA)
  betas.push(FINE_GRAINED_TOOL_STREAMING_BETA)
  if (body.thinking) betas.push(EFFORT_BETA)

  // Merge with any betas the consumer already sent
  const existingBeta = consumerHeaders['anthropic-beta'] ?? ''
  const allBetas = new Set([...existingBeta.split(',').map(s => s.trim()).filter(Boolean), ...betas])

  // ── Build headers ──────────────────────────────────────────────
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(consumerHeaders)) {
    const lk = k.toLowerCase()
    if (lk === 'x-api-key' || lk === 'authorization') continue
    headers[k] = v
  }
  headers['content-type'] = 'application/json'
  headers['anthropic-version'] = '2023-06-01'
  headers['anthropic-beta'] = [...allBetas].join(',')
  headers['anthropic-dangerous-direct-browser-access'] = 'true'
  headers['x-app'] = 'cli'
  headers['user-agent'] = `claude-cli/${CC_COMPAT_VERSION}`
  headers['x-claude-code-session-id'] = sessionId

  // ── Inject metadata.user_id if absent ─────────────────────────
  if (!body.metadata || !(body.metadata as any).user_id) {
    const deviceId = randomHex(32)
    body.metadata = {
      ...(body.metadata as Record<string, unknown> ?? {}),
      user_id: JSON.stringify({
        device_id: deviceId,
        account_uuid: '',
        session_id: sessionId,
      }),
    }
  }

  // ── Inject billing attribution header in system ────────────────
  const billingHeader = `x-anthropic-billing-header: cc_version=${CC_COMPAT_VERSION}.0000000000; cc_entrypoint=cli; cch=00000;`
  if (body.system !== undefined) {
    const sysStr = typeof body.system === 'string' ? body.system : JSON.stringify(body.system)
    if (!sysStr.includes('x-anthropic-billing-header')) {
      if (typeof body.system === 'string') {
        body.system = billingHeader + '\n' + body.system
      } else if (Array.isArray(body.system)) {
        body.system = [{ type: 'text', text: billingHeader }, ...body.system]
      }
    }
  } else {
    body.system = billingHeader
  }

  // Inject cache markers if the client didn't provide any. Third-party
  // Anthropic SDK users rarely set cache_control — without markers, no
  // caching and no KA protection. injectCacheMarkers respects existing
  // markers (won't overwrite if client already set them).
  injectCacheMarkers(body)

  return { body: JSON.stringify(body), headers }
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('')
}

