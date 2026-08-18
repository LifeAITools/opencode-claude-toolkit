/**
 * Outcome invariant on the REAL request path — 2026-08-18.
 *
 * Every request that emits REAL_REQUEST_START must also emit exactly one
 * terminal event (COMPLETE / ERROR / ABORTED). Four exits used to emit nothing:
 * the KA rewrite-guard 429, a client disconnect during retry backoff, an
 * upstream response with no body, and — by far the largest — a client that
 * walks away mid-stream.
 *
 * The cost was not cosmetic. Measured over 4.5h of live traffic: 591 of 6413
 * requests (9%; 51% of the worst session's) had no outcome at all, alongside 576
 * anonymous `unhandledRejection: null is not an object`. An in-flight counter
 * built as start-minus-outcome therefore drifts upward for ever, and it
 * manufactured a 19x "concurrency causes 529" correlation that only fell when it
 * was cross-checked against a window-density count.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'outcome-inv-'))
let seq = 0

const FILLER = 'lorem ipsum dolor sit amet '.repeat(40)
const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'system prompt ' + FILLER, cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

type Ev = { kind: string, [k: string]: any }

function mkClient(upstreamFetcher: ProxyClientOptions['upstreamFetcher'], extra: Partial<ProxyClientOptions> = {}) {
  const events: Ev[] = []
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher,
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => { events.push(e) } },
    ...extra,
  })
  ;(c as any).realRetryDelaysMs = [5, 5, 5, 5]
  return { c, events }
}

const terminal = (events: Ev[]) => events.filter(
  (e) => e.kind === 'REAL_REQUEST_COMPLETE' || e.kind === 'REAL_REQUEST_ERROR' || e.kind === 'REAL_REQUEST_ABORTED',
)
const starts = (events: Ev[]) => events.filter((e) => e.kind === 'REAL_REQUEST_START')

function sseResponse(chunks: string[]) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(new TextEncoder().encode(ch))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

describe('outcome invariant: a started request always reports how it ended', () => {
  test('upstream with no body → 502 is REPORTED, not silent', async () => {
    const { c, events } = mkClient({
      fetch: async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'no-body' })
    expect(r.status).toBe(502)
    expect(starts(events).length).toBe(1)
    const t = terminal(events)
    expect(t.length).toBe(1)
    expect(t[0]!.kind).toBe('REAL_REQUEST_ERROR')
    expect(t[0]!.status).toBe(502)
    c.stop()
  })

  test('client stops reading mid-stream → REAL_REQUEST_ABORTED names it', async () => {
    // Upstream keeps the stream open; the client cancels after the first chunk.
    const { c, events } = mkClient({
      fetch: async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n')) },
          // never closes — mimics a long turn the client walks away from
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'client-away' })
    expect(r.status).toBe(200)
    const reader = r.body!.getReader()
    await reader.read()          // take the first chunk
    await reader.cancel()        // then walk away, as Claude Code does on Esc
    await new Promise((res) => setTimeout(res, 20))

    const aborted = events.filter((e) => e.kind === 'REAL_REQUEST_ABORTED')
    expect(aborted.length).toBe(1)
    expect(aborted[0]!.phase).toBe('streaming')
    expect(String(aborted[0]!.msg)).toContain('client stopped reading')
    c.stop()
  })

  test('the abort is named ONCE, however many times the stream is cancelled', async () => {
    const { c, events } = mkClient({
      fetch: async () => new Response(
        new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n')) },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'abort-once' })
    const reader = r.body!.getReader()
    await reader.read()
    await reader.cancel()
    await reader.cancel().catch(() => {})
    await new Promise((res) => setTimeout(res, 20))
    expect(events.filter((e) => e.kind === 'REAL_REQUEST_ABORTED').length).toBe(1)
    c.stop()
  })

  test('a stream read to the end is COMPLETE, never ABORTED', async () => {
    const { c, events } = mkClient({
      fetch: async () => sseResponse(['event: message_stop\ndata: {"type":"message_stop"}\n\n']),
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'read-fully' })
    await r.text()
    await new Promise((res) => setTimeout(res, 30))
    expect(events.filter((e) => e.kind === 'REAL_REQUEST_ABORTED').length).toBe(0)
    expect(events.filter((e) => e.kind === 'REAL_REQUEST_COMPLETE').length).toBe(1)
    c.stop()
  })

  test('the wrapper does not alter a single byte', async () => {
    const payload = 'event: message_start\ndata: {"type":"message_start"}\n\n'
      + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
    const { c } = mkClient({ fetch: async () => sseResponse([payload]) })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'byte-for-byte' })
    expect(await r.text()).toBe(payload)
    c.stop()
  })
})
