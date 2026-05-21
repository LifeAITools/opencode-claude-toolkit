/**
 * KA snapshot restore — end-to-end across a simulated proxy restart.
 *
 * Drives two ProxyClient instances sharing one kaSnapshotPath: client A arms a
 * KA engine and stops (persisting); client B is a fresh process that must
 * revive the still-warm session and DROP a dead one — and, for a dropped
 * lineage, surface the next real request as a genuine blockable rewrite
 * rather than a free `expected:proxy-restart`.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { lineageKey, prefixHashes } from '../src/lineage.js'

const TMP = mkdtempSync(join(tmpdir(), 'ka-restore-'))
let seq = 0

/** Upstream mock that carries usage — so the engine actually registers a
 *  snapshot (a snapshot needs totalTokens >= minTokens). */
function sseWithUsage(inputTokens = 50_000): Response {
  const body =
    'event: message_start\n'
    + `data: {"type":"message_start","message":{"usage":{"input_tokens":${inputTokens},`
    + '"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const FILLER = 'x'.repeat(6000)
const reqBody = (extra = '') => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'Read' }, { name: 'Edit' }, { name: 'Bash' }],
  messages: [{ role: 'user', content: 'do the work ' + FILLER + ' ' + extra }],
})

function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  const events: any[] = []
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 300 },                       // realistic 5m TTL
    credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
    upstreamFetcher: { fetch: async () => sseWithUsage() },
    eventEmitter: { emit: (e: any) => events.push(e) },
    livenessChecker: { isAlive: () => true },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    orgIdResolver: { current: () => 'org-x' },
    proxyStartedAt: 0,
    ...extra,
  })
  return { c, events }
}

/** Hand-write a ka-snapshot file (one session) — for the stale / owner-dead cases. */
function seedKaFile(path: string, session: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({
    version: 1,
    savedAt: Date.now(),
    sessions: { [session.sessionId as string]: session },
  }))
}

describe('KA restore — revive a still-warm session across a restart', () => {
  test('a session armed before the restart is revived with an armed engine', async () => {
    const path = join(TMP, 'success.json')

    // ── client A: serve a real request → engine registers a snapshot → stop.
    const a = mkClient({ kaSnapshotPath: path })
    const r = await a.c.handleRequest(reqBody(), {}, { sessionId: 'restore-1', sourcePid: process.pid })
    await r.text().catch(() => {})
    await Bun.sleep(200)                                   // let the background SSE parse register
    expect(a.c.listSessions()[0]?.engine._registry.size).toBeGreaterThan(0)
    a.c.stop()                                             // persists the KA snapshot file

    // ── client B: fresh process — must revive the still-warm session.
    const b = mkClient({ kaSnapshotPath: path })
    expect(b.events.some((e) => e.kind === 'KA_REVIVED')).toBe(true)
    const sess = b.c.listSessions().find((s) => s.sessionId === 'restore-1')
    expect(sess).toBeDefined()
    expect(sess!.engine._registry.size).toBeGreaterThan(0) // registry restored
    expect(sess!.engine._timer).not.toBeNull()             // armed WITHOUT a real request
    b.c.stop()
  })
})

describe('KA restore — drop a snapshot that cannot be safely revived', () => {
  test('a long-dead cache is dropped (cache-already-dead), no engine revived', () => {
    const path = join(TMP, 'stale.json')
    const now = Date.now()
    seedKaFile(path, {
      sessionId: 'restore-stale', ownerPid: process.pid, model: 'claude-opus-4-7',
      cacheWrittenAt: now - 3_000_000,                     // 50 min ago — long past TTL
      cacheTtlMs: 300_000, cacheTtlOverridden: true, cacheTtlObservedLocked: false,
      lastObservedTtlMs: 300_000, ttlEverObserved: true, lastKnownCacheTokensByModel: {},
      registry: [{
        body: JSON.parse(reqBody()), headers: {}, model: 'claude-opus-4-7',
        lineageKey: 'lin-x', role: 'main', inputTokens: 50_000, hasCacheControl: true,
      }],
    })
    const b = mkClient({ kaSnapshotPath: path })
    const drop = b.events.find((e) => e.kind === 'KA_REVIVE_DROP')
    expect(drop?.reason).toBe('cache-already-dead')
    expect(b.c.listSessions().find((s) => s.sessionId === 'restore-stale')).toBeUndefined()
    b.c.stop()
  })

  test('a snapshot whose owner PID is dead is dropped (owner-dead)', () => {
    const path = join(TMP, 'ownerdead.json')
    const now = Date.now()
    seedKaFile(path, {
      sessionId: 'restore-od', ownerPid: 999_999, model: 'm',
      cacheWrittenAt: now - 5_000,                         // cache itself is fresh
      cacheTtlMs: 300_000, cacheTtlOverridden: true, cacheTtlObservedLocked: false,
      lastObservedTtlMs: 300_000, ttlEverObserved: true, lastKnownCacheTokensByModel: {},
      registry: [{
        body: {}, headers: {}, model: 'm',
        lineageKey: 'l', role: 'main', inputTokens: 50_000, hasCacheControl: true,
      }],
    })
    const b = mkClient({ kaSnapshotPath: path, livenessChecker: { isAlive: () => false } })
    const drop = b.events.find((e) => e.kind === 'KA_REVIVE_DROP')
    expect(drop?.reason).toBe('owner-dead')
    b.c.stop()
  })
})

