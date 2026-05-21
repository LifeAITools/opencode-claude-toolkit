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
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, extractSessionIdFromBody, type ProxyClientOptions } from '../src/proxy-client.js'
import type { OrgIdResolver } from '../src/org-identity.js'
import { lineageKey, prefixHashes } from '../src/lineage.js'

// Minimal upstream mock — a tiny SSE body so handleRequest's tee()/parse path
// works for requests that PASS the guard. Blocked requests never reach it.
function sseResponse(): Response {
  return new Response(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}

// Suite-private temp dir for prefix-history files — keeps tests off the real
// ~/.claude-local/proxy-prefix-history.json the live daemon uses.
const TMP = mkdtempSync(join(tmpdir(), 'rewrite-guard-'))
let phSeq = 0

/** Mutable org resolver — flip `.org` between requests to simulate `claude login`. */
function mutableResolver(initial: string | null): OrgIdResolver & { org: string | null } {
  return { org: initial, current() { return this.org } }
}

function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    // kaCacheTtlSec=1 → predictCacheMiss treats a >1s idle as ttl-expiry,
    // so the avoidable-rewrite path is reachable inside a fast test.
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => sseResponse() },
    // Each client gets a fresh isolated history file; org defaults to a fixed
    // value (no host ~/.claude.json read) so non-org tests are hermetic.
    prefixHistoryPath: join(TMP, `ph-${phSeq++}.json`),
    orgIdResolver: { current: () => 'org-default' },
    // Keep block dumps inside the suite temp dir — never the real
    // ~/.claude-local/rewrite-guard-blocks/.
    rewriteBlockDumpDir: join(TMP, 'dumps-default'),
    // proxyStartedAt=0 (epoch) → no real timestamp predates it, so the
    // proxy-restart exemption never trips by accident; tests that exercise
    // it pass an explicit recent value.
    proxyStartedAt: 0,
    ...extra,
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
    // Seed a 10-min-idle lineage — past the 5m wire TTL of reqBody()'s
    // ephemeral markers, so the next request is a genuine avoidable:ttl-expiry.
    const path = join(TMP, 'rg-sess-2.json')
    seedIdleFor(path, 'rg-sess-2', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-2' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string; message?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    expect(j.error?.message).toContain('[cache-rewrite-ok]')   // tells the user the marker
    c.stop()
    rmSync(path, { force: true })
  })

  test('same idle-past-TTL rewrite WITH the override marker → passes the guard', async () => {
    const path = join(TMP, 'rg-sess-3.json')
    seedIdleFor(path, 'rg-sess-3', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    // Latest user message carries the marker → guard lets it through.
    const r = await c.handleRequest(reqBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-sess-3' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('rapid consecutive requests (within TTL) are NOT blocked', async () => {
    const c = mkClient()
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-4' })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-4' })  // no idle gap
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('tool-loop continuation (last user msg is a tool_result) is NOT blocked', async () => {
    // idle>TTL, but the latest user message is a tool_result — an agent
    // continuation, not a fresh user turn. The user has no message to mark,
    // so the guard must let it through rather than strand the loop forever.
    const path = join(TMP, 'rg-sess-5.json')
    seedIdleFor(path, 'rg-sess-5', reqBody(), 10 * 60_000)   // idle past the 5m wire TTL
    const c = mkClient({ prefixHistoryPath: path })
    const continuation = JSON.stringify({
      model: 'claude-opus-4-7',
      system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
      tools: [],
      messages: [
        { role: 'user', content: 'do the work ' + FILLER },
        { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
      ],
    })
    const r = await c.handleRequest(continuation, {}, { sessionId: 'rg-sess-5' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })
})

describe('rewrite guard — org-switch (anomalous:org-switch)', () => {
  test('org switch (prefix cached under a different org) WITHOUT marker → 400', async () => {
    // req1 caches the prefix under org-A; the user then `claude login`s to
    // org-B; req2 (same prefix, same session, no idle gap) would cold-write
    // the full context against org-B's quota → guard blocks it.
    const resolver = mutableResolver('org-A')
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-1' })
    resolver.org = 'org-B'
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-1' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    c.stop()
  })

  test('org switch WITH the override marker → passes the guard', async () => {
    const resolver = mutableResolver('org-A')
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-2' })
    resolver.org = 'org-B'
    const r = await c.handleRequest(reqBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-org-2' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('same org across requests → NOT blocked (a routine token refresh must not false-trip)', async () => {
    // organizationUuid is refresh-stable — a same-org ~8h token refresh leaves
    // it untouched, so two requests under one org must never trip the guard.
    const c = mkClient({ orgIdResolver: mutableResolver('org-A') })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-3' })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-3' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('unknown org (resolver returns null) → org-switch never trips', async () => {
    // A transient ~/.claude.json read failure degrades to "can't prove a
    // switch" — the request passes rather than getting a false 400.
    const resolver = mutableResolver(null)
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-4' })
    resolver.org = 'org-B'   // null → known is still not a provable switch
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-4' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('prefix history survives a proxy restart — org-switch caught post-restart', async () => {
    // Persistence (REQ-1) + org-awareness (REQ-2) together: without the
    // on-disk history a post-restart request looks like a cold-start and the
    // guard is blind. With it, the loaded prefix still carries org-A, so a
    // switch to org-B is caught by the fresh ProxyClient instance.
    const path = join(TMP, 'persist-restart.json')

    const before = mkClient({ orgIdResolver: mutableResolver('org-A'), prefixHistoryPath: path })
    await before.handleRequest(reqBody(), {}, { sessionId: 'rg-persist-1' })
    before.stop()   // persists prefixHistory to `path`

    const after = mkClient({ orgIdResolver: mutableResolver('org-B'), prefixHistoryPath: path })
    const r = await after.handleRequest(reqBody(), {}, { sessionId: 'rg-persist-1' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    after.stop()
    rmSync(path, { force: true })
  })
})

describe('rewrite guard — KA-kept-warm lineage is not a false ttl-expiry', () => {
  // Seed a prefix-history entry whose last REAL request is long past the TTL
  // but whose last KA fire is recent. predictCacheMiss must measure idle from
  // the KA fire (the cache IS warm) and not classify avoidable:ttl-expiry.
  function seed(path: string, key: string, lastReqAt: number, lastKaAt: number) {
    const body = JSON.parse(reqBody())
    writeFileSync(path, JSON.stringify({
      [key]: { hashes: prefixHashes(body), lastReqAt, orgId: 'org-default', lastKaAt },
    }))
  }

  test('recent KA fire → idle measured from it → NOT blocked', async () => {
    const path = join(TMP, 'ka-warm.json')
    const now = Date.now()
    const lk = lineageKey(JSON.parse(reqBody()))
    seed(path, `rg-kawarm:${lk}`, now - 600_000, now - 200)  // real 10m ago, KA 0.2s ago
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-kawarm' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('control: KA fire ALSO stale → genuine ttl-expiry → blocked', async () => {
    const path = join(TMP, 'ka-cold.json')
    const now = Date.now()
    const lk = lineageKey(JSON.parse(reqBody()))
    seed(path, `rg-kacold:${lk}`, now - 600_000, now - 600_000)  // both stale
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-kacold' })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })
})

describe('rewrite guard — block dump artifact', () => {
  test('a block writes a dump with the rejected request + prefix diff', async () => {
    const dumpDir = join(TMP, 'dump-out')
    const path = join(TMP, 'rg-dump-1.json')
    seedIdleFor(path, 'rg-dump-1', reqBody(), 10 * 60_000)   // idle past the 5m wire TTL
    const c = mkClient({ rewriteBlockDumpDir: dumpDir, prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-dump-1' })
    expect(r.status).toBe(400)

    const files = readdirSync(dumpDir)
    expect(files.length).toBe(1)
    const art = JSON.parse(readFileSync(join(dumpDir, files[0]), 'utf8'))
    expect(art.verdict.rewriteClass).toBe('avoidable:ttl-expiry')
    expect(art.blockedRequest.model).toBe('claude-opus-4-7')      // full request captured
    expect(art.verdict.signals.idleMs).toBeGreaterThan(300_000)   // idle past the 5m wire TTL
    c.stop()
    rmSync(dumpDir, { recursive: true, force: true })
    rmSync(path, { force: true })
  })
})

// ── Wire cache-TTL upgrade — the proxy lifts native CC's 5m markers to 1h ──
//
// Native Claude Code marks its cacheable prefix with `cache_control:ephemeral`
// (a 5-minute Anthropic TTL). A coding turn routinely runs longer than 5 min,
// so the prefix dies mid-turn and the next turn re-caches ~140K tokens — the
// guard then (correctly, given a 5m TTL) blocks it as avoidable:ttl-expiry.
// The proxy upgrades those markers to ttl:'1h' so the prefix outlives the
// turn; the guard's verdict must then track the REAL (1h) wire TTL.
import { upgradeCacheControlTtl } from '../src/keepalive-engine.js'

// anthropic-beta value Anthropic requires before it honors ttl:'1h'.
const BETA_1H = 'claude-code-20250219,prompt-caching-scope-2026-01-05'

// reqBody variant whose cacheable prefix is ALREADY marked ttl:'1h' — used to
// test the guard's TTL reading in isolation (the proxy's upgrade is a no-op on
// it, so lineageKey/prefixHashes stay stable and a seeded history matches).
const reqBody1h = (extra = '') => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER + ' ' + extra }],
})

// Capturing upstream — records the body actually forwarded to Anthropic.
function mkCapturingClient(extra: Partial<ProxyClientOptions> = {}) {
  let forwarded: string | null = null
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async (_url: string, init: any) => { forwarded = init?.body ?? null; return sseResponse() } },
    prefixHistoryPath: join(TMP, `ph-cap-${phSeq++}.json`),
    orgIdResolver: { current: () => 'org-default' },
    rewriteBlockDumpDir: join(TMP, 'dumps-cap'),
    proxyStartedAt: 0,
    ...extra,
  })
  return { c, getForwarded: () => forwarded }
}

// Seed a prefix-history entry so the FIRST handleRequest reads as a 2nd request
// idle `agoMs` ago — same device as the KA-warm suite's seed().
function seedIdleFor(path: string, sessionId: string, bodyStr: string, agoMs: number) {
  const body = JSON.parse(bodyStr)
  const t = Date.now() - agoMs
  writeFileSync(path, JSON.stringify({
    [`${sessionId}:${lineageKey(body)}`]: {
      hashes: prefixHashes(body), lastReqAt: t, orgId: 'org-default', lastKaAt: t,
    },
  }))
}

describe('rewrite guard — proxy upgrades native CC cache_control to ttl:1h', () => {
  test('beta present → forwarded body has every cache_control lifted to ttl:1h', async () => {
    const { c, getForwarded } = mkCapturingClient()
    await c.handleRequest(reqBody(), { 'anthropic-beta': BETA_1H }, { sessionId: 'rg-up-1' })
    const fwd = JSON.parse(getForwarded()!)
    expect(fwd.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    c.stop()
  })

  test('beta absent → forwarded body cache_control left untouched (5m)', async () => {
    const { c, getForwarded } = mkCapturingClient()
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-up-2' })
    const fwd = JSON.parse(getForwarded()!)
    expect(fwd.system[0].cache_control).toEqual({ type: 'ephemeral' })
    c.stop()
  })
})

describe('rewrite guard — verdict tracks the wire cache TTL, not a static config', () => {
  // The bug: predictCacheMiss read ttlMs from the static kaCacheTtlSec (5m),
  // so a 1h-cached lineage idle 19 min false-classified as avoidable:ttl-expiry
  // and 400-blocked — exactly what stranded session 405d1df5 on 2026-05-21.
  test('19-min idle on a ttl:1h prefix → NOT blocked (cache still warm at 1h)', async () => {
    const path = join(TMP, 'wire-19m.json')
    seedIdleFor(path, 'rg-wire-19m', reqBody1h(), 19 * 60_000)
    // kaCacheTtlSec:1 proves the verdict ignores the static config and reads
    // the body's own ttl:'1h' marker — pre-fix this 19-min idle 400-blocked.
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody1h(), {}, { sessionId: 'rg-wire-19m' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  // Control "a genuine expiry still blocks" is covered by the 5m-TTL suite
  // above ('control: KA fire ALSO stale → genuine ttl-expiry → blocked'): the
  // guard still trips on a real idle-past-TTL — the fix only lifts the TTL it
  // measures against to the value actually on the wire.
})

describe('extractSessionIdFromBody', () => {
  const UUID = 'ae5106e7-9b6d-5e2f-8a1b-2c3d4e5f6071'
  test('SDK-agent metadata.user_id (..._session_<uuid>)', () => {
    const body = JSON.stringify({ model: 'm', messages: [],
      metadata: { user_id: `user_devhash_account__session_${UUID}` } })
    expect(extractSessionIdFromBody(body)).toBe(UUID)
  })
  test('interactive-CC metadata.user_id (JSON with session_id)', () => {
    const body = JSON.stringify({ model: 'm', messages: [],
      metadata: { user_id: JSON.stringify({ device_id: 'd', session_id: UUID }) } })
    expect(extractSessionIdFromBody(body)).toBe(UUID)
  })
  test('no metadata → null', () => {
    expect(extractSessionIdFromBody(JSON.stringify({ model: 'm', messages: [] }))).toBeNull()
  })
  test('malformed body → null, never throws', () => {
    expect(() => extractSessionIdFromBody('{bad')).not.toThrow()
    expect(extractSessionIdFromBody('{bad')).toBeNull()
  })
})

describe('rewrite guard — automated agents are not hard-blocked', () => {
  // SDK-agent body: metadata.user_id is the underscore form (not JSON).
  const agentBody = () => JSON.stringify({
    model: 'claude-opus-4-7',
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [{ role: 'user', content: 'do the work ' + FILLER }],
    metadata: { user_id: 'user_devhash_account__session_a1b2c3d4-0000-5111-8222-333344445555' },
  })

  test('SDK-agent ttl-expiry → passes through (CACHE_REWRITE_UNGUARDED), no 400', async () => {
    const events: any[] = []
    const path = join(TMP, 'rg-auto-1.json')
    seedIdleFor(path, 'rg-auto-1', agentBody(), 10 * 60_000)   // idle past the 5m wire TTL
    const c = mkClient({ eventEmitter: { emit: (e: any) => events.push(e) }, prefixHistoryPath: path })
    const r = await c.handleRequest(agentBody(), {}, { sessionId: 'rg-auto-1' })
    expect(r.status).not.toBe(400)
    expect(events.some((e) => e.kind === 'CACHE_REWRITE_UNGUARDED')).toBe(true)
    expect(events.some((e) => e.kind === 'CACHE_REWRITE_BLOCKED')).toBe(false)
    c.stop()
    rmSync(path, { force: true })
  })

  test('Claude Code sub-agent (x-claude-code-agent-id header) ttl-expiry → passes, no 400', async () => {
    const path = join(TMP, 'rg-auto-2.json')
    seedIdleFor(path, 'rg-auto-2', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const hdr = { 'x-claude-code-agent-id': 'sub-7' }
    const r = await c.handleRequest(reqBody(), hdr, { sessionId: 'rg-auto-2' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })
})

describe('proxy — CC_VERSION_CHANGED detection', () => {
  // Body carrying the Claude Code billing header (cc_version=X.Y.Z.<fingerprint>).
  const bodyV = (ver: string) => JSON.stringify({
    model: 'claude-opus-4-7',
    system: [
      { type: 'text', text: `x-anthropic-billing-header: cc_version=${ver}; cc_entrypoint=cli; cch=abc;` },
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ],
    tools: [],
    messages: [{ role: 'user', content: 'hi ' + FILLER }],
  })

  test('emits CC_VERSION_CHANGED on a real version bump, ignores the per-request fingerprint', async () => {
    const events: any[] = []
    const c = mkClient({ eventEmitter: { emit: (e: any) => events.push(e) } })
    // first observation — no "change" event (nothing to compare to)
    await c.handleRequest(bodyV('2.1.143.111'), {}, { sessionId: 'ccv-1' })
    expect(events.some((e) => e.kind === 'CC_VERSION_CHANGED')).toBe(false)
    // real version bump → event
    await c.handleRequest(bodyV('2.1.144.222'), {}, { sessionId: 'ccv-1' })
    const ev = events.find((e) => e.kind === 'CC_VERSION_CHANGED')
    expect(ev).toBeDefined()
    expect(ev.previousVersion).toBe('2.1.143')
    expect(ev.version).toBe('2.1.144')
    // same version, different fingerprint suffix → NO new event
    const before = events.filter((e) => e.kind === 'CC_VERSION_CHANGED').length
    await c.handleRequest(bodyV('2.1.144.999'), {}, { sessionId: 'ccv-1' })
    expect(events.filter((e) => e.kind === 'CC_VERSION_CHANGED').length).toBe(before)
    c.stop()
  })
})

describe('rewrite guard — a TTL expiry spanning a proxy restart is NOT blocked', () => {
  test('last warm-up predates proxyStartedAt → expected:proxy-restart → passes', async () => {
    // The cache genuinely expired, but the gap spans a proxy restart: the KA
    // engine did not exist to keep it warm, so this is not the user's fault
    // and must not be blocked (it would just demand a pointless marker).
    const path = join(TMP, 'proxy-restart.json')
    const now = Date.now()
    const lk = lineageKey(JSON.parse(reqBody()))
    writeFileSync(path, JSON.stringify({
      [`rg-restart:${lk}`]: {
        hashes: prefixHashes(JSON.parse(reqBody())),
        lastReqAt: now - 600_000,    // 10 min ago — idle far past the 1s TTL
        orgId: 'org-default',
        lastKaAt: now - 600_000,
      },
    }))
    // proxyStartedAt AFTER the seeded warm-up → the gap spans this restart.
    const c = mkClient({ prefixHistoryPath: path, proxyStartedAt: now - 1_000 })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-restart' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })
})
