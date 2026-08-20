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