describe('KA restore — a dropped lineage makes the next request a real rewrite', () => {
  test('dropped snapshot → next request → 400 avoidable:ttl-expiry (NOT expected:proxy-restart)', async () => {
    const kaPath = join(TMP, 'block-ka.json')
    const phPath = join(TMP, 'block-ph.json')
    const now = Date.now()
    const body = JSON.parse(reqBody())
    const lk = lineageKey(body)

    // ka-snapshot: a dead cache for this exact lineage → revive will DROP it.
    seedKaFile(kaPath, {
      sessionId: 'restore-blk', ownerPid: process.pid, model: 'claude-opus-4-7',
      cacheWrittenAt: now - 3_000_000,
      cacheTtlMs: 300_000, cacheTtlOverridden: true, cacheTtlObservedLocked: false,
      lastObservedTtlMs: 300_000, ttlEverObserved: true, lastKnownCacheTokensByModel: {},
      registry: [{
        body, headers: {}, model: 'claude-opus-4-7',
        lineageKey: lk, role: 'main', inputTokens: 50_000, hasCacheControl: true,
      }],
    })
    // prefix-history: a prior request for the lineage, long idle → ttl-expiry,
    // and NOT a first request (so the guard's ttl-expiry path is reached).
    writeFileSync(phPath, JSON.stringify({
      [`restore-blk:${lk}`]: {
        hashes: prefixHashes(body), lastReqAt: now - 600_000, orgId: 'org-x',
      },
    }))

    const b = mkClient({ kaSnapshotPath: kaPath, prefixHistoryPath: phPath })
    expect(b.events.some((e) => e.kind === 'KA_REVIVE_DROP')).toBe(true)

    // The next real request for that lineage is a genuine rewrite — the guard
    // must block it (avoidable), NOT wave it through as expected:proxy-restart.
    const r = await b.c.handleRequest(reqBody(), {}, { sessionId: 'restore-blk', sourcePid: process.pid })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string } }
    expect(j.error?.type).toBe('cache_rewrite_guard')
    b.c.stop()
  })
})

describe('KA restore — host downtime (reboot/power loss) is NOT an avoidable rewrite', () => {
  test('cache-already-dead across a real proxy restart → expected:proxy-restart, request passes (no 400)', async () => {
    // Reproduces the power-loss case: the machine was off long enough that the
    // cache lapsed; on reboot the proxy revives its snapshot registry, finds
    // this lineage's cache already dead, and drops it. No keepalive could have
    // run while the host was off, so the rewrite is UNAVOIDABLE — the guard
    // must classify it `expected:proxy-restart` and let the resumed session's
    // first request through, not 400-block it as `avoidable:ttl-expiry`.
    const kaPath = join(TMP, 'reboot-ka.json')
    const phPath = join(TMP, 'reboot-ph.json')
    const now = Date.now()
    const body = JSON.parse(reqBody())
    const lk = lineageKey(body)

    seedKaFile(kaPath, {
      sessionId: 'restore-reboot', ownerPid: process.pid, model: 'claude-opus-4-7',
      cacheWrittenAt: now - 3_000_000,                     // long-dead (host was off)
      cacheTtlMs: 300_000, cacheTtlOverridden: true, cacheTtlObservedLocked: false,
      lastObservedTtlMs: 300_000, ttlEverObserved: true, lastKnownCacheTokensByModel: {},
      registry: [{
        body, headers: {}, model: 'claude-opus-4-7',
        lineageKey: lk, role: 'main', inputTokens: 50_000, hasCacheControl: true,
      }],
    })
    // prior request predates the reboot; same org → only the TTL gap differs.
    writeFileSync(phPath, JSON.stringify({
      [`restore-reboot:${lk}`]: {
        hashes: prefixHashes(body), lastReqAt: now - 3_000_000, orgId: 'org-x',
      },
    }))

    // proxyStartedAt = "just rebooted": the warm-up predates this process, so
    // spansProxyRestart is genuinely true (unlike the proxyStartedAt:0 cases).
    const b = mkClient({ kaSnapshotPath: kaPath, prefixHistoryPath: phPath, proxyStartedAt: now - 1_000 })
    const drop = b.events.find((e: any) => e.kind === 'KA_REVIVE_DROP')
    expect(drop?.reason).toBe('cache-already-dead')

    const r = await b.c.handleRequest(reqBody(), {}, { sessionId: 'restore-reboot', sourcePid: process.pid })
    expect(r.status).toBe(200)
    const pred = b.events.find((e: any) => e.kind === 'PREDICTED_CACHE_MISS')
    expect(pred?.rewriteClass).toBe('expected:proxy-restart')
    b.c.stop()
  })
})
