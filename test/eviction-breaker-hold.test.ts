/**
 * The fleet breaker must HOLD a sibling, not strip it.
 *
 * Why this file exists — measured 2026-08-19 07:14-07:19Z: one genuine eviction
 * tripped the shared breaker and 26 sessions were disarmed inside five minutes.
 * Twelve were actively working and re-armed on their next real request. The
 * other fourteen were idle, and an idle session issues no requests — so nothing
 * ever re-armed them. Hours later each was woken into a full ~450k cold rewrite:
 * exactly what the breaker exists to prevent, merely deferred.
 *
 * Both sides are asserted here, because a guard proved on only one of them is
 * the guard that gets removed later: it must HOLD while the cache outlives the
 * cooldown, and still DISARM when it does not.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { EvictionCircuitBreaker, decideBreakerAction } from '../src/eviction-breaker.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = () => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

function mkEngine(
  breaker: EvictionCircuitBreaker,
  held: { n: number; last: any },
  disarmed: { reasons: string[] },
  // The fleet's real setting (see ~/.claude/keepalive.json: cacheTtlSec 3600).
  // Passed explicitly so the test does not silently inherit a machine's SSOT.
  cacheTtlMs = 3_600_000,
) {
  let fireCount = 0
  const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
    fireCount++
    yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
  }
  const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }
  const e = new KeepaliveEngine({
    evictionBreaker: breaker,
    config: {
      cacheTtlMs,
      onHeld: (i) => { held.n++; held.last = i },
      onDisarmed: (i) => { disarmed.reasons.push(i.reason) },
    },
    getToken: async () => 'tok',
    doFetch: fakeFetch,
    getRateLimitInfo: () => rl,
  })
  return { e, getFireCount: () => fireCount }
}

function arm(e: KeepaliveEngine): void {
  const key = e.notifyRealRequestStart('claude-opus-5', sys(), {})
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
}

describe('the pure choice', () => {
  test('HOLDS while the cache outlives the cooldown', () => {
    expect(decideBreakerAction({
      cooldownRemainingMs: 300_000, cacheAgeMs: 60_000,
      cacheTtlMs: 3_600_000, safetyMarginMs: 60_000,
    })).toBe('hold')
  })

  test('DISARMS when the cache dies before the cooldown ends — nothing left to keep', () => {
    expect(decideBreakerAction({
      cooldownRemainingMs: 300_000, cacheAgeMs: 3_500_000,
      cacheTtlMs: 3_600_000, safetyMarginMs: 60_000,
    })).toBe('disarm')
  })

  test('DISARMS when there is no snapshot at all', () => {
    expect(decideBreakerAction({
      cooldownRemainingMs: 300_000, cacheAgeMs: -1,
      cacheTtlMs: 3_600_000, safetyMarginMs: 60_000,
    })).toBe('disarm')
  })
})

describe('a sibling meeting a tripped breaker', () => {
  test('keeps its snapshot, does not fire, and reports the hold as a hold', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const held = { n: 0, last: null as any }
    const disarmed = { reasons: [] as string[] }
    const { e, getFireCount } = mkEngine(breaker, held, disarmed)
    arm(e)
    const armedSize = e._registry.size
    expect(armedSize).toBeGreaterThan(0)

    breaker.trip(Date.now(), { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    await e._tick()

    expect(getFireCount()).toBe(0)                 // never fires into the storm
    expect(e._registry.size).toBe(armedSize)       // THE POINT: warmth is kept
    expect(held.n).toBe(1)                         // and the hold says so out loud
    expect(held.last.reason).toBe('eviction_breaker_tripped')
    expect(held.last.holdMs).toBeGreaterThan(0)
    expect(disarmed.reasons).not.toContain('eviction_breaker_tripped')
    e.stop()
  })

  test('does not restack the hold on every tick', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const held = { n: 0, last: null as any }
    const disarmed = { reasons: [] as string[] }
    const { e } = mkEngine(breaker, held, disarmed)
    arm(e)
    breaker.trip(Date.now(), { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    await e._tick()
    await e._tick()
    await e._tick()
    expect(held.n).toBe(1)
    e.stop()
  })
})

describe('a consumer whose cache lives only five minutes', () => {
  test('still DISARMS — the cache cannot outlive the cooldown, so there is nothing to hold', async () => {
    // Not a weakness of the hold but its condition, stated out loud: with a
    // 5-minute TTL against a 5-minute cooldown the prefix dies during the wait,
    // and keeping a snapshot of a corpse would only guarantee a cold write on
    // resume. The proxy pins exactly this TTL for native Claude Code, so this
    // pole is a live configuration, not a hypothetical.
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const held = { n: 0, last: null as any }
    const disarmed = { reasons: [] as string[] }
    const { e } = mkEngine(breaker, held, disarmed, 300_000)
    arm(e)
    breaker.trip(Date.now(), { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    await e._tick()

    expect(held.n).toBe(0)
    expect(disarmed.reasons).toContain('eviction_breaker_tripped')
    expect(e._registry.size).toBe(0)
    e.stop()
  })
})
