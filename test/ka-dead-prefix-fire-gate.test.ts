/**
 * Two guards against the fleet-wide loss of warmth measured on 2026-08-19.
 *
 * 1. NEVER FIRE A DEAD PREFIX. A keepalive fire is a refresh only while the
 *    cache it replays is still alive; past that it is a full cold WRITE of a
 *    prefix nobody will read. On 2026-08-19 the same body was replayed by six
 *    different processes, ~1.65M cache-write tokens each time (915579 + 4x
 *    182781, byte-identical), and only afterwards did the engine announce
 *    cacheAgeSec=10800 against cacheTtlSec=300. The check has to stand in front
 *    of the spend.
 *
 * 2. OUR OWN CORPSE IS NOT EVIDENCE ABOUT THE SERVER. That cold write carries
 *    the exact signature of a server-side eviction, so it tripped the shared
 *    fleet breaker and disarmed 26 healthy sessions. A snapshot this process
 *    resurrected from the shared file proves nothing about upstream; only a
 *    lineage a live request handed us may speak for the fleet.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { EvictionCircuitBreaker } from '../src/eviction-breaker.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const body = () => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

/** doFetch that reports the cold-write signature of an evicted prefix. */
function evictingFetch(counter: { n: number }) {
  return async function* (): AsyncGenerator<StreamEvent> {
    counter.n++
    yield {
      type: 'message_stop',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 900_000 },
      stopReason: 'end_turn',
    } as any
  }
}

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }

function mkEngine(fires: { n: number }, disarmed: { reasons: string[] }, breaker?: EvictionCircuitBreaker) {
  return new KeepaliveEngine({
    evictionBreaker: breaker,
    config: {
      cacheTtlMs: 3_600_000,
      intervalMs: 60_000,
      onDisarmed: (i) => { disarmed.reasons.push(i.reason) },
    },
    getToken: async () => 'tok',
    doFetch: evictingFetch(fires),
    getRateLimitInfo: () => rl,
  })
}

function arm(e: KeepaliveEngine): string {
  const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
  e.notifyRealRequestComplete({ inputTokens: 200_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  // Only a MAIN lineage may speak for the fleet; pin it so the two provenance
  // cases below differ in provenance ALONE.
  e._setLineageRole(key, 'main')
  return key
}

describe('the fire gate', () => {
  test('a prefix inside its dying margin is never fired — the last gate before the spend', async () => {
    // The wake-from-sleep branch earlier in the tick already refuses a cache
    // past its FULL TTL. What it does not refuse is the safety margin — the
    // last stretch in which the prefix is already as good as gone, and a fire
    // is a cold write rather than a refresh. This test aims at exactly that
    // band, because a test aimed at the 3-hour case proves the older branch
    // and would stay green with this gate deleted (it did, on first writing).
    const fires = { n: 0 }
    const disarmed = { reasons: [] as string[] }
    const e = mkEngine(fires, disarmed)
    arm(e)
    const margin = e._safetyMarginMs
    expect(margin).toBeGreaterThan(0)
    const ageInsideMargin = 3_600_000 - Math.floor(margin / 2)
    e._setCacheWrittenAt(Date.now() - ageInsideMargin)
    e._ageLineages(ageInsideMargin)
    await e._tick()

    expect(fires.n).toBe(0)                          // THE POINT: nothing spent
    expect(disarmed.reasons).toContain('cache_dead_at_fire_gate')
    e.stop()
  })

  test('a live prefix still fires — the gate is silent on the right move', async () => {
    const fires = { n: 0 }
    const disarmed = { reasons: [] as string[] }
    const e = mkEngine(fires, disarmed)
    arm(e)
    e._setCacheWrittenAt(Date.now() - 120_000)
    e._ageLineages(120_000)
    await e._tick()

    expect(fires.n).toBe(1)
    expect(disarmed.reasons).not.toContain('cache_dead_at_fire_gate')
    e.stop()
  })
})

describe('who may speak for the fleet', () => {
  test('a resurrected lineage cold-writing does NOT trip the breaker', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const fires = { n: 0 }
    const disarmed = { reasons: [] as string[] }
    const donor = mkEngine({ n: 0 }, { reasons: [] }, breaker)
    arm(donor)
    const state = donor.serializeState()!
    donor.stop()

    const revived = mkEngine(fires, disarmed, breaker)
    revived.revive({ ...state, cacheWrittenAt: Date.now() - 120_000 })
    for (const k of revived._registry.keys()) revived._setLineageRole(k, 'main')
    revived._ageLineages(120_000)
    await revived._tick()

    expect(fires.n).toBe(1)                       // it did fire and did cold-write
    expect(breaker.tripCount(Date.now())).toBe(0) // THE POINT: the fleet is not told
    revived.stop()
  })

  test('a lineage a real request handed us DOES trip it', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const fires = { n: 0 }
    const disarmed = { reasons: [] as string[] }
    const e = mkEngine(fires, disarmed, breaker)
    arm(e)
    e._setCacheWrittenAt(Date.now() - 120_000)
    e._ageLineages(120_000)
    await e._tick()

    expect(fires.n).toBe(1)
    expect(breaker.tripCount(Date.now())).toBe(1)
    e.stop()
  })
})
