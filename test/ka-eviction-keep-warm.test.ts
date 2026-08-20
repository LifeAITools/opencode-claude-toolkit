/**
 * A keepalive fire cold-wrote the cache. Keep warming this lineage, or drop it?
 *
 * The old answer was always "drop it", and it was right for the world it was
 * written in: on 2026-05-18 the same 915k write repeated every 13 minutes,
 * because the cache lived 5 minutes and the next fire came 13 minutes later.
 * Every fire was a fresh full-price purchase.
 *
 * The fleet no longer lives in that world — it caches for an hour and fires
 * every half hour, so the next fire reads what the last one paid for. Dropping
 * the lineage there throws away a cache the session will want on its return.
 * The founder put it plainly, twice: we already paid, so switch it back on.
 *
 * Both worlds are asserted here. A rule proved in only one of them is the rule
 * that gets reverted by whoever meets the other.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { decidePostEvictionFate } from '../src/eviction-breaker.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const body = () => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }

/** A fire that comes back as a full cold write — the eviction signature. */
function coldWritingFetch(n: { fires: number }) {
  return async function* (): AsyncGenerator<StreamEvent> {
    n.fires++
    yield {
      type: 'message_stop',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 900_000 },
      stopReason: 'end_turn',
    } as any
  }
}

function mkEngine(n: { fires: number }, disarmed: { reasons: string[] }, cacheTtlMs: number, intervalMs: number) {
  return new KeepaliveEngine({
    config: { cacheTtlMs, intervalMs, onDisarmed: (i) => { disarmed.reasons.push(i.reason) } },
    getToken: async () => 'tok',
    doFetch: coldWritingFetch(n),
    getRateLimitInfo: () => rl,
  })
}

function armAndAge(e: KeepaliveEngine, ageMs: number): void {
  const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
  e.notifyRealRequestComplete({ inputTokens: 200_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  e._setLineageRole(key, 'main')   // only the session's own cache is kept — see the rule
  e._setCacheWrittenAt(Date.now() - ageMs)
  e._ageLineages(ageMs)
}

describe('the rule itself', () => {
  test("the fleet's own numbers say KEEP — an hour of cache, a fire every half hour", () => {
    expect(decidePostEvictionFate({ intervalMs: 1_800_000, cacheTtlMs: 3_600_000, safetyMarginMs: 60_000, isMain: true }))
      .toBe('keep-warm')
  })

  test('the 2026-05-18 numbers say RETIRE — five minutes of cache, a fire every thirteen', () => {
    expect(decidePostEvictionFate({ intervalMs: 780_000, cacheTtlMs: 300_000, safetyMarginMs: 60_000, isMain: true }))
      .toBe('retire')
  })

  test('a delegated worker is still retired — nobody is left to read its prefix', () => {
    // The 2026-06-04 cleanup of abandoned secondary prefixes is untouched: the
    // money argument applies to both, but only a MAIN lineage comes back to
    // read what we bought.
    expect(decidePostEvictionFate({ intervalMs: 1_800_000, cacheTtlMs: 3_600_000, safetyMarginMs: 60_000, isMain: false }))
      .toBe('retire')
  })

  test('a fire that lands exactly when the cache dies is already too late', () => {
    expect(decidePostEvictionFate({ intervalMs: 240_000, cacheTtlMs: 300_000, safetyMarginMs: 60_000, isMain: true }))
      .toBe('retire')
  })
})

describe('through the real fire path', () => {
  test('fleet cadence: the paid-for cache is KEPT and the session stays armed', async () => {
    const n = { fires: 0 }
    const disarmed = { reasons: [] as string[] }
    const e = mkEngine(n, disarmed, 3_600_000, 1_800_000)
    armAndAge(e, 1_800_000)
    await e._tick()

    expect(n.fires).toBe(1)
    expect(e._registry.size).toBe(1)                       // THE POINT: not thrown away
    expect(disarmed.reasons).not.toContain('cache_evicted_post_fire')
    e.stop()
  })

  test('the clamp is WHY it is always kept — and this test is what guards that', () => {
    // The engine clamps its own interval to sit inside the cache's life
    // (max = ttl - margin - 60s). While that holds, the fire always lands on a
    // live cache and 'retire' is unreachable through the engine — which is
    // exactly why the pure rule above is tested directly rather than through it.
    //
    // If anyone ever weakens the clamp, this goes red and the retire branch
    // becomes live again. That is the point of asserting it here: the branch is
    // dormant BY CONSTRUCTION, not by luck, and the construction is checked.
    for (const [ttl, asked] of [[3_600_000, 1_800_000], [300_000, 240_000], [600_000, 9_999_000]] as const) {
      const e = mkEngine({ fires: 0 }, { reasons: [] }, ttl, asked)
      expect(e._intervalMs).toBeLessThan(ttl - e._safetyMarginMs)
      e.stop()
    }
  })
})
