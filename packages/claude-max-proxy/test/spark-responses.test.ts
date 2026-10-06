/**
 * Tests: spark-translate.ts — Anthropic Messages ↔ Responses translation.
 *
 * Coverage:
 *   1. Request translation: system, messages, tools, tool_choice, model gate, max floor
 *   2. LIVE FIXTURE 06.10.2026 (test/fixtures/spark-0610-response.json): the exact
 *      gateway answer — text taken from message/output_text, reasoning dropped+counted
 *   3. SSE transform: Responses stream → Anthropic SSE (text + tool_call + stop)
 *   4. Buffered assembly, error shape, models endpoint
 *
 * THE FIXTURE TEST IS THE GATE: it parses what the gateway REALLY returned,
 * not what we imagine. If the gateway changes shape, this test — not prod — breaks.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  translateToResponsesBody,
  translateFromResponsesObject,
  transformResponsesSSEToAnthropic,
  bufferResponsesToMessages,
  sparkErrorResponse,
  handleSparkModelsRequest,
  isSparkModel,
  SPARK_MIN_OUTPUT_TOKENS,
  type MessagesRequest,
} from '../src/spark-translate.js'

// ─── Request translation ─────────────────────────────────────────────

describe('translateToResponsesBody', () => {
  test('system + user text → instructions + input', () => {
    const req: MessagesRequest = {
      model: 'muse-spark-1.3-contributor',
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1024,
    }
    const { body, bumpedMaxTokens } = translateToResponsesBody(req)
    expect(body.model).toBe('muse-spark-1.3-contributor')
    expect(body.instructions).toBe('You are helpful.')
    expect(body.input).toHaveLength(1)
    expect(body.input[0]).toMatchObject({ type: 'message', role: 'user' })
    expect(body.max_output_tokens).toBe(1024)
    expect(body.stream).toBe(false)
    expect(bumpedMaxTokens).toBe(false)
  })

  test('max_tokens below floor is raised (measured: 50+high effort → incomplete)', () => {
    const { body, bumpedMaxTokens } = translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 50,
    })
    expect(body.max_output_tokens).toBe(SPARK_MIN_OUTPUT_TOKENS)
    expect(bumpedMaxTokens).toBe(true)
  })

  test('tool_use + tool_result round-trip to function items', () => {
    const { body } = translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }],
        },
      ],
      tools: [{ name: 'get_weather', description: 'Weather', input_schema: { type: 'object' } }],
      tool_choice: { type: 'auto' },
      max_tokens: 1024,
    })
    const items = body.input as any[]
    // order: user text, assistant text, function_call, function_call_output
    expect(items[1]).toMatchObject({ type: 'message', role: 'assistant' })
    expect(items[2]).toMatchObject({ type: 'function_call', call_id: 'toolu_1', name: 'get_weather' })
    expect(JSON.parse(items[2].arguments)).toMatchObject({ city: 'Paris' })
    expect(items[3]).toMatchObject({ type: 'function_call_output', call_id: 'toolu_1', output: 'sunny' })
    expect(body.tools).toMatchObject([{ type: 'function', name: 'get_weather' }])
    expect(body.tool_choice).toBe('auto')
  })

  test('tool_choice any → required; named → function', () => {
    const base: MessagesRequest = { model: 'muse-spark-1.3-contributor', messages: [{ role: 'user', content: 'x' }], max_tokens: 1024 }
    expect(translateToResponsesBody({ ...base, tool_choice: { type: 'any' } }).body.tool_choice).toBe('required')
    expect(translateToResponsesBody({ ...base, tool_choice: { type: 'tool', name: 't' } }).body.tool_choice)
      .toMatchObject({ type: 'function', name: 't' })
  })

  test('reasoning effort defaults to minimal, override respected', () => {
    const base: MessagesRequest = { model: 'muse-spark-1.3-contributor', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1024 }
    expect(translateToResponsesBody(base).body.reasoning).toMatchObject({ effort: 'minimal' })
    expect(translateToResponsesBody(base, { reasoningEffort: 'low' }).body.reasoning).toMatchObject({ effort: 'low' })
  })

  test('image blocks ride as input_image (base64 and url), never dropped', () => {
    const { body } = translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is here?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } } as any,
        ],
      }],
      max_tokens: 1024,
    })
    const parts = (body.input[0] as any).content
    expect(parts).toHaveLength(2)
    expect(parts[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/jpeg;base64,AAA' })
  })

  test('mime sniffed from payload when media_type absent; unknown refused', () => {
    const { body } = translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{
        role: 'user',
        content: [
          // 'iVBORw0KGgo' = PNG magic in base64
          { type: 'image', source: { type: 'base64', data: 'iVBORw0KGgoAAAANSUhEUg' } } as any,
        ],
      }],
      max_tokens: 1024,
    })
    expect((body.input[0] as any).content[0].image_url.startsWith('data:image/png;base64,')).toBe(true)
    expect(() => translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'AAAAAAAAAAAA' } } as any] }],
      max_tokens: 1024,
    })).toThrow(/unrecognised payload/)
  })

  test('image inside tool_result rides a separate message (output is string-only)', () => {
    const { body } = translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result', tool_use_id: 'toolu_9',
          content: [
            { type: 'text', text: 'rendered 900x500' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } },
          ],
        } as any],
      }],
      max_tokens: 1024,
    })
    const items = body.input as any[]
    expect(items[0]).toMatchObject({ type: 'function_call_output', call_id: 'toolu_9', output: 'rendered 900x500' })
    expect(items[1]).toMatchObject({ type: 'message', role: 'user' })
    expect(items[1].content[0]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,BBB' })
  })

  test('unknown block riding with text refuses loudly instead of vanishing', () => {
    expect(() => translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'document', source: {} } as any] }],
      max_tokens: 1024,
    })).toThrow(/would vanish/)
    expect(() => translateToResponsesBody({
      model: 'muse-spark-1.3-contributor',
      messages: [{ role: 'user', content: [{ type: 'image' } as any] }],
      max_tokens: 1024,
    })).toThrow(/without base64\/url payload/)
  })

  test('model gate: spark passes, everything else fails', () => {
    expect(isSparkModel('muse-spark-1.3-contributor')).toBe(true)
    expect(isSparkModel('muse-spark-1.2')).toBe(true)
    expect(isSparkModel('claude-sonnet-4-6')).toBe(false)
    expect(isSparkModel('gpt-5')).toBe(false)
  })
})

// ─── Live fixture 06.10.2026 ─────────────────────────────────────────

describe('live fixture spark-0610-response.json', () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, 'fixtures', 'spark-0610-response.json'), 'utf8'),
  )

  test('text comes from message/output_text, reasoning is dropped and COUNTED', () => {
    const { message, droppedReasoning } = translateFromResponsesObject(fixture)
    expect(droppedReasoning).toBe(1)
    expect(message.content).toHaveLength(1)
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'Париж' })
    // The opaque blob must not leak into the answer in ANY form.
    expect(JSON.stringify(message)).not.toContain('Q-PaDgEn5BpffO0SGX0IOqyr')
    expect(message.stop_reason).toBe('end_turn')
    expect(message.usage).toMatchObject({ input_tokens: 16, output_tokens: 208 })
    expect(message.model).toBe('muse-spark-1.3-contributor')
  })

  test('buffered assembly parses the same object', async () => {
    const upstream = new Response(JSON.stringify(fixture), { status: 200 })
    const { message, droppedReasoning } = await bufferResponsesToMessages(upstream)
    expect(droppedReasoning).toBe(1)
    expect(message.content[0]).toMatchObject({ type: 'text', text: 'Париж' })
  })

  test('function_call item becomes tool_use; incomplete/max → max_tokens', () => {
    const { message } = translateFromResponsesObject({
      id: 'resp_x', model: 'muse-spark-1.3-contributor', status: 'completed',
      output: [{ type: 'function_call', call_id: 'call_9', name: 'get_weather', arguments: '{"city":"Paris"}' }],
      usage: { input_tokens: 100, output_tokens: 50 },
    })
    expect(message.stop_reason).toBe('tool_use')
    expect(message.content[0]).toMatchObject({ type: 'tool_use', id: 'call_9', name: 'get_weather', input: { city: 'Paris' } })

    const cut = translateFromResponsesObject({
      id: 'resp_y', model: 'muse-spark-1.3-contributor', status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [], usage: { input_tokens: 10, output_tokens: 50 },
    })
    expect(cut.message.stop_reason).toBe('max_tokens')
  })
})

// ─── SSE transform ───────────────────────────────────────────────────

function makeResponsesSSE(events: unknown[]): Response {
  const encoder = new TextEncoder()
  const lines = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('')
  return new Response(
    new ReadableStream({
      start(c) { c.enqueue(encoder.encode(lines)); c.close() },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

async function collectAnthropicEvents(response: Response): Promise<any[]> {
  const text = await response.text()
  const out: any[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) {
      try { out.push(JSON.parse(line.slice(6))) } catch { /* skip */ }
    }
  }
  return out
}

