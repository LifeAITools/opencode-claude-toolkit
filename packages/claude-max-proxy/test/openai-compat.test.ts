/**
 * Tests: openai-compat.ts — OpenAI ↔ Anthropic translation layer.
 *
 * Coverage:
 *   1. Request translation: messages, system, tools, tool_choice, model mapping
 *   2. json_schema enforcement via forced tool_use
 *   3. json_object system prompt injection
 *   4. SSE transform: Anthropic SSE → strict OpenAI chunks
 *   5. Non-streaming buffer: full response assembly
 *   6. Error response format
 *   7. Models endpoint
 *   8. finish_reason mapping
 */

import { describe, test, expect } from 'bun:test'
import {
  translateToAnthropicBody,
  transformAnthropicSSEToOpenAI,
  bufferToNonStreaming,
  handleModelsRequest,
  openaiErrorResponse,
  resolveModel,
  type OAIChatRequest,
  type TransformOpts,
} from '../src/openai-translate.js'

// ═══ Helper: build a synthetic Anthropic SSE stream ═════════════════

function makeAnthropicSSE(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const lines = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
    + 'data: [DONE]\n\n'
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines))
      controller.close()
    },
  })
}

function makeAnthropicResponse(events: unknown[], status = 200): Response {
  return new Response(makeAnthropicSSE(events), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const DEFAULT_OPTS: TransformOpts = {
  completionId: 'chatcmpl-test123',
  model: 'claude-sonnet-4-6',
  created: 1700000000,
  systemFingerprint: 'claude-max-proxy-0.9.0',
  isJsonSchema: false,
  schemaToolName: null,
  includeUsage: false,
  thinkingMode: 'strip',
}

async function collectSSEChunks(response: Response): Promise<any[]> {
  const text = await response.text()
  const chunks: any[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
      try { chunks.push(JSON.parse(line.slice(6))) } catch { /* skip */ }
    }
  }
  return chunks
}

// ═══ Request Translation Tests ══════════════════════════════════════

describe('translateToAnthropicBody', () => {
  test('basic user message', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hello' }],
    }
    const result = translateToAnthropicBody(req)
    const body = JSON.parse(result.body)
    expect(body.model).toBe('claude-sonnet-4-6')
    // injectCacheMarkers converts last message content to array with cache_control
    const lastMsg = body.messages[0]
    expect(lastMsg.role).toBe('user')
    const lastBlock = Array.isArray(lastMsg.content) ? lastMsg.content[0] : lastMsg
    expect(lastBlock.text ?? lastMsg.content).toBe('Hello')
    expect(body.stream).toBe(true)
    expect(body.max_tokens).toBe(16384)
    expect(result.isJsonSchema).toBe(false)
  })

  test('system message extracted to body.system', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    // injectCacheMarkers converts string system to array with cache_control
    const sysText = Array.isArray(body.system) ? body.system[0].text : body.system
    expect(sysText).toBe('You are helpful.')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
  })

  test('model mapping: proxy ID → API model', () => {
    expect(resolveModel('claude-v4.6-sonnet')).toBe('claude-sonnet-4-6')
    expect(resolveModel('claude-v4.6-opus')).toBe('claude-opus-4-6')
    expect(resolveModel('claude-v4.5-haiku')).toBe('claude-haiku-4-5-20251001')
    expect(resolveModel('claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(resolveModel('some-unknown-model')).toBe('some-unknown-model')
  })

  test('tool_calls in assistant + tool results', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"NYC"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'tc_1', content: '{"temp": 72}' },
        { role: 'user', content: 'Thanks' },
      ],
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    expect(body.messages).toHaveLength(4)
    // assistant with tool_use
    expect(body.messages[0].role).toBe('user')
    expect(body.messages[1].role).toBe('assistant')
    expect(body.messages[1].content[0].type).toBe('tool_use')
    expect(body.messages[1].content[0].name).toBe('get_weather')
    expect(body.messages[1].content[0].input).toEqual({ city: 'NYC' })
    // tool result as user message
    expect(body.messages[2].role).toBe('user')
    expect(body.messages[2].content[0].type).toBe('tool_result')
    expect(body.messages[2].content[0].tool_use_id).toBe('tc_1')
  })

  test('tools translation', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{
        type: 'function',
        function: {
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      }],
      tool_choice: 'auto',
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].name).toBe('search')
    expect(body.tools[0].input_schema.properties.q.type).toBe('string')
    expect(body.tool_choice).toEqual({ type: 'auto' })
  })

  test('tool_choice "required" → "any"', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      tool_choice: 'required',
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    expect(body.tool_choice).toEqual({ type: 'any' })
  })

  test('json_schema enforcement injects tool + forces choice', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Extract data' }],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'person',
          strict: true,
          schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } },
        },
      },
    }
    const result = translateToAnthropicBody(req)
    expect(result.isJsonSchema).toBe(true)
    expect(result.schemaToolName).toBe('person')
    const body = JSON.parse(result.body)
    expect(body.tools).toHaveLength(1)
    expect(body.tools[0].name).toBe('person')
    expect(body.tools[0].input_schema.properties.name.type).toBe('string')
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'person' })
  })

  test('json_object mode injects system instruction', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Give me JSON' }],
      response_format: { type: 'json_object' },
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    // system may be string or array (after injectCacheMarkers)
    const sysText = Array.isArray(body.system) ? body.system[0].text : body.system
    expect(sysText).toContain('valid JSON only')
  })

  test('reasoning_effort → thinking config', () => {
    const req: OAIChatRequest = {
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Think hard' }],
      reasoning_effort: 'high',
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    expect(body.thinking).toBeDefined()
    expect(body.thinking.type).toBe('enabled')
    expect(body.thinking.budget_tokens).toBeGreaterThan(0)
  })

  test('stop sequences', () => {
    const req: OAIChatRequest = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Hi' }],
      stop: ['STOP', 'END'],
    }
    const body = JSON.parse(translateToAnthropicBody(req).body)
    expect(body.stop_sequences).toEqual(['STOP', 'END'])
  })
})

