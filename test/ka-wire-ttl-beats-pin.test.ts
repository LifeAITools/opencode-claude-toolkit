/**
 * A pinned cache lifetime may not claim MORE life than the wire proves.
 *
 * The founder's question, 2026-08-20, in his words: what if a session switches
 * its cache marker to five minutes and we go on waiting an hour? Then every
 * keepalive fire lands on a prefix that died twenty-five minutes earlier, and
 * each one buys the whole thing again — roughly a million tokens, every half
 * hour, for as long as the session lives.
 *
 * Measured that day: all 260 wire observations said an hour and no session ever
 * changed, so this is a guard against a case that has not happened rather than
 * a wound being closed. It exists because the two mistakes cost wildly
 * different amounts: firing too early costs a few cheap READS, firing too late
 * costs a full cold WRITE of the entire prefix.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }

const bodyWithTtl = (ttl: string) => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] }],
})

function pinnedEngine(pinnedTtlMs: number) {
  return new KeepaliveEngine({
    // A consumer that pins an HOUR — exactly what the proxy does for the fleet.
    config: { cacheTtlMs: pinnedTtlMs, intervalMs: 1_800_000, minTokens: 1 },
    getToken: async () => 'tok',
    doFetch: async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 10 }, stopReason: 'end_turn' } as any
    },
    getRateLimitInfo: () => rl,
  })
}

describe('the wire against the pin', () => {
  test('a five-minute marker lowers an hour-long pin', () => {
    const e = pinnedEngine(3_600_000)
    expect(e._cacheTtlMs).toBe(3_600_000)
    e.notifyRealRequestStart('claude-opus-5', bodyWithTtl('5m') as any, {})
    expect(e._cacheTtlMs).toBe(300_000)   // THE POINT: the pin does not shield it
    e.stop()
  })

  test('and the fire cadence follows it down, so a fire lands on a LIVE cache', async () => {
    // Lowering the lifetime without lowering the cadence would change nothing:
    // the fire would still arrive after the cache is gone.
    const e = pinnedEngine(3_600_000)
    e.notifyRealRequestStart('claude-opus-5', bodyWithTtl('5m') as any, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 } as any)
    await e._tick()                        // the tick re-clamps against the new lifetime
    expect(e._intervalMs).toBeLessThan(e._cacheTtlMs - e._safetyMarginMs)
    e.stop()
  })

  test('an hour-long marker never RAISES a lifetime already proven shorter', () => {
    // A short-TTL block seen once may still be alive upstream, so the faster
    // cadence stays until the engine is rebuilt.
    const e = pinnedEngine(3_600_000)
    e.notifyRealRequestStart('claude-opus-5', bodyWithTtl('5m') as any, {})
    expect(e._cacheTtlMs).toBe(300_000)
    e.notifyRealRequestStart('claude-opus-5', bodyWithTtl('1h') as any, {})
    expect(e._cacheTtlMs).toBe(300_000)
    e.stop()
  })
})
