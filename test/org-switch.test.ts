/**
 * Per-session org switch + vault-backed HOLD — e2e via ProxyClient.
 *
 * Spec: PRPs/per-org-tokens/02-plan.md. Builds on the Layer-2 pin harness
 * (test/proxy-client-org-pin.test.ts). Organizations are separate accounts:
 * an explicit switch of one session must not disturb others, must carry a
 * one-shot rewrite-guard consent, and a proxy restart must restore pins
 * from the vault instead of silently rebinding onto the current org.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { OrgVault } from '../src/org-vault.js'

const TMP = mkdtempSync(join(tmpdir(), 'org-switch-'))
let seq = 0

function sseUpstream(sink: { auth: string[] }, servedOrg?: string) {
  return {
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      sink.auth.push(init.headers['authorization'] ?? init.headers['Authorization'] ?? '')
      const headers: Record<string, string> = { 'content-type': 'text/event-stream' }
      if (servedOrg) headers['anthropic-organization-id'] = servedOrg
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers },
      )
    },
  }
}

function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'token-current', invalidate() {} },
    upstreamFetcher: sseUpstream({ auth: [] }),
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-current', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    orgVault: new OrgVault(join(TMP, `vault-${seq++}.json`)),
    ...extra,
  })
}

const body = (text: string) => JSON.stringify({
  model: 'claude-opus-4-8',
  messages: [{ role: 'user', content: text }],
})

describe('switchSessionOrg', () => {
  test('pins the session to a vault org; next request uses that token', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({
      orgId: 'org-other', orgName: 'other', accessToken: 'token-other',
      refreshToken: null, expiresAt: Date.now() + 3_600_000, capturedAt: Date.now(),
    })
    const sink = { auth: [] as string[] }
    const c = mkClient({ orgVault: vault, upstreamFetcher: sseUpstream(sink) })

    const r = await c.switchSessionOrg('sess-1', 'org-other')
    expect(r.ok).toBe(true)

    const resp = await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    expect(resp.status).toBe(200)
    expect(sink.auth[sink.auth.length - 1]).toBe('Bearer token-other')
    // pin binding persisted in the vault (only orgId)
    expect(vault.getPin('sess-1')).toEqual({ orgId: 'org-other' })
    c.stop()
  })

  test('unknown org → ok:false with hint, session untouched', async () => {
    const sink = { auth: [] as string[] }
    const c = mkClient({ upstreamFetcher: sseUpstream(sink) })
    const r = await c.switchSessionOrg('sess-1', 'no-such-org')
    expect(r.ok).toBe(false)
    const resp = await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    expect(resp.status).toBe(200)
    expect(sink.auth[0]).toBe('Bearer token-current')   // normal bind, no pin
    c.stop()
  })

  test('switch resolves fuzzy org names', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({
      orgId: 'aaaa1111-2222', orgName: 'team-acme', accessToken: 'token-acme',
      refreshToken: null, expiresAt: null, capturedAt: Date.now(),
    })
    const c = mkClient({ orgVault: vault })
    const r = await c.switchSessionOrg('sess-9', 'acme')
    expect(r.ok && r.orgId).toBe('aaaa1111-2222')
    c.stop()
  })

  test('other sessions are NOT affected by one session\'s switch', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({
      orgId: 'org-other', accessToken: 'token-other',
      refreshToken: null, expiresAt: null, capturedAt: Date.now(),
    })
    const sink = { auth: [] as string[] }
    const c = mkClient({ orgVault: vault, upstreamFetcher: sseUpstream(sink) })
    await c.switchSessionOrg('sess-A', 'org-other')
    await c.handleRequest(body('a'), {}, { sessionId: 'sess-A' })
    await c.handleRequest(body('b'), {}, { sessionId: 'sess-B' })
    expect(sink.auth[0]).toBe('Bearer token-other')
    expect(sink.auth[1]).toBe('Bearer token-current')
    c.stop()
  })
})

describe('vault snapshot + restart pin restore', () => {
  test('current account is snapshotted into the vault on first request', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    const c = mkClient({ orgVault: vault })
    await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    // snapshot is async fire-and-forget — settle microtasks
    await new Promise(r => setTimeout(r, 20))
    const entry = vault.get('org-current') ?? vault.list()[0]
    // orgId comes from readOrgInfoFromConfig (real ~/.claude.json) or the
    // injected resolver fallback; either way ONE entry must exist with the
    // current token.
    expect(vault.list().some(e => e.accessToken === 'token-current')).toBe(true)
    expect(entry).toBeTruthy()
    c.stop()
  })

  test('proxy restart restores the pin from the vault (HOLD survives)', async () => {
    const vaultPath = join(TMP, `vault-${seq++}.json`)
    const vault = new OrgVault(vaultPath)
    vault.upsert({
      orgId: 'org-old', accessToken: 'token-old',
      refreshToken: null, expiresAt: Date.now() + 3_600_000, capturedAt: Date.now(),
    })
    vault.setPin('sess-1', 'org-old')      // binding left by a previous proxy run

    const sink = { auth: [] as string[] }
    const c = mkClient({                    // fresh client = restarted proxy
      orgVault: new OrgVault(vaultPath),
      upstreamFetcher: sseUpstream(sink),
    })
    const resp = await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    expect(resp.status).toBe(200)
    expect(sink.auth[0]).toBe('Bearer token-old')   // NOT silently rebound to org-current
    c.stop()
  })

  test('dead vault binding (expired, no refresh) falls through to normal bind', async () => {
    const vaultPath = join(TMP, `vault-${seq++}.json`)
    const vault = new OrgVault(vaultPath)
    vault.upsert({
      orgId: 'org-dead', accessToken: 'token-dead',
      refreshToken: null, expiresAt: Date.now() - 1000, capturedAt: Date.now(),
    })
    vault.setPin('sess-1', 'org-dead')
    const sink = { auth: [] as string[] }
    const c = mkClient({ orgVault: new OrgVault(vaultPath), upstreamFetcher: sseUpstream(sink) })
    const resp = await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    expect(resp.status).toBe(200)
    expect(sink.auth[0]).toBe('Bearer token-current')
    expect(new OrgVault(vaultPath).getPin('sess-1')).toBeNull()   // dead binding cleaned
    c.stop()
  })
})

describe('served-org evidence', () => {
  test('anthropic-organization-id is captured into orgSurface + vault verification', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({
      orgId: 'org-served', accessToken: 'tok', refreshToken: null,
      expiresAt: null, capturedAt: Date.now(),
    })
    const c = mkClient({ orgVault: vault, upstreamFetcher: sseUpstream({ auth: [] }, 'org-served') })
    await c.handleRequest(body('hello'), {}, { sessionId: 'sess-1' })
    const surface = c.orgSurface()
    const sess = surface.sessions.find(s => s.sessionId === 'sess-1')
    expect(sess?.servedOrg).toBe('org-served')
    expect(vault.get('org-served')?.lastVerifiedAt).toBeGreaterThan(0)
    c.stop()
  })
})

describe('auto-HOLD persistence + served-org self-heal (2026-06-11 incident class)', () => {
  test('cross-org HOLD persists the pin binding to the vault (restart-safe)', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    const auth: string[] = []
    const state = { orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 }
    const c = mkClient({
      orgVault: vault,
      credentialsProvider: {
        getAccessToken: async () => state.token,
        invalidate() {},
        currentExpiresAt: () => state.expiresAt,
      },
      orgIdResolver: { current: () => state.orgId, invalidate() {} },
      upstreamFetcher: sseUpstream({ auth }),
    })
    await c.handleRequest(body('hi'), {}, { sessionId: 's-hold' })        // auto-pin org-A
    state.orgId = 'org-B'; state.token = 'tok-B'                          // cross-org login
    const r = await c.handleRequest(body('hi again'), {}, { sessionId: 's-hold' })  // HOLD
    expect(r.status).toBe(200)
    // The HOLD binding must survive a proxy restart — orgId-only, in the vault.
    expect(vault.getPin('s-hold')).toEqual({ orgId: 'org-A' })
    c.stop()
  })

  test('served-org mismatch invalidates BOTH caches in lock-step (self-heal)', async () => {
    let creds = 0, org = 0
    const c = mkClient({
      credentialsProvider: { getAccessToken: async () => 'tok-X', invalidate() { creds++ } },
      orgIdResolver: { current: () => 'org-expected', invalidate() { org++ } },
      upstreamFetcher: sseUpstream({ auth: [] }, 'org-actually-served'),
    })
    const r = await c.handleRequest(body('hi'), {}, { sessionId: 's-mm' })
    expect(r.status).toBe(200)
    expect(creds).toBeGreaterThanOrEqual(1)   // token cache dropped
    expect(org).toBeGreaterThanOrEqual(1)     // org-id cache dropped in lock-step
    c.stop()
  })

  test('no mismatch → caches untouched (no invalidation churn)', async () => {
    let creds = 0, org = 0
    const c = mkClient({
      credentialsProvider: { getAccessToken: async () => 'tok-X', invalidate() { creds++ } },
      orgIdResolver: { current: () => 'org-served', invalidate() { org++ } },
      upstreamFetcher: sseUpstream({ auth: [] }, 'org-served'),
    })
    await c.handleRequest(body('hi'), {}, { sessionId: 's-ok' })
    expect(creds).toBe(0)
    expect(org).toBe(0)
    c.stop()
  })
})