// ═══ SSE Transform Tests ════════════════════════════════════════════

describe('transformAnthropicSSEToOpenAI', () => {
  test('text streaming produces correct OpenAI chunks', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 5 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]

    const response = transformAnthropicSSEToOpenAI(makeAnthropicResponse(events), DEFAULT_OPTS)
    const chunks = await collectSSEChunks(response)

    expect(chunks.length).toBeGreaterThanOrEqual(3) // role + text deltas + finish

    // All chunks must have required fields
    for (const c of chunks) {
      expect(c.id).toBe('chatcmpl-test123')
      expect(c.object).toBe('chat.completion.chunk')
      expect(c.model).toBe('claude-sonnet-4-6')
      expect(c.system_fingerprint).toBe('claude-max-proxy-0.9.0')
    }

    // Find text content chunks
    const textChunks = chunks.filter(c => c.choices?.[0]?.delta?.content && c.choices[0].delta.content !== '')
    expect(textChunks.length).toBe(2)
    expect(textChunks[0].choices[0].delta.content).toBe('Hello')
    expect(textChunks[1].choices[0].delta.content).toBe(' world')

    // Finish chunk
    const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason === 'stop')
    expect(finishChunk).toBeDefined()
  })

  test('tool_use streaming produces tool_calls chunks', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc_1', name: 'search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"hello"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]

    const response = transformAnthropicSSEToOpenAI(makeAnthropicResponse(events), DEFAULT_OPTS)
    const chunks = await collectSSEChunks(response)

    // Tool start chunk
    const startChunk = chunks.find(c => c.choices?.[0]?.delta?.tool_calls?.[0]?.id === 'tc_1')
    expect(startChunk).toBeDefined()
    expect(startChunk.choices[0].delta.tool_calls[0].function.name).toBe('search')

    // Argument chunks
    const argChunks = chunks.filter(c =>
      c.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments !== undefined
      && c.choices[0].delta.tool_calls[0].function.arguments !== ''
    )
    expect(argChunks.length).toBe(2)

    // Finish reason
    const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason === 'tool_calls')
    expect(finishChunk).toBeDefined()
  })

  test('json_schema: tool_use emitted as content, finish_reason=stop', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc_1', name: 'person' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"Alice",' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"age":30}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]

    const opts = { ...DEFAULT_OPTS, isJsonSchema: true, schemaToolName: 'person' }
    const response = transformAnthropicSSEToOpenAI(makeAnthropicResponse(events), opts)
    const chunks = await collectSSEChunks(response)

    // Should NOT have tool_calls — should be content
    const toolChunks = chunks.filter(c => c.choices?.[0]?.delta?.tool_calls)
    expect(toolChunks.length).toBe(0)

    // Content chunks with JSON
    const contentChunks = chunks.filter(c =>
      c.choices?.[0]?.delta?.content
      && c.choices[0].delta.content !== ''
      && c.choices[0].delta.content !== undefined
    )
    expect(contentChunks.length).toBeGreaterThan(0)
    const fullContent = contentChunks.map(c => c.choices[0].delta.content).join('')
    expect(fullContent).toContain('"name":"Alice"')

    // finish_reason = stop (not tool_calls)
    const finishChunk = chunks.find(c => c.choices?.[0]?.finish_reason != null)
    expect(finishChunk.choices[0].finish_reason).toBe('stop')
  })

  test('include_usage emits usage-only final chunk', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 30 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]

    const opts = { ...DEFAULT_OPTS, includeUsage: true }
    const response = transformAnthropicSSEToOpenAI(makeAnthropicResponse(events), opts)
    const chunks = await collectSSEChunks(response)

    // Last data chunk (before [DONE]) should have usage + empty choices
    const usageChunk = chunks.find(c => c.usage && c.choices?.length === 0)
    expect(usageChunk).toBeDefined()
    expect(usageChunk.usage.prompt_tokens).toBe(50)
    expect(usageChunk.usage.completion_tokens).toBe(1)
    expect(usageChunk.usage.total_tokens).toBe(51)
    expect(usageChunk.usage.prompt_tokens_details.cached_tokens).toBe(30)
  })

  test('thinking in strip mode: counted but not emitted', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think about this carefully...' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' },
    ]

    const opts = { ...DEFAULT_OPTS, thinkingMode: 'strip' as const, includeUsage: true }
    const response = transformAnthropicSSEToOpenAI(makeAnthropicResponse(events), opts)
    const chunks = await collectSSEChunks(response)

    // No reasoning/thinking in deltas
    const thinkingChunks = chunks.filter(c => c.choices?.[0]?.delta?.reasoning || c.choices?.[0]?.delta?.thinking)
    expect(thinkingChunks.length).toBe(0)

    // Usage chunk has reasoning_tokens > 0
    const usageChunk = chunks.find(c => c.usage)
    expect(usageChunk?.usage.completion_tokens_details.reasoning_tokens).toBeGreaterThan(0)
  })
})

