/**
 * The half of the spend the eviction test cannot see.
 *
 * The eviction test asks for a LARGE write beside a NEAR-ZERO read — a prefix
 * that vanished whole. A prefix can also lose only its tail: the shared head
 * still reads back and everything after it is bought again, so the test sees a
 * big read and stays quiet.
 *
 * Measured 2026-08-20 over a full day of fleet traffic: keepalive wrote 8.95M
 * cache tokens, 3.87M of them caught by the eviction test and 5.08M — 57% —
 * passing with no event of any kind. Eleven fires, each with an unchanged
 * snapshot and no request from the session in between.
 *
 * This reports only. The point is to make the spend measurable before anyone
 * decides what to do about it.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }

const body = () => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

function mkEngine(usage: { cacheReadInputTokens: number; cacheCreationInputTokens: number }, seen: any[]) {
  return new KeepaliveEngine({
    config: {
      cacheTtlMs: 3_600_000,
      intervalMs: 60_000,
      onPartialRewrite: (i) => seen.push(i),
    },
    getToken: async () => 'tok',
    doFetch: async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: { inputTokens: 1, outputTokens: 1, ...usage }, stopReason: 'end_turn' } as any
    },
    getRateLimitInfo: () => rl,
  })
}

async function fireOnce(e: KeepaliveEngine) {
  const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
  e.notifyRealRequestComplete({ inputTokens: 200_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  e._setLineageRole(key, 'main')
  e._setCacheWrittenAt(Date.now() - 120_000)
  e._ageLineages(120_000)
  await e._tick()
}

describe('a rewrite that keeps the head', () => {
  test('the real live shape is reported — head 120 852 kept, tail 706 839 bought again', async () => {
    const seen: any[] = []
    const e = mkEngine({ cacheReadInputTokens: 120_852, cacheCreationInputTokens: 706_839 }, seen)
    await fireOnce(e)
    expect(seen).toHaveLength(1)
    expect(seen[0].cacheRead).toBe(120_852)
    expect(seen[0].cacheWrite).toBe(706_839)
    e.stop()
  })

  test('a healthy fire that writes nothing is not reported', async () => {
    const seen: any[] = []
    const e = mkEngine({ cacheReadInputTokens: 900_000, cacheCreationInputTokens: 0 }, seen)
    await fireOnce(e)
    expect(seen).toHaveLength(0)
    e.stop()
  })

  test('a whole-prefix loss stays with the eviction path, not this one', async () => {
    // Otherwise the same event would be counted twice and the day's totals
    // would stop adding up.
    const seen: any[] = []
    const e = mkEngine({ cacheReadInputTokens: 0, cacheCreationInputTokens: 900_000 }, seen)
    await fireOnce(e)
    expect(seen).toHaveLength(0)
    e.stop()
  })

  test('a small write is beneath notice — this is about the big spend', async () => {
    const seen: any[] = []
    const e = mkEngine({ cacheReadInputTokens: 5_000, cacheCreationInputTokens: 900 }, seen)
    await fireOnce(e)
    expect(seen).toHaveLength(0)
    e.stop()
  })
})

/**
 * The observer above existed for two weeks and reported to NOBODY.
 *
 * `onPartialRewrite` was declared in the options type and forwarded by the
 * engine — and no caller ever passed one, so the only trace of the spend was a
 * line in ~/.claude/claude-max-debug.log, which rotates in about two days. The
 * measurement it was built for could therefore never be taken: on 2026-09-03
 * the day's figures had to be reconstructed from cache-usage arithmetic across
 * the whole journal, because the event that names this exact case did not exist
 * in it.
 *
 * The figures that reconstruction produced are why the wiring matters: over one
 * day keepalive accounted for 8.6% of the fleet's cache reads and 2.5% of its
 * model output — but 36% of ALL cache WRITES, 35M tokens. And a write is the
 * part that moves the subscription counter: three hours of pure keepalive
 * (11.2M read) moved the 5h window by 0.00, while sixteen minutes of fleet work
 * moved it +0.24.
 *
 * So this test does not check the detector — the block above does. It checks
 * that the detector is CONNECTED, which is the thing that was actually broken.
 */
describe('the report reaches the journal, not just a debug file', () => {
  test('ProxyClient hands the engine an onPartialRewrite that emits on the bus', async () => {
    const { ProxyClient } = await import('../src/proxy-client.js')
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const emitted: any[] = []
    const tmp = mkdtempSync(join(tmpdir(), 'ka-pr-wire-'))
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 3600 },
      credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
      upstreamFetcher: { fetch: async () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
      prefixHistoryPath: join(tmp, 'ph.json'),
      orgIdResolver: { current: () => 'org-x' },
      rewriteBlockDumpDir: join(tmp, 'dumps'),
      proxyStartedAt: 0,
      eventEmitter: { emit: (e: any) => emitted.push(e) },
    } as never)

    // Arm a session, then hand its engine the exact shape a tail-loss fire
    // returns: the head still reads back, everything after it is bought again.
    const r = await c.handleRequest(JSON.stringify({
      model: 'claude-opus-5',
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: 'x'.repeat(9000) }],
    }), {}, { sessionId: 'pr-wire-1' })
    await r.text()

    const engine = (c as any).store?.get?.('pr-wire-1')?.engine
    expect(engine).toBeTruthy()
    engine.config.onPartialRewrite({
      lineageKey: 'aaaa:bbbb', role: 'sub', cacheRead: 120_852, cacheWrite: 706_839,
      msSinceLastRealRequest: 45_000, at: Date.now(),
    })

    const ev = emitted.find(e => e.kind === 'KA_PARTIAL_REWRITE')
    expect(ev).toBeTruthy()
    // Чей это кэш — главный или отработавшего субагента. Одна сессия греет до
    // четырёх, и без роли нельзя ответить, за чьи именно платятся миллионы:
    // за ночь 03→04.09 прогрев перекупил контекст 49 раз на 7,1 млн токенов, и
    // вопрос «чьи это были кэши» упёрся в отсутствие ровно этого поля.
    expect('role' in ev).toBe(true)
    expect(ev.cacheWrite).toBe(706_839)
    expect(ev.cacheRead).toBe(120_852)
    expect(ev.sessionId).toBe('pr-wire-1')
    // The message has to say WHY this line matters, or a reader meets a number
    // with no reason to care about it.
    expect(ev.msg).toContain('bypasses the rewrite guard')
    await c.stop()
  })
})
