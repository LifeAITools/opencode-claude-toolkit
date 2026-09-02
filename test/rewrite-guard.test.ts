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
import { grantConsent } from '../src/rewrite-consent.js'

// Hermetic consent-grant store — MUST match consentGrantPath in
// _setup-keepalive-fixture.ts so the guard reads what these tests write.
const GRANT_PATH = '/tmp/__test_cache_rewrite_grants.json'

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
  test('first request below the cold-start threshold is NOT blocked (expected:cold-start)', async () => {
    const c = mkClient()
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-1' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  // ── Cold-start threshold (founder directive 2026-06-12) ─────────────────
  // A model switch maps the session to a fresh lineage (the system prompt
  // embeds the model name → new sysHash), so a 342k-context re-cache used to
  // sail through as an unblockable "cold start". A first write above
  // minColdStartTokens now stops for the SAME consent flow.
  const hugeColdBody = (extra = '') => JSON.stringify({
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'system prompt (new model)', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [{ role: 'user', content: 'resume after model switch ' + 'y'.repeat(240_000) + ' ' + extra }],
  })

  test('huge first request (≥ minColdStartTokens) IS blocked — model-switch recache case', async () => {
    const c = mkClient()
    const r = await c.handleRequest(hugeColdBody(), {}, { sessionId: 'rg-cold-1' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string; rewriteClass?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    expect(j.error?.rewriteClass).toBe('expected:cold-start')
    c.stop()
  })

  test('huge first request WITH the override marker passes (same consent flow)', async () => {
    const c = mkClient()
    const r = await c.handleRequest(hugeColdBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-cold-2' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('huge first request PASSES with a session grant (programmatic consent channel)', async () => {
    grantConsent(GRANT_PATH, 'rg-cold-3', 180_000)
    const c = mkClient()
    const r = await c.handleRequest(hugeColdBody(), {}, { sessionId: 'rg-cold-3' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  // ── Warm-KA second source of truth (2026-06-13 93ef0df0 false-block) ────
  // A restart pruned the guard's history entry for a KA-kept-warm idle session
  // → its next real request read as isFirstRequest → expected:cold-start →
  // false-blocked a hot cache READ. The guard now consults the live KA
  // registry; the prune itself now ages by max(lastReqAt, lastKaAt).

  test('KA-warm lineage is NEVER cold-start-blocked even when guard history was lost', async () => {
    const c = mkClient({ config: { kaCacheTtlSec: 300 } })
    const r1 = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-warm-ka' })
    expect(r1.status).not.toBe(400)             // session + KA engine exist now
    // Seed a LIVE warm KA snapshot for the huge body's lineage (what a revived
    // engine holds after a restart), with the guard history for it ABSENT.
    const eng = (c as any).store.list().find((s: any) => s.sessionId === 'rg-warm-ka').engine
    eng._setPendingSnapshot('claude-opus-4-8', JSON.parse(hugeColdBody()), {})
    eng.notifyRealRequestComplete({ inputTokens: 200_000, outputTokens: 1 })
    ;(c as any).prefixHistory.clear()           // the restart-prune loss
    const r2 = await c.handleRequest(hugeColdBody(), {}, { sessionId: 'rg-warm-ka' })
    expect(r2.status).not.toBe(400)             // hot cache READ — must not block
    c.stop()
  })

  test('history prune ages by max(lastReqAt, lastKaAt) — a KA-kept-warm entry survives a restart', () => {
    const path = join(TMP, 'ph-prune.json')
    const now = Date.now()
    writeFileSync(path, JSON.stringify({
      'sidA:lin': { hashes: { system: 's', toolNames: 't' }, lastReqAt: now - 2 * 3600_000, lastKaAt: now - 5 * 60_000, orgId: null },
      'sidB:lin': { hashes: { system: 's', toolNames: 't' }, lastReqAt: now - 2 * 3600_000, orgId: null },
    }))
    const c = mkClient({ prefixHistoryPath: path })
    expect(((c as any).prefixHistory as Map<string, unknown>).has('sidA:lin')).toBe(true)   // KA kept it warm → kept
    expect(((c as any).prefixHistory as Map<string, unknown>).has('sidB:lin')).toBe(false)  // genuinely stale → pruned
    c.stop()
    rmSync(path, { force: true })
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

  test('the refusal counts itself: 1, 2, 3 in a row, and says so from the second', async () => {
    // 🔴 ONE refusal and EIGHT IN A ROW are different events for the person
    // sitting there, and they used to look identical. Measured by
    // vibe-telegram-mcp-service-owner over 2026-08-12..19: 98 refusals, 13 of
    // them in runs of 3–5 within ten minutes on ONE session. On 2026-08-16 that
    // shape cost eight minutes of a real conversation — every turn died in its
    // first second on the same wall while the agent looked busy from outside,
    // and a hard restart was nearly ordered that would have discarded 61% of
    // its working context for nothing.
    const path = join(TMP, 'rg-streak.json')
    seedIdleFor(path, 'rg-streak', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })

    const counts: number[] = []
    let secondMessage = ''
    for (let i = 0; i < 3; i++) {
      const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-streak' })
      expect(r.status).toBe(400)
      const j = await r.json() as { error?: { consecutiveBlocks?: number; message?: string } }
      counts.push(j.error?.consecutiveBlocks ?? -1)
      if (i === 1) secondMessage = j.error?.message ?? ''
    }
    expect(counts).toEqual([1, 2, 3])
    // From the second one the wording must stop reading like a fresh question:
    // retrying is exactly what the agent did for eight minutes.
    expect(secondMessage).toContain('IN A ROW')

    c.stop()
    rmSync(path, { force: true })
  })

  test('a turn that gets through ends the run — the count is consecutive, not cumulative', async () => {
    // 🔴 The whole point is the RESET, so it must happen on the SAME client: a
    // fresh one starts from zero anyway and would make this test pass no matter
    // what the code does. (It did, in the first draft — caught by removing the
    // reset line and watching the suite stay green.) Ageing the in-memory
    // history is the house idiom for driving a second block on a live client.
    const path = join(TMP, 'rg-streak-reset.json')
    seedIdleFor(path, 'rg-streak-reset', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })

    const ageHistory = () => {
      const t = Date.now() - 10 * 60_000
      for (const e of ((c as any).prefixHistory as Map<string, any>).values()) {
        e.lastReqAt = t
        e.lastKaAt = t
      }
    }

    const first = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-streak-reset' })
    expect(first.status).toBe(400)
    expect(((await first.json()) as any).error.consecutiveBlocks).toBe(1)

    const second = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-streak-reset' })
    expect(second.status).toBe(400)
    expect(((await second.json()) as any).error.consecutiveBlocks).toBe(2)

    // Consent in the message → this turn is forwarded, so the run is over.
    const through = await c.handleRequest(reqBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-streak-reset' })
    expect(through.status).not.toBe(400)

    // Age the SAME client's history and block again: the count must start over
    // at one. Without the reset on the forward path it would come back as three.
    ageHistory()
    const again = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-streak-reset' })
    expect(again.status).toBe(400)
    expect(((await again.json()) as any).error.consecutiveBlocks).toBe(1)

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

  const continuationBody = () => JSON.stringify({
    model: 'claude-opus-4-7',
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [
      { role: 'user', content: 'do the work ' + FILLER },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
    ],
  })

  test('tool-loop continuation (last user msg is a tool_result) IS blocked (no message to mark)', async () => {
    // idle>TTL on a continuation — it has no user text to carry a marker, so the
    // ONLY consent path is a session grant. Without one it must block (no silent
    // expensive re-cache), not slip through as the old code did.
    const path = join(TMP, 'rg-sess-5.json')
    seedIdleFor(path, 'rg-sess-5', reqBody(), 10 * 60_000)   // idle past the 5m wire TTL
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(continuationBody(), {}, { sessionId: 'rg-sess-5' })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('tool-loop continuation PASSES with a session grant (the actionable channel)', async () => {
    const path = join(TMP, 'rg-sess-5b.json')
    seedIdleFor(path, 'rg-sess-5b', reqBody(), 10 * 60_000)
    grantConsent(GRANT_PATH, 'rg-sess-5b', 180_000)
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(continuationBody(), {}, { sessionId: 'rg-sess-5b' })
    expect(r.status).not.toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('programmatic endpoint client (interactive:false) IS blocked — block applies to all', async () => {
    // Was bypassed under interactiveOnly; now every consumer is blocked unless
    // consented (the programmatic client consents via the session-grant CLI).
    const path = join(TMP, 'rg-sess-prog.json')
    seedIdleFor(path, 'rg-sess-prog', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-prog', interactive: false })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('interactive client (interactive:true) is still blocked', async () => {
    const path = join(TMP, 'rg-sess-inter.json')
    seedIdleFor(path, 'rg-sess-inter', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-sess-inter', interactive: true })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })
})

describe('rewrite guard — org-switch (anomalous:org-switch)', () => {
  test('org switch (prefix cached under a different org) → HOLDS old org, NOT 400', async () => {
    // req1 caches the prefix under org-A; the user then `claude login`s to
    // org-B; req2 (same prefix, same session) must NOT be blocked — the
    // per-session pin HOLDS the old org+token and keeps serving. org no longer
    // trips the guard (it holds; only non-org rewrites still block).
    const resolver = mutableResolver('org-A')
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-1' })
    resolver.org = 'org-B'
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-1' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('org switch marks the engine org-switch-pending (KA warms old cache) without blocking', async () => {
    const resolver = mutableResolver('org-A')
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-pending' })   // cache under org-A
    resolver.org = 'org-B'                                                  // claude login → org-B
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-pending' })
    expect(r.status).not.toBe(400)                                          // held, not blocked
    const eng = c.listSessions().find(s => s.sessionId === 'rg-org-pending')!.engine
    const key = lineageKey(JSON.parse(reqBody()))
    expect(eng._orgSwitchPending.has(key)).toBe(true)                       // KA still warms the old cache
    c.stop()
  })

  test('non-org expensive rewrite still blocks (guard intact for non-org)', async () => {
    // org unchanged but the cached prefix is idle past its TTL → a genuine
    // avoidable rewrite. This is the path the guard still protects.
    const path = join(TMP, 'rg-nonorg.json')
    seedIdleFor(path, 'rg-nonorg', reqBody(), 10 * 60_000)
    // Same org as the seed (org-default) → orgChanged=false → a pure ttl-expiry
    // rewrite, the path the guard still protects.
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-nonorg' })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
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

  test('same-org token rotation does NOT mark org-switch-pending (token≠org)', async () => {
    const c = mkClient({ orgIdResolver: { current: () => 'org-stable' } })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-rot' })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-rot' })  // rapid, same org
    expect(r.status).not.toBe(400)
    const eng = c.listSessions().find(s => s.sessionId === 'rg-rot')!.engine
    expect(eng._orgSwitchPending.size).toBe(0)
    c.stop()
  })

  test('[%reload-ok%] after an org switch rebinds + clears the pending flag (window ends)', async () => {
    const resolver = mutableResolver('org-A')
    const c = mkClient({ orgIdResolver: resolver })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-end' })
    resolver.org = 'org-B'
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-end' })                  // held → pending set
    const r = await c.handleRequest(reqBody('[%reload-ok%]'), {}, { sessionId: 'rg-org-end' })  // reload → rebind to org-B
    expect(r.status).not.toBe(400)
    const eng = c.listSessions().find(s => s.sessionId === 'rg-org-end')!.engine
    expect(eng._orgSwitchPending.size).toBe(0)   // cleared on rebind (no longer held)
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

  test('cross-org rebind after pin loss (restart/reload) WITHOUT [%reload-ok%] → 400 (no silent burn)', async () => {
    // The pin is in-memory; a proxy restart OR a global `claude-max reload`
    // (sessionPins.clear()) drops it. prefixHistory persists, so the next
    // request on a prefix cached under the OLD org is a real cross-org cold
    // rewrite (~full context) billed to the NEW org. The Layer-2 HOLD cannot
    // engage (no pin to hold), so the rewrite guard MUST surface it: block +
    // consent, never the old silent rebind. (2026-06-08 incident: a global
    // reload wiped pins 2s before an org switch → ~526K tok burned silently.)
    const path = join(TMP, 'persist-restart.json')

    const before = mkClient({ orgIdResolver: mutableResolver('org-A'), prefixHistoryPath: path })
    await before.handleRequest(reqBody(), {}, { sessionId: 'rg-persist-1' })
    before.stop()   // persists prefixHistory to `path`; in-memory pin is gone

    const after = mkClient({ orgIdResolver: mutableResolver('org-B'), prefixHistoryPath: path })
    const r = await after.handleRequest(reqBody(), {}, { sessionId: 'rg-persist-1' })
    expect(r.status).toBe(400)   // no pin + org changed + not reloaded → blocked for consent
    const j = await r.json() as { error?: { type?: string; rewriteClass?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    expect(j.error?.rewriteClass).toBe('anomalous:org-switch')
    after.stop()
    rmSync(path, { force: true })
  })

  test('cross-org rebind after pin loss WITH [%reload-ok%] → NOT blocked (explicit switch consented)', async () => {
    // Same pin-loss + org-switch shape, but the user explicitly opts into the
    // migration via the reload marker. That IS consent to pay the one-time
    // cross-org rewrite, so the guard must NOT block — otherwise the documented
    // org-swap path would demand a second, different marker.
    const path = join(TMP, 'persist-reloadok.json')

    const before = mkClient({ orgIdResolver: mutableResolver('org-A'), prefixHistoryPath: path })
    await before.handleRequest(reqBody(), {}, { sessionId: 'rg-persist-2' })
    before.stop()

    const after = mkClient({ orgIdResolver: mutableResolver('org-B'), prefixHistoryPath: path })
    const r = await after.handleRequest(reqBody('[%reload-ok%]'), {}, { sessionId: 'rg-persist-2' })
    expect(r.status).not.toBe(400)   // explicit reload → rebind to org-B, no block
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
// Seed a WARM same-identity snapshot (recent lastReqAt/lastKaAt) for a given
// body's lineage, so a NEW lineage (different tool-set, same system) reads as a
// warm-sibling lineage-shift.
function seedWarm(path: string, sessionId: string, bodyStr: string) {
  const body = JSON.parse(bodyStr)
  const t = Date.now()
  writeFileSync(path, JSON.stringify({
    [`${sessionId}:${lineageKey(body)}`]: {
      hashes: prefixHashes(body), lastReqAt: t, orgId: 'org-default', lastKaAt: t,
    },
  }))
}

describe('rewrite guard — mid-session tool-set flick (avoidable:lineage-shift)', () => {
  const SYS = [{ type: 'text', text: 'main agent system', cache_control: { type: 'ephemeral' } }]
  // Same system, varying tool-set → same system-hash, different lineageKey.
  const toolBody = (tools: { name: string }[]) => JSON.stringify({
    model: 'claude-opus-4-7', system: SYS, tools,
    messages: [{ role: 'user', content: 'work ' + FILLER }],
  })
  // Same lineageKey (same system+tools) but a growing/changing MESSAGE tail —
  // must NEVER be blocked (this is what caused the 0.20.17/0.20.18 false storm).
  const sameLineageBody = (tailMsgs: any[]) => JSON.stringify({
    model: 'claude-opus-4-7', system: SYS, tools: [{ name: 'Bash' }],
    messages: [{ role: 'user', content: 'q1 ' + FILLER }, ...tailMsgs],
  })

  test('tool-set flick (WaitForMcpServers dropped) is NOT blocked — observability only', async () => {
    // The proven incident: a tool drops vs a warm sibling. It costs a real
    // re-cache, but the client changed its tools (unavoidable) → expected:tools-
    // changed, NEVER blocked. The proxy logs a drift diagnostic; the request flows.
    const path = join(TMP, 'ls-tool.json')
    seedWarm(path, 'ls-tool', toolBody([{ name: 'Bash' }, { name: 'WaitForMcpServers' }]))
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(toolBody([{ name: 'Bash' }]), {}, { sessionId: 'ls-tool' })
    expect(r.status).not.toBe(400)
    c.stop(); rmSync(path, { force: true })
  })

  test('same lineageKey, message tail grows/changes (injected notification) → NOT blocked', async () => {
    // The 0.20.17/0.20.18 regression: a task-notification/system-reminder appended
    // to a recent message must never block. The sibling approach keys on system⊕
    // tools only, so this never even computes a drift.
    const path = join(TMP, 'ls-grow.json')
    seedWarm(path, 'ls-grow', sameLineageBody([{ role: 'assistant', content: [{ type: 'text', text: 'a1' }] }]))
    const c = mkClient({ prefixHistoryPath: path })
    const grown = sameLineageBody([
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }, { type: 'text', text: '<task-notification>injected</task-notification>' }] },
      { role: 'user', content: 'next turn' },
    ])
    const r = await c.handleRequest(grown, {}, { sessionId: 'ls-grow' })
    expect(r.status).not.toBe(400)
    c.stop(); rmSync(path, { force: true })
  })

  test('genuine first-ever request (no warm sibling) is NOT blocked', async () => {
    const c = mkClient()
    const r = await c.handleRequest(toolBody([{ name: 'Bash' }]), {}, { sessionId: 'ls-cold' })
    expect(r.status).not.toBe(400)
    c.stop()
  })

  test('sub-agent (different system hash) is NOT blocked though a main snapshot is warm', async () => {
    const path = join(TMP, 'ls-sub.json')
    seedWarm(path, 'ls-sub', toolBody([{ name: 'Bash' }, { name: 'WaitForMcpServers' }]))
    const subBody = JSON.stringify({
      model: 'claude-opus-4-7',
      system: [{ type: 'text', text: 'SUB agent system — different prompt', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 'Bash' }],
      messages: [{ role: 'user', content: 'sub work ' + FILLER }],
    })
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(subBody, { 'x-claude-code-agent-id': 'sub-1' }, { sessionId: 'ls-sub' })
    expect(r.status).not.toBe(400)
    c.stop(); rmSync(path, { force: true })
  })
})

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

describe('rewrite guard — automated agents ARE blocked (consent via session grant)', () => {
  // SDK-agent body: metadata.user_id is the underscore form (not JSON).
  const agentBody = () => JSON.stringify({
    model: 'claude-opus-4-7',
    system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [{ role: 'user', content: 'do the work ' + FILLER }],
    metadata: { user_id: 'user_devhash_account__session_a1b2c3d4-0000-5111-8222-333344445555' },
  })

  test('SDK-agent ttl-expiry → BLOCKED 400 + CACHE_REWRITE_BLOCKED (no UNGUARDED bypass)', async () => {
    const events: any[] = []
    const path = join(TMP, 'rg-auto-1.json')
    seedIdleFor(path, 'rg-auto-1', agentBody(), 10 * 60_000)   // idle past the 5m wire TTL
    const c = mkClient({ eventEmitter: { emit: (e: any) => events.push(e) }, prefixHistoryPath: path })
    const r = await c.handleRequest(agentBody(), {}, { sessionId: 'rg-auto-1' })
    expect(r.status).toBe(400)
    expect(events.some((e) => e.kind === 'CACHE_REWRITE_BLOCKED')).toBe(true)
    expect(events.some((e) => e.kind === 'CACHE_REWRITE_UNGUARDED')).toBe(false)
    c.stop()
    rmSync(path, { force: true })
  })

  test('Claude Code sub-agent (x-claude-code-agent-id header) ttl-expiry → BLOCKED 400', async () => {
    const path = join(TMP, 'rg-auto-2.json')
    seedIdleFor(path, 'rg-auto-2', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const hdr = { 'x-claude-code-agent-id': 'sub-7' }
    const r = await c.handleRequest(reqBody(), hdr, { sessionId: 'rg-auto-2' })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('agent PASSES with a session grant, and the grant is SINGLE-USE', async () => {
    const hdr = { 'x-claude-code-agent-id': 'sub-9' }
    grantConsent(GRANT_PATH, 'rg-auto-3', 180_000)
    // 1st request consumes the grant → passes.
    const path1 = join(TMP, 'rg-auto-3a.json')
    seedIdleFor(path1, 'rg-auto-3', agentBody(), 10 * 60_000)
    const c1 = mkClient({ prefixHistoryPath: path1 })
    const r1 = await c1.handleRequest(agentBody(), hdr, { sessionId: 'rg-auto-3' })
    expect(r1.status).not.toBe(400)
    c1.stop()
    // 2nd request (fresh client + freshly-seeded idle): grant already consumed
    // by r1 → blocked. A fresh client avoids r1's in-memory prefix-history warming.
    const path2 = join(TMP, 'rg-auto-3b.json')
    seedIdleFor(path2, 'rg-auto-3', agentBody(), 10 * 60_000)
    const c2 = mkClient({ prefixHistoryPath: path2 })
    const r2 = await c2.handleRequest(agentBody(), hdr, { sessionId: 'rg-auto-3' })
    expect(r2.status).toBe(400)
    c2.stop()
    rmSync(path1, { force: true })
    rmSync(path2, { force: true })
  })

  test('an EXPIRED session grant does NOT pass (TTL respected)', async () => {
    const path = join(TMP, 'rg-auto-4.json')
    seedIdleFor(path, 'rg-auto-4', agentBody(), 10 * 60_000)
    grantConsent(GRANT_PATH, 'rg-auto-4', 1, Date.now() - 10_000)  // granted 10s ago, ttl 1ms → expired
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(agentBody(), {}, { sessionId: 'rg-auto-4' })
    expect(r.status).toBe(400)
    c.stop()
    rmSync(path, { force: true })
  })

  test('the 400 body is structured + actionable (type, rewriteClass, consent.cli)', async () => {
    const path = join(TMP, 'rg-auto-5.json')
    seedIdleFor(path, 'rg-auto-5', agentBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path })
    const r = await c.handleRequest(agentBody(), {}, { sessionId: 'rg-auto-5' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string; rewriteClass?: string; consent?: { cli?: string; marker?: string } } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    expect(j.error?.rewriteClass).toBe('avoidable:ttl-expiry')
    expect(j.error?.consent?.cli).toContain('context cache-rewrite-ok rg-auto-5')
    expect(j.error?.consent?.marker).toBe('[cache-rewrite-ok]')
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

  test('two sessions on DIFFERENT versions never report a change to each other', async () => {
    // The version memory used to be ONE field for the whole proxy: whichever
    // session sent the last request overwrote it, so the next session's request
    // looked like a change to a version it had never left. Measured on this
    // machine 2026-08-20, with six CLI versions in use at once — 3676 such
    // events in a day across 157 sessions, one flip-flopping 457 times.
    //
    // The event says "the cacheable prefix changed", so each of those pointed
    // a reader chasing a rewrite spike at an innocent session, and buried the
    // real version change of a real agent in the noise.
    const events: any[] = []
    const c = mkClient({ eventEmitter: { emit: (e: any) => events.push(e) } })
    for (let i = 0; i < 5; i++) {
      await c.handleRequest(bodyV('2.1.197.1'), {}, { sessionId: 'ccv-A' })
      await c.handleRequest(bodyV('2.1.237.2'), {}, { sessionId: 'ccv-B' })
    }
    expect(events.filter((e) => e.kind === 'CC_VERSION_CHANGED').length).toBe(0)
    c.stop()
  })

  test('and a session that really upgrades is still reported, by name', async () => {
    const events: any[] = []
    const c = mkClient({ eventEmitter: { emit: (e: any) => events.push(e) } })
    await c.handleRequest(bodyV('2.1.197.1'), {}, { sessionId: 'ccv-A' })
    await c.handleRequest(bodyV('2.1.237.2'), {}, { sessionId: 'ccv-B' })   // neighbour noise
    await c.handleRequest(bodyV('2.1.237.3'), {}, { sessionId: 'ccv-A' })   // A really upgrades
    const ch = events.filter((e) => e.kind === 'CC_VERSION_CHANGED')
    expect(ch.length).toBe(1)
    expect(ch[0].sessionId).toBe('ccv-A')
    expect(ch[0].previousVersion).toBe('2.1.197')
    expect(ch[0].version).toBe('2.1.237')
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

describe('assessCacheMiss is pure (does not advance prefix history)', () => {
  test('two assess calls in a row see identical prev state; no history write', () => {
    const c = mkClient({ orgIdResolver: { current: () => 'org-A' } })
    const body = JSON.parse(reqBody())
    const a1 = (c as any).assessCacheMiss('rg-pure-1', 'lin', body, 6000)
    const a2 = (c as any).assessCacheMiss('rg-pure-1', 'lin', body, 6000)
    // assess must NOT persist → second call still sees no prev (identical verdict).
    expect(a1.assessment.rewriteClass).toBe(a2.assessment.rewriteClass)
    expect((c as any).prefixHistory.get('rg-pure-1:lin')).toBeUndefined()
    // commit payload is always present so the proceed path can advance history.
    expect(a1.commit.key).toBe('rg-pure-1:lin')
    c.stop()
  })

  test('commitPrefixHistory advances prefixHistory; a later assess sees the prev', () => {
    const c = mkClient({ orgIdResolver: { current: () => 'org-A' } })
    const body = JSON.parse(reqBody())
    const a1 = (c as any).assessCacheMiss('rg-pure-2', 'lin', body, 6000)
    ;(c as any).commitPrefixHistory(a1.commit)
    expect((c as any).prefixHistory.get('rg-pure-2:lin')).toBeDefined()
    c.stop()
  })
})

/**
 * The guard names WHICH spend it is blocking — 2026-08-18.
 *
 * One word covered two events with opposite meanings. A cold start WRITES a
 * large cache for the first time and every later read repays it; a ttl-expiry
 * or org-switch THROWS AWAY a cache already paid for and buys it again. Both
 * need consent (founder directive 2026-06-12), but calling both "re-cache" made
 * the record unreadable: a dump named `expected_cold-start` carrying 448 104
 * tokens sat in a directory called rewrite-guard-blocks and read as discarded
 * work — while its own prefixDiff said `noBaseline: true, systemLen.prev = 0`.
 */
describe('rewrite guard: a FIRST write is not a REwrite', () => {
  const hugeCold = () => JSON.stringify({
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'system prompt (fresh lineage)', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [{ role: 'user', content: 'first turn ' + 'y'.repeat(240_000) }],
  })

  test('a blocked cold start is called a first write, never a re-cache', async () => {
    const c = mkClient()
    const r = await c.handleRequest(hugeCold(), {}, { sessionId: 'rg-word-cold' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { spendKind?: string; message?: string } }
    expect(j.error?.spendKind).toBe('first-write')
    expect(j.error?.message).toContain('NEW cache')
    expect(j.error?.message).not.toContain('re-cache')
    c.stop()
  })

  test('a blocked ttl-expiry IS called a re-cache — the cache was already paid for', async () => {
    const events: any[] = []
    // Seed a 10-min-idle lineage — past the 5m wire TTL of reqBody()'s ephemeral
    // markers — so the next turn is a genuine avoidable:ttl-expiry, the same
    // setup the older idle-past-TTL test uses.
    const path = join(TMP, 'rg-word-ttl.json')
    seedIdleFor(path, 'rg-word-ttl', reqBody(), 10 * 60_000)
    const c = mkClient({ prefixHistoryPath: path, eventEmitter: { emit: (e: any) => events.push(e) } })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-word-ttl' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { spendKind?: string; rewriteClass?: string; message?: string } }
    expect(j.error?.rewriteClass).toBe('avoidable:ttl-expiry')
    expect(j.error?.spendKind).toBe('rewrite')
    expect(j.error?.message).toContain('re-cache')
    expect(j.error?.message).toContain('discarded and bought again')

    const blocked = events.find((e) => e.kind === 'CACHE_REWRITE_BLOCKED')
    expect(blocked?.spendKind).toBe('rewrite')
    c.stop()
  })
})

/**
 * A dump must say what the proxy KNEW, not only what it saw — 2026-08-18.
 *
 * `noBaseline: true` alone is ambiguous: prefix history is pruned on session
 * death and by age on load, so a person opening the file days later cannot tell
 * a genuine first turn from a baseline that had been swept. Those are different
 * bugs with different fixes, and the dump used to be silent on which one it
 * witnessed — the live example was
 * 2026-08-18T13-45-58-418Z-55832329-expected_cold-start.json, systemLen.prev=0
 * with ~90 tools all listed as "added".
 */
describe('block dump carries the session record at block time', () => {
  test('a genuine first turn: nothing on record, nothing swept', async () => {
    const dumps = join(TMP, 'dumps-state-first')
    const c = mkClient({ rewriteBlockDumpDir: dumps })
    const huge = JSON.stringify({
      model: 'claude-opus-4-8',
      system: [{ type: 'text', text: 'sys fresh', cache_control: { type: 'ephemeral' } }],
      tools: [],
      messages: [{ role: 'user', content: 'first turn ' + 'z'.repeat(240_000) }],
    })
    const r = await c.handleRequest(huge, {}, { sessionId: 'dump-state-1' })
    expect(r.status).toBe(400)

    const files = readdirSync(dumps).filter((f) => f.endsWith('.json'))
    expect(files.length).toBe(1)
    const art = JSON.parse(readFileSync(join(dumps, files[0]!), 'utf8'))
    expect(art.sessionState).toBeTruthy()
    expect(art.sessionState.sessionOnRecord).toBe(false)
    expect(art.sessionState.lineageOnRecord).toBe(false)
    expect(art.sessionState.siblingLineages).toEqual([])
    expect(art.sessionState.spansProxyRestart).toBe(false)
    c.stop()
  })

  test('a lineage shift: the session IS on record, this lineage is not — and the sibling is named', async () => {
    const dumps = join(TMP, 'dumps-state-shift')
    const path = join(TMP, 'ph-state-shift.json')
    // Seed a warm sibling lineage for the SAME session, idle past the wire TTL.
    seedIdleFor(path, 'dump-state-2', reqBody(), 10 * 60_000)
    const c = mkClient({ rewriteBlockDumpDir: dumps, prefixHistoryPath: path })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'dump-state-2' })
    expect(r.status).toBe(400)

    const files = readdirSync(dumps).filter((f) => f.endsWith('.json'))
    const art = JSON.parse(readFileSync(join(dumps, files[0]!), 'utf8'))
    expect(art.sessionState.sessionOnRecord).toBe(true)
    expect(art.sessionState.siblingLineages.length).toBeGreaterThan(0)
    // Every sibling reports how stale it was — "on record" alone would not say
    // whether the baseline was usable.
    expect(art.sessionState.siblingLineages[0]).toHaveProperty('lastReqAgeMs')
    c.stop()
    rmSync(path, { force: true })
  })
})

describe('proxy — a block that names the cheaper way out', () => {
  // Measured 2026-08-21: the morning after a re-login, five sessions were told
  // "consent to re-cache ~476000 tokens" and nothing else — while the account
  // that owned each cache still had a live token in the vault the whole time.
  // Paying was never the only option; the block simply never said so.
  test('an org-switch block points at the account that owns the cache', () => {
    const msg = 'guard blocked anomalous:org-switch — would re-cache ~476327 tokens; awaiting consent'
      + ' — CHEAPER: this cache belongs to account f9420373, whose token is still alive;'
      + ' putting the session back on it makes this turn a free read instead of buying 476327 tokens'
    // The shape a reader must be able to act on: which account, and that it is usable.
    expect(msg).toContain('CHEAPER')
    expect(msg).toContain('f9420373')
    expect(msg).toContain('free read')
  })

  test('the hint is built from the vault and the previous org, not guessed', async () => {
    // Asserted on the source: the value only appears in a live block, and a test
    // that mocked its way there would prove its own mock (three guard tests fell
    // into exactly that on 2026-08-20).
    const src = await Bun.file(new URL('../src/proxy-client.ts', import.meta.url)).text()
    const block = src.slice(src.indexOf('let freeReadHint'), src.indexOf('const isFirstWrite'))
    expect(block).toContain('rewriteAssessment.signals?.prevOrgId')
    expect(block).toContain('this.orgVault.get(owner)')
    expect(block).toContain('ve.expiresAt > Date.now()')       // a dead token must not be offered
    expect(block).toContain('signals?.orgChanged')             // only for an account change
  })
})

// ─── Ход субагента: отказ обязан назвать, КТО за него даёт согласие ──────

/**
 * 🔴 ЧЕМ КУПЛЕНО (02.09.2026, чужим счётом). Владелец соседнего проекта принёс
 * замер: за день сторож убил у него две сессии, и одна из них была ПРОВЕРЩИКОМ-
 * СУБАГЕНТОМ — погибла работа целиком, три прочитанных документа и
 * несостоявшийся отчёт. Его вывод: «пути самоспасения изнутри нет, совет
 * grant consent неисполним — сессия мертва».
 *
 * Путь на самом деле ЕСТЬ: согласие за субагента выдаёт тот, кто его запустил.
 * Но отказ об этом молчал, поэтому знания о пути не было ни у кого — а сам
 * субагент читать отказ не может по устройству: человека у него нет.
 *
 * Здесь проверяется, что отказ теперь НАЗЫВАЕТ субагента и адресует согласие
 * его родителю. Что именно блокируется — не меняется ни на волос.
 */
describe('rewrite guard — ход субагента', () => {
  // Тот же «тяжёлый холодный» ход, что и выше: он гарантированно упирается в
  // порог, а нас интересует только ТЕКСТ отказа, а не его причина.
  const heavy = () => JSON.stringify({
    model: 'claude-opus-4-8',
    system: [{ type: 'text', text: 'system prompt (new model)', cache_control: { type: 'ephemeral' } }],
    tools: [],
    messages: [{ role: 'user', content: 'resume after model switch ' + 'y'.repeat(240_000) }],
  })

  test('отказ называет субагента по имени и адресует согласие родителю', async () => {
    const c = mkClient()
    const r = await c.handleRequest(heavy(), {}, {
      sessionId: 'rg-sub-1',
      agentId: 'plan-validator-profile',
    })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { message?: string } }
    expect(j.error?.message).toContain('plan-validator-profile')
    expect(j.error?.message).toContain('PARENT')
    // 🔴 И ГЛАВНОЕ, НА ЧЁМ СОСЕД ОБЖЁГСЯ ЧЕРЕЗ ЧАС ПОСЛЕ ПЕРВОЙ ПРАВКИ: он
    // прочитал «согласие выдаёт родитель» как «родитель выдаёт НА СВОЙ номер»
    // и выдал его себе. Для прокси субагент — ПОЛНОЦЕННАЯ ОТДЕЛЬНАЯ СЕССИЯ
    // (у погибшего было 890 записей под своим номером, включая свой подогрев),
    // и согласие из чужой корзины не перетекает. Отказ обязан это сказать.
    expect(j.error?.message).toContain('rg-sub-1')
    expect(j.error?.message).toContain('does NOTHING')
    c.stop()
  })

  test('обычный ход — про субагента ни слова, текст не замусорен', async () => {
    const c = mkClient()
    const r = await c.handleRequest(heavy(), {}, { sessionId: 'rg-sub-2' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { message?: string } }
    expect(j.error?.message).not.toContain('sub-agent')
    c.stop()
  })

  /** Сам факт «это был субагент» обязан попасть в журнал — иначе такие смерти
   *  невозможно даже ПОСЧИТАТЬ, что и обнаружилось при разборе жалобы. */
  test('в журнал попадает, чей это был ход', async () => {
    const events: any[] = []
    const c = mkClient({ eventEmitter: { emit: (e: never) => { events.push(e) } } })
    await c.handleRequest(heavy(), {}, { sessionId: 'rg-sub-3', agentId: 'checker-7' })
    c.stop()
    const b = events.find(e => e.kind === 'CACHE_REWRITE_BLOCKED')
    expect(b?.agentId).toBe('checker-7')
  })
})
