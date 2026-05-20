/**
 * Tests: claude-max-proxy/src/upstream.ts parseSSE — cache_creation subfield
 * extraction (Phase 3.B, plan §3.3).
 *
 * Coverage:
 *   1. message_start with full `usage.cache_creation` object → 5m + 1h
 *      subfields appear on yielded message_stop usage.
 *   2. message_start without `cache_creation` object → subfields are
 *      UNDEFINED on yielded usage (omit-when-absent contract; not 0).
 *   3. message_start with `cache_deleted_input_tokens` → captured.
 *   4. Malformed `cache_creation` (non-object) → no crash, subfields absent.
 *
 * Strategy: parseSSE is module-private; we exercise it via `upstreamFetch`
 * by stubbing `fetch` to return a synthetic SSE stream. We only assert on
 * the yielded `message_stop.usage` shape — no real network.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { upstreamFetch } from '../src/upstream.js'
import type { ProxyConfig } from '../src/config.js'

// Minimal ProxyConfig stub — only the fields upstreamFetch dereferences.
const cfg: ProxyConfig = {
  port: 0,
  anthropicBaseUrl: 'https://stub.invalid',
  credentialsPath: '/dev/null',
  logFile: '/dev/null',
  logJsonl: '/dev/null',
  logFormat: 'json',
  logLevel: 'error',
} as unknown as ProxyConfig

// Build a Response whose body is an SSE-framed stream of the given events.
function makeSseResponse(events: unknown[]): Response {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ev of events) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
      }
      controller.enqueue(enc.encode(`data: [DONE]\n\n`))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  })
}

const originalFetch = globalThis.fetch
let nextResponse: Response | null = null

beforeEach(() => {
  nextResponse = null
  const stub = async (): Promise<Response> => {
    if (!nextResponse) throw new Error('test forgot to stage a response')
    const r = nextResponse
    nextResponse = null
    return r
  }
  globalThis.fetch = stub as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// Drain the async generator into an array.
async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = []
  for await (const v of gen) out.push(v)
  return out
}

describe('upstream.parseSSE: cache_creation subfields', () => {
  test('captures ephemeral_5m + ephemeral_1h when cache_creation object present', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 0,
            cache_read_input_tokens: 1800,
            cache_creation_input_tokens: 248,
            cache_creation: {
              ephemeral_5m_input_tokens: 148,
              ephemeral_1h_input_tokens: 100,
            },
          },
        },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 503 } },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop).toBeDefined()
    expect(stop.usage.inputTokens).toBe(5)
    expect(stop.usage.outputTokens).toBe(503)
    expect(stop.usage.cacheReadInputTokens).toBe(1800)
    expect(stop.usage.cacheCreationInputTokens).toBe(248)
    expect(stop.usage.cacheCreation5mInputTokens).toBe(148)
    expect(stop.usage.cacheCreation1hInputTokens).toBe(100)
    expect(stop.stopReason).toBe('end_turn')
  })

  test('omits subfields when cache_creation object absent (single-TTL response)', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_read_input_tokens: 50000,
            cache_creation_input_tokens: 0,
            // NO cache_creation object — single-TTL response
          },
        },
      },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop.usage.cacheReadInputTokens).toBe(50000)
    expect(stop.usage.cacheCreationInputTokens).toBe(0)
    // Critical backward-compat assertion: subfields must be undefined
    // (not 0, not null) so omit-when-absent semantics propagate.
    expect(stop.usage.cacheCreation5mInputTokens).toBeUndefined()
    expect(stop.usage.cacheCreation1hInputTokens).toBeUndefined()
    expect(stop.usage.cacheDeletedInputTokens).toBeUndefined()
  })

  test('captures only the subfield that is present (partial cache_creation)', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 200,
            cache_creation: {
              // 5m only — 1h breakpoint not exercised
              ephemeral_5m_input_tokens: 200,
            },
          },
        },
      },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop.usage.cacheCreation5mInputTokens).toBe(200)
    expect(stop.usage.cacheCreation1hInputTokens).toBeUndefined()
  })

  test('captures cache_deleted_input_tokens (Phase 6 telemetry pre-capture)', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 0,
            cache_deleted_input_tokens: 4096,
          },
        },
      },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop.usage.cacheDeletedInputTokens).toBe(4096)
  })

  test('malformed cache_creation (non-object) does not crash, subfields absent', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null, // upstream API quirk we must survive
          },
        },
      },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop).toBeDefined()
    expect(stop.usage.cacheCreation5mInputTokens).toBeUndefined()
    expect(stop.usage.cacheCreation1hInputTokens).toBeUndefined()
  })

  test('non-numeric ephemeral subfields are ignored (defensive parse)', async () => {
    nextResponse = makeSseResponse([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 1,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: {
              ephemeral_5m_input_tokens: 'oops' as unknown as number, // wire malformed
              ephemeral_1h_input_tokens: 42,
            },
          },
        },
      },
      { type: 'message_stop' },
    ])

    const events = await drain(upstreamFetch(cfg, {}, {}))
    const stop = events.find((e: any) => e.type === 'message_stop') as any
    expect(stop.usage.cacheCreation5mInputTokens).toBeUndefined()
    expect(stop.usage.cacheCreation1hInputTokens).toBe(42)
  })
})