describe('transformResponsesSSEToAnthropic', () => {
  test('text deltas + completion usage arrive as Anthropic events', async () => {
    const upstream = makeResponsesSSE([
      { type: 'response.output_text.delta', item_id: 'it_1', delta: 'Па' },
      { type: 'response.output_text.delta', item_id: 'it_1', delta: 'риж' },
      { type: 'response.output_item.done', item: { id: 'it_1', type: 'message' } },
      { type: 'response.completed', response: { usage: { input_tokens: 16, output_tokens: 334 } } },
    ])
    const events = await collectAnthropicEvents(
      await transformResponsesSSEToAnthropic(upstream, { messageId: 'msg_test', model: 'muse-spark-1.3-contributor' }),
    )
    const kinds = events.map(e => e.type)
    expect(kinds[0]).toBe('message_start')
    expect(kinds).toContain('content_block_start')
    const deltas = events.filter(e => e.type === 'content_block_delta')
    expect(deltas.map(d => d.delta.text).join('')).toBe('Париж')
    expect(kinds).toContain('content_block_stop')
    const tail = events[kinds.lastIndexOf('message_delta')]
    expect(tail.delta.stop_reason).toBe('end_turn')
    expect(tail.usage.output_tokens).toBe(334)
    expect(kinds[kinds.length - 1]).toBe('message_stop')
    // No Responses framing leaks to the consumer.
    expect(JSON.stringify(events)).not.toContain('response.output_text.delta')
  })

  test('onComplete fires once with stream usage (ceiling metering sees streams)', async () => {
    const upstream = makeResponsesSSE([
      { type: 'response.output_text.delta', item_id: 'it_1', delta: 'Париж' },
      { type: 'response.output_item.done', item: { id: 'it_1', type: 'message' } },
      { type: 'response.completed', response: { usage: { input_tokens: 16, output_tokens: 334 } } },
    ])
    const calls: any[] = []
    const out = await transformResponsesSSEToAnthropic(upstream, {
      messageId: 'msg_test', model: 'muse-spark-1.3-contributor',
      onComplete: (usage, durationMs) => calls.push({ usage, durationMs }),
    })
    await out.text() // drain the stream — onComplete fires at its end
    expect(calls).toHaveLength(1)
    expect(calls[0].usage).toMatchObject({ input_tokens: 16, output_tokens: 334 })
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  test('function call deltas assemble a tool_use block with tool_use stop', async () => {
    const upstream = makeResponsesSSE([
      { type: 'response.output_item.added', item: { id: 'it_2', type: 'function_call', name: 'get_weather', call_id: 'call_9' } },
      { type: 'response.function_call_arguments.delta', item_id: 'it_2', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', item_id: 'it_2', delta: '"Paris"}' },
      { type: 'response.output_item.done', item: { id: 'it_2', type: 'function_call' } },
      { type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 60 } } },
    ])
    const events = await collectAnthropicEvents(
      await transformResponsesSSEToAnthropic(upstream, { messageId: 'msg_test', model: 'muse-spark-1.3-contributor' }),
    )
    const start = events.find(e => e.type === 'content_block_start')
    expect(start.content_block).toMatchObject({ type: 'tool_use', name: 'get_weather' })
    const partials = events.filter(e => e.type === 'content_block_delta').map(d => d.delta.partial_json).join('')
    expect(JSON.parse(partials)).toMatchObject({ city: 'Paris' })
    const tail = events.find(e => e.type === 'message_delta')
    expect(tail.delta.stop_reason).toBe('tool_use')
  })
})

