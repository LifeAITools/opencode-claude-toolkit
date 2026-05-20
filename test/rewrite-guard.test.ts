/**
 * Rewrite guard — end-to-end integration test.
 *
 * Drives ProxyClient.handleRequest() with a mocked upstream + credentials and
 * the guard enabled via the test fixture (_setup-keepalive-fixture.ts →
 * rewriteGuard.enabled=true, minRewriteTokens=10).
 *
 * Verifies the guard ONLY blocks an avoidable (idle-past-TTL) rewrite that the
 * user has not confirmed — never the first request, never a marked one.
 */

import { describe, test, expect } from 'bun:test'
import { ProxyClient } from '../src/proxy-client.js'

// Minimal upstream mock — a tiny SSE body so handleRequest's tee()/parse path
// works for requests that PASS the guard. Blocked requests never reach it.
function sseResponse(): Response {
  return new Response(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

function mkClient() {
  return new ProxyClient({
    // kaCacheTtlSec=1 → predictCacheMiss treats a >1s idle as ttl-expiry,
    // so the avoidable-rewrite path is reachable inside a fast test.
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => sseResponse() },
  })
}

// Body padded so predictedTokens (~bodyBytes/4) clears the 1000-token guard
// threshold — a realistic "massive write" magnitude, not a synthetic tiny one.
const FILLER = 'x'.repeat(6000)
const reqBody = (extra = '') => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER + ' ' + extra }],
})

describe('rewrite guard (e2e via handleRequest, guard enabled by fixture)', () => {
  test('first request is NEVER blocked (expected:cold-start)', async () => {
    const c = mkClient()
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-1' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('idle-past-TTL avoidable rewrite WITHOUT marker → 400 cache_rewrite_guard', async () => {
    const c = mkClient()
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-2' })   // req1: cold-start, passes
    await Bun.sleep(1200)                                              // idle 1.2s > 1s TTL
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-2' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string; message?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    expect(j.error?.message).toContain('[cache-rewrite-ok]')   // tells the user the marker
    c.stop()
  })

  test('same idle-past-TTL rewrite WITH the override marker → passes the guard', async () => {
    const c = mkClient()
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-3' })
    await Bun.sleep(1200)
    // Latest user message carries the marker → guard lets it through.
    const r = await c.handleRequest(reqBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-sess-3' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('rapid consecutive requests (within TTL) are NOT blocked', async () => {
    const c = mkClient()
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-4' })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-4' })  // no idle gap
    expect(r.status).not.toBe(400)
    c.stop()
  })
})
