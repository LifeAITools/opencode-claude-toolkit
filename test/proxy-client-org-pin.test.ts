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

describe('Layer 2 — cli reload rebinds the pin', () => {
  test('global reloadSessions() rebinds ALL sessions to the current org', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 'g1' })       // pin org-A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    c.reloadSessions('cli')                                         // global rebind (drops pins)
    // Post-reload the pin is gone, so the next turn is a cross-org cold rewrite.
    // The rewrite guard now requires explicit consent for that migration; the
    // session signals it with [%reload-ok%] (= rebind to the current org). This
    // exercises the SAME pin-rebind mechanic (→ tok-B) while honoring the guard.
    const r = await c.handleRequest(reqBody('[%reload-ok%]'), {}, { sessionId: 'g1' })
    expect(r.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-B')                        // re-pinned to org-B
    c.stop()
  })

  test('targeted reloadSessions(_, sid) rebinds ONLY that session; others stay held', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 'keep' })     // pin org-A
    await c.handleRequest(reqBody(), {}, { sessionId: 'move' })     // pin org-A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    c.reloadSessions('cli', 'move')                                 // rebind only 'move' (drops its pin)
    // 'move' lost its pin → cross-org migration → consent via [%reload-ok%].
    // 'keep' still holds org-A (pin intact, token alive) → guard stands down on
    // the HOLD, no marker needed.
    const rMove = await c.handleRequest(reqBody('[%reload-ok%]'), {}, { sessionId: 'move' })
    const rKeep = await c.handleRequest(reqBody(), {}, { sessionId: 'keep' })
    expect(rMove.status).toBe(200); expect(rKeep.status).toBe(200)
    expect(auth.slice(-2)).toEqual(['Bearer tok-B', 'Bearer tok-A'])  // move→B (rebound), keep→A (held)
    c.stop()
  })
})

// ── Кэш-лес сессия (x-claude-max-cache: none) — НЕ пинится ──────────────────
// Фаундер 09.10.2026: «всё должно быть динамично; интернет-доступ идёт через тот же
// аккаунт, что у потребителя». У кэш-лес сессии защищать нечего, поэтому пин ей не
// нужен: она идёт за текущей живой учёткой (и не застревает на исчерпанной).
describe('Кэш-лес сессия не закрепляется за организацией', () => {
  const noCache = (extra = '') => JSON.stringify({
    model: 'claude-opus-4-7',
    system: [{ type: 'text', text: 'system prompt' }],
    tools: [],
    messages: [{ role: 'user', content: 'read a page ' + FILLER + ' ' + extra }],
  })

  test('не оставляет пина и следует за текущей учёткой', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    const r1 = await c.handleRequest(noCache(), { 'x-claude-max-cache': 'none' }, { sessionId: 'svc' })
    expect(r1.status).toBe(200)
    expect((c as any).sessionPins.has('svc')).toBe(false)
    expect((c as any).orgVault.getPin('svc')).toBeNull()
    // Флот переехал → кэш-лес сессия идёт за ТЕКУЩЕЙ, а не держит старую.
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const r2 = await c.handleRequest(noCache(), { 'x-claude-max-cache': 'none' }, { sessionId: 'svc' })
    expect(r2.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-B')
    c.stop()
  })

  test('снимает уже стоящий пин кэш-лес сессии', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 'svc2' })   // обычный вызов → пин на org-A
    expect((c as any).sessionPins.has('svc2')).toBe(true)
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const r = await c.handleRequest(noCache(), { 'x-claude-max-cache': 'none' }, { sessionId: 'svc2' })
    expect(r.status).toBe(200)
    expect((c as any).sessionPins.has('svc2')).toBe(false)
    expect((c as any).orgVault.getPin('svc2')).toBeNull()
    expect(auth.at(-1)).toBe('Bearer tok-B')
    c.stop()
  })

  test('снимает PERSISTED-пин, даже когда память пуста (пин пережил перезапуск)', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    ;(c as any).orgVault.setPin('svc3', 'org-A')   // persisted-пин, в sessionPins его нет
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    const r = await c.handleRequest(noCache(), { 'x-claude-max-cache': 'none' }, { sessionId: 'svc3' })
    expect(r.status).toBe(200)
    expect((c as any).orgVault.getPin('svc3')).toBeNull()
    expect(auth.at(-1)).toBe('Bearer tok-B')
    c.stop()
  })

  test('ctx.cacheOptOut (заголовок вырезан enrich) тоже не пинит', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    const r = await c.handleRequest(noCache(), {}, { sessionId: 'svc4', cacheOptOut: true })
    expect(r.status).toBe(200)
    expect((c as any).sessionPins.has('svc4')).toBe(false)
    expect((c as any).orgVault.getPin('svc4')).toBeNull()
    c.stop()
  })
})
