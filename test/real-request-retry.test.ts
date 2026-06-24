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
  // Shrink the backoff so tests don't wait the real 1/2/4/8s — but keep the
  // production budget LENGTH (4 retries) so the exhaustion test stays faithful.
  ;(c as any).realRetryDelaysMs = [5, 5, 5, 5]
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
    expect(calls).toBe(5)            // 1 initial + 4 retries (budget length), then give up
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

  // Regression 2026-06-24: Anthropic emits `retry-after: 0` during wide
  // overloads. The proxy used to obey it verbatim (delayMs=0) → it retried an
  // already-overloaded upstream with zero spacing, burning the whole budget in
  // <2s and surfacing "Repeated 529" instantly. retry-after must only LENGTHEN
  // the wait, never shorten it below the exponential floor.
  test('retry-after:0 does NOT collapse backoff below baseline floor', async () => {
    const events: any[] = []
    let calls = 0
    const c = mkClient(
      { fetch: async () => { calls++; return errResponse(529, '0') } },
      { eventEmitter: { emit: (e: any) => events.push(e) } as any },
    )
    ;(c as any).realRetryDelaysMs = [40, 40, 40, 40]   // known baseline
    ;(c as any).retryRandom = () => 0.5                // pin jitter to no-op
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'retry-floor' })
    expect(r.status).toBe(529)
    const retries = events.filter((e) => e.kind === 'REAL_REQUEST_RETRY')
    expect(retries.length).toBe(4)
    // Every backoff honored the baseline floor despite retry-after:0 — none at 0.
    for (const ev of retries) expect(ev.delayMs).toBe(40)
    c.stop()
  })
})
