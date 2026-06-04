/**
 * Real-request transient-upstream retry (proxy-client) — regression 2026-06-04.
 *
 * A brief Anthropic capacity blip (5xx / 529 Overloaded) used to pass straight
 * through to Claude Code as a hard error, so a user mid-resume saw "Repeated 529"
 * and had to manually retry until upstream recovered (incident: session df081b12
 * saw ~3 min of 529s). The proxy now absorbs SHORT transient faults with a
 * bounded, abortable backoff-retry on the REAL request path. 429 (quota) and
 * other 4xx are NOT retried.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'real-retry-'))
let seq = 0

const FILLER = 'lorem ipsum dolor sit amet '.repeat(40)

const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'system prompt ' + FILLER, cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

function okResponse() {
  return new Response(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
function errResponse(status: number, retryAfter?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
    { status, headers },
  )
}

function mkClient(upstreamFetcher: ProxyClientOptions['upstreamFetcher'], extra: Partial<ProxyClientOptions> = {}) {
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher,
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
  // Shrink the backoff so tests don't wait the real 1/2/4s.
  ;(c as any).realRetryDelaysMs = [5, 5, 5]
  return c
}

describe('real-request transient-upstream retry', () => {
  test('529 twice then 200 → retried transparently; client sees 200', async () => {
    let calls = 0
    const c = mkClient({
      fetch: async () => { calls++; return calls <= 2 ? errResponse(529) : okResponse() },
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-200' })
    expect(r.status).toBe(200)
    expect(calls).toBe(3)            // 1 initial + 2 retries, then success
    c.stop()
  })

  test('persistent 529 → budget exhausted → 529 surfaced to client', async () => {
    let calls = 0
    const c = mkClient({ fetch: async () => { calls++; return errResponse(529) } })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-exhaust' })
    expect(r.status).toBe(529)
    expect(calls).toBe(4)            // 1 initial + 3 retries (budget length), then give up
    c.stop()
  })

  test('429 (quota) is NOT retried — single upstream call, passthrough', async () => {
    let calls = 0
    const c = mkClient({ fetch: async () => { calls++; return errResponse(429) } })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-429' })
    expect(r.status).toBe(429)
    expect(calls).toBe(1)
    c.stop()
  })

  test('400 (client error) is NOT retried — single upstream call, passthrough', async () => {
    let calls = 0
    const c = mkClient({ fetch: async () => { calls++; return errResponse(400) } })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-400' })
    expect(r.status).toBe(400)
    expect(calls).toBe(1)
    c.stop()
  })

  test('503 with retry-after:0 → honored, recovers on next attempt', async () => {
    let calls = 0
    const c = mkClient({
      fetch: async () => { calls++; return calls === 1 ? errResponse(503, '0') : okResponse() },
    })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-503-ra' })
    expect(r.status).toBe(200)
    expect(calls).toBe(2)
    c.stop()
  })
})