// ─── Error + models ──────────────────────────────────────────────────

describe('sparkErrorResponse + models', () => {
  test('error shape is Anthropic, status preserved', async () => {
    const r = sparkErrorResponse(429, 'slow down', 'rate_limit_error')
    expect(r.status).toBe(429)
    expect(await r.json()).toMatchObject({ type: 'error', error: { message: 'slow down' } })
  })

  test('models list names the verified model', async () => {
    const r = handleSparkModelsRequest('test-version')
    const body = await r.json()
    expect(body.data.map((m: any) => m.id)).toContain('muse-spark-1.3-contributor')
  })
})

describe('самописец исходящего тела', () => {
  test('тело как есть, ключ в заголовках — только длиной', async () => {
    const { mkdtempSync, readdirSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    // NB: body-capture читает env при первом импорте — до этого файла его
    // не импортирует никто, поэтому каталог подменяется здесь.
    const dir = mkdtempSync(join(tmpdir(), 'oc-spark-cap-'))
    process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR = dir
    try {
      const bc = await import('../src/body-capture.js')
      const { translateToResponsesBody } = await import('../src/spark-translate.js')
      const { body } = translateToResponsesBody({
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', content: 'hi' }],
      })
      bc.captureBody(Buffer.from(JSON.stringify(body)), { authorization: 'Bearer SECRETKEY123', 'content-type': 'application/json' }, { sessionId: 'spark-test', sourcePid: null, srcPort: null })
      await new Promise((r) => setTimeout(r, 100))
      const files = readdirSync(dir)
      const dump = files.find((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))!
      expect(dump).toBeTruthy()
      expect(JSON.parse(readFileSync(join(dir, dump), 'utf-8'))).toMatchObject({ model: 'muse-spark-1.3-contributor' })
      const meta = JSON.parse(readFileSync(join(dir, dump.replace('.json', '.meta.json')), 'utf-8'))
      expect(meta.headers.authorization).toBe('<redacted:19b>')
      expect(meta.headers['content-type']).toBe('application/json')
    } finally {
      delete process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
    }
  })
})

describe('кэш-чтение из деталей usage', () => {
  test('cached_tokens едет в нативное поле и в итог; без деталей — ноль', async () => {
    const { translateFromResponsesObject } = await import('../src/spark-translate.js')
    const withCache = translateFromResponsesObject({
      id: 'r1', model: 'm', status: 'completed',
      usage: { input_tokens: 2616, output_tokens: 100, input_tokens_details: { cached_tokens: 2531 } },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    } as any)
    expect(withCache.cachedTokens).toBe(2531)
    expect(withCache.message.usage.cache_read_input_tokens).toBe(2531)
    const cold = translateFromResponsesObject({
      id: 'r2', model: 'm', status: 'completed',
      usage: { input_tokens: 100, output_tokens: 50 },
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    } as any)
    expect(cold.cachedTokens).toBe(0)
    expect('cache_read_input_tokens' in cold.message.usage).toBe(false)
  })

  test('стрим: usage из completed с деталями доезжает до onComplete', async () => {
    const { transformResponsesSSEToAnthropic } = await import('../src/spark-translate.js')
    const sse = 'data: {"type":"response.output_text.delta","item_id":"i1","delta":"hi"}\n\n'
      + 'data: {"type":"response.completed","response":{"usage":{"input_tokens":2616,"output_tokens":100,"input_tokens_details":{"cached_tokens":2531}}}}\n\n'
    const upstream = new Response(sse, { headers: { 'content-type': 'text/event-stream' } })
    let seen: any = null
    const out = await transformResponsesSSEToAnthropic(upstream, {
      messageId: 'm1', model: 'm',
      onComplete: (u) => { seen = u },
    })
    await out.text()
    expect(seen).toMatchObject({ input_tokens: 2616, output_tokens: 100, cached_tokens: 2531 })
  })
})