// ═══ Non-Streaming Buffer Tests ═════════════════════════════════════

describe('bufferToNonStreaming', () => {
  test('accumulates text into message.content', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world!' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ]

    const response = await bufferToNonStreaming(makeAnthropicResponse(events), DEFAULT_OPTS)
    const body = await response.json() as any

    expect(body.object).toBe('chat.completion')
    expect(body.id).toBe('chatcmpl-test123')
    expect(body.choices).toHaveLength(1)
    expect(body.choices[0].message.role).toBe('assistant')
    expect(body.choices[0].message.content).toBe('Hello world!')
    expect(body.choices[0].message.refusal).toBeNull()
    expect(body.choices[0].message.annotations).toEqual([])
    expect(body.choices[0].finish_reason).toBe('stop')
    expect(body.usage.prompt_tokens).toBe(20)
    expect(body.usage.completion_tokens).toBe(3)
    expect(body.usage.prompt_tokens_details.cached_tokens).toBe(10)
  })

  test('tool_use accumulated into message.tool_calls', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc_1', name: 'search' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"test"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]

    const response = await bufferToNonStreaming(makeAnthropicResponse(events), DEFAULT_OPTS)
    const body = await response.json() as any

    expect(body.choices[0].message.tool_calls).toHaveLength(1)
    expect(body.choices[0].message.tool_calls[0].id).toBe('tc_1')
    expect(body.choices[0].message.tool_calls[0].type).toBe('function')
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('search')
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe('{"q":"test"}')
    expect(body.choices[0].finish_reason).toBe('tool_calls')
  })

  test('json_schema: tool input becomes content', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tc_1', name: 'person' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"Bob"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]

    const opts = { ...DEFAULT_OPTS, isJsonSchema: true, schemaToolName: 'person' }
    const response = await bufferToNonStreaming(makeAnthropicResponse(events), opts)
    const body = await response.json() as any

    expect(body.choices[0].message.content).toBe('{"name":"Bob"}')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
  })
})

// ═══ Models Endpoint ════════════════════════════════════════════════

describe('handleModelsRequest', () => {
  test('returns OpenAI-format model list', async () => {
    const response = handleModelsRequest()
    const body = await response.json() as any

    expect(body.object).toBe('list')
    expect(body.data.length).toBeGreaterThan(0)
    for (const m of body.data) {
      expect(m.object).toBe('model')
      expect(m.owned_by).toBe('anthropic')
      expect(typeof m.id).toBe('string')
      expect(typeof m.created).toBe('number')
    }
  })
})

// ═══ Error Response ═════════════════════════════════════════════════

describe('openaiErrorResponse', () => {
  test('matches OpenAI error format', async () => {
    const response = openaiErrorResponse(401, 'Invalid key', 'authentication_error', 'invalid_api_key')
    expect(response.status).toBe(401)
    const body = await response.json() as any
    expect(body.error.message).toBe('Invalid key')
    expect(body.error.type).toBe('authentication_error')
    expect(body.error.code).toBe('invalid_api_key')
  })
})
