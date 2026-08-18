/**
 * Unidentified request — served, never warmed.
 *
 * A caller that names no session (no `x-claude-code-session-id` header, no
 * session id in `metadata.user_id`) is given a synthetic `anon-*` id that is
 * unique to that one request. Arming keepalive under such an id opens a cache
 * slot no later request can ever match — so KA warms it for nobody until the
 * owner pid dies.
 *
 * MEASURED on the live proxy 2026-08-18 (research/cache-accounting-remeasure-
 * 2026-08-18.md): 463 of 521 persisted prefixes were one-shot `anon-*` keys,
 * every one of them with exactly one entry; 428 were still being warmed a
 * median of 8.7h (max 24.8h) after their single request; in one 29-minute
 * window 70 of 89 KA fires (79%) and 6 592 380 cache-read tokens (36%) went to
 * sessions that could not return.
 *
 * These tests pin the invariant at the seam that makes it airtight: with
 * `idSource:'none'` the engine is never primed, so nothing can be committed to
 * the KA registry and nothing is written to prefix history.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import type { ProxyEvent } from '../src/proxy-ports.js'

function sseResponse(): Response {
  return new Response(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

const TMP = mkdtempSync(join(tmpdir(), 'unidentified-'))
let seq = 0

function mkClient(events: ProxyEvent[], extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => sseResponse() },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default' },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit(e) { events.push(e) } },
    ...extra,
  })
}

const FILLER = 'x'.repeat(6000)
const body = () => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

/** Read back whatever the client persisted, tolerating "nothing was written". */
function historyKeys(c: ProxyClient): string[] {
  const path = (c as unknown as { prefixHistoryPath: string }).prefixHistoryPath
  if (!existsSync(path)) return []
  try { return Object.keys(JSON.parse(readFileSync(path, 'utf8'))) } catch { return [] }
}

describe('unidentified request (idSource:none)', () => {
  test('is forwarded — being unnamed must never cost the caller its answer', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    const r = await c.handleRequest(body(), {}, { sessionId: 'anon-abc', idSource: 'none' })
    expect(r.status).toBe(200)
    c.stop()
  })

  test('primes no keepalive lineage — the slot it would open is unreachable forever after', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    await c.handleRequest(body(), {}, { sessionId: 'anon-abc', idSource: 'none' })
    expect(c._sessionPrimedLineages('anon-abc')).toBe(0)
    c.stop()
  })

  test('writes no prefix history — a one-shot key can only accumulate, never match', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    await c.handleRequest(body(), {}, { sessionId: 'anon-abc', idSource: 'none' })
    c.stop()
    expect(historyKeys(c).filter(k => k.startsWith('anon-abc:'))).toHaveLength(0)
  })

  test('says so in the journal, so "never reached the proxy" stays distinguishable from "reached it unnamed"', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    await c.handleRequest(body(), {}, { sessionId: 'anon-abc', idSource: 'none' })
    c.stop()
    const start = events.find(e => e.kind === 'REAL_REQUEST_START')
    expect(start?.idSource).toBe('none')
    expect(events.some(e => e.kind === 'REQUEST_UNIDENTIFIED')).toBe(true)
  })
})

describe('identified request — the control', () => {
  test('a named session IS armed and IS remembered', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    await c.handleRequest(body(), {}, { sessionId: 'named-1', idSource: 'header' })
    expect(c._sessionPrimedLineages('named-1')).toBeGreaterThan(0)
    c.stop()
    expect(historyKeys(c).filter(k => k.startsWith('named-1:')).length).toBeGreaterThan(0)
  })

  test('idSource defaults to header — a caller that pre-dates the field is still warmed', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    await c.handleRequest(body(), {}, { sessionId: 'legacy-1' })
    expect(c._sessionPrimedLineages('legacy-1')).toBeGreaterThan(0)
    c.stop()
  })

  test('a session recovered from the body is treated as fully named', async () => {
    const events: ProxyEvent[] = []
    const c = mkClient(events)
    const uuid = '55832329-b2c8-45b1-bbe5-3acab3dedca9'
    await c.handleRequest(body(), {}, { sessionId: uuid, idSource: 'body' })
    expect(c._sessionPrimedLineages(uuid)).toBeGreaterThan(0)
    c.stop()
    expect(historyKeys(c).filter(k => k.startsWith(uuid + ':')).length).toBeGreaterThan(0)
  })
})
