/**
 * Per-session org/token pinning — e2e via ProxyClient.handleRequest().
 *
 * Spec:  docs/superpowers/specs/2026-06-02-per-session-org-token-pin-design.md
 * Plan:  docs/superpowers/plans/2026-06-02-per-session-org-token-pin.md
 *
 * Cross-org login must HOLD the old org+token per session (200, not 400);
 * same-org refresh adopts the fresh token; an explicit [%reload-ok%] / cli
 * reload rebinds; a cross-org pin whose old token expired forces a 401-stop.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'org-pin-'))
let seq = 0

/** Minimal SSE upstream that records the outgoing Authorization header. */
function recordingUpstream(sink: { auth: string[] }) {
  return {
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      sink.auth.push(init.headers['authorization'] ?? init.headers['Authorization'] ?? '')
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  }
}

function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
}

describe('Layer 1 — atomic account snapshot', () => {
  test('notifyCredentialsChanged invalidates BOTH credentials and org-id', () => {
    let creds = 0, org = 0
    const c = mkClient({
      credentialsProvider: { getAccessToken: async () => 't', invalidate() { creds++ } },
      orgIdResolver: { current: () => 'org-A', invalidate() { org++ } },
    })
    c.notifyCredentialsChanged('test')
    expect(creds).toBe(1)
    expect(org).toBe(1)
    c.stop()
  })
})

// ── Layer 2 — per-session pin ──────────────────────────────────────────────

const FILLER = 'x'.repeat(6000)   // body big enough to clear the guard threshold
const reqBody = (extra = '') => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER + ' ' + extra }],
})

/** A live account whose org/token/expiry can be flipped between requests to
 *  simulate `claude login` (same-org refresh or cross-org switch). */
function mutableAccount(init: { orgId: string | null; token: string; expiresAt: number | null }) {
  const state = { ...init }
  return {
    state,
    credentialsProvider: {
      getAccessToken: async () => state.token,
      invalidate() {},
      currentExpiresAt: () => state.expiresAt,
    },
    orgIdResolver: { current: () => state.orgId, invalidate() {} },
  }
}

describe('Layer 2 — per-session org/token pin', () => {
  test('new session auto-pins the current account and uses its token', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'new-1' })
    expect(r.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-A')
    c.stop()
  })

  test('same-org refresh adopts the FRESH token (never the snapshot)', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 's-same' })   // pin org-A / tok-A
    m.state.token = 'tok-A2'                                         // same org, refreshed token
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 's-same' })
    expect(r.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-A2')
    c.stop()
  })

  test('cross-org login HOLDS the old token — 200, NOT 400; old org+token kept', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })   // pin org-A / tok-A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'                // user logs into org-B
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })
    expect(r.status).toBe(200)                                      // NOT blocked
    expect(auth.at(-1)).toBe('Bearer tok-A')                        // HELD on the old org's token
    c.stop()
  })

  test('two sessions, two orgs concurrently: old holds A, new pins B', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 'old' })      // old pins A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const rNew = await c.handleRequest(reqBody(), {}, { sessionId: 'fresh' })   // new pins B
    const rOld = await c.handleRequest(reqBody(), {}, { sessionId: 'old' })     // old holds A
    expect(rNew.status).toBe(200); expect(rOld.status).toBe(200)
    // last two captured auths: fresh→tok-B then old→tok-A
    expect(auth.slice(-2)).toEqual(['Bearer tok-B', 'Bearer tok-A'])
    c.stop()
  })

  test('cross-org with an EXPIRED pinned token → 401-stop with reload instructions', async () => {
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() - 1000 })  // already past
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 's-exp' })    // pin org-A, expiresAt in the past
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 's-exp' })
    expect(r.status).toBe(401)
    const j = await r.json() as { error?: { message?: string } }
    expect(j.error?.message).toContain('[%reload-ok%]')
    c.stop()
  })

  test('[%reload-ok%] rebinds the session to the current org+token', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 's-rb' })     // pin org-A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const r = await c.handleRequest(reqBody('[%reload-ok%]'), {}, { sessionId: 's-rb' })
    expect(r.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-B')                        // rebound to the new org
    c.stop()
  })
})
