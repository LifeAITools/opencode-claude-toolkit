/**
 * EvictionCircuitBreaker ↔ KeepaliveEngine wiring (integration).
 *
 * Proves the consumption side end-to-end through the real tick() path:
 * a tripped shared breaker makes an armed engine HOLD at Layer 0c — it returns
 * BEFORE the onTick hook (which only fires at the later idle-gate) and never
 * calls doFetch, while leaving the registry armed (hold, not disarm).
 *
 * Distinguishing the hold-gate from the idle-gate: onTick is emitted at the
 * idle-gate but NOT at the eviction hold-gate (which returns earlier). So
 * "onTick called" ⇒ tick passed the hold-gate; "onTick not called" ⇒ held.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { EvictionCircuitBreaker } from '../src/eviction-breaker.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = (ttl?: string) => ({
  system: [{ type: 'text', text: 'sys', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }],
})

function mkEngine(breaker: EvictionCircuitBreaker | undefined, onTickCount: { n: number }) {
  let fireCount = 0
  const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
    fireCount++
    yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
  }
  const fakeRateLimit: RateLimitInfo = {
    status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0,
  }
  const e = new KeepaliveEngine({
    evictionBreaker: breaker,
    config: { onTick: () => { onTickCount.n++ } },
    getToken: async () => 'fake-token',
    doFetch: fakeFetch,
    getRateLimitInfo: () => fakeRateLimit,
  })
  return { e, getFireCount: () => fireCount }
}

/** Arm an engine with one cache-control snapshot so its registry is non-empty. */
function arm(e: KeepaliveEngine): void {
  const key = e.notifyRealRequestStart('claude-opus-4-7', sys('1h'), {})
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
}

describe('eviction breaker ↔ engine tick integration', () => {
  test('tripped breaker DISARMS an armed engine: no fire, no onTick, registry cleared', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const ticks = { n: 0 }
    const { e, getFireCount } = mkEngine(breaker, ticks)
    arm(e)
    expect(e._registry.size).toBeGreaterThan(0)

    breaker.trip(Date.now(), { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    await e._tick()

    expect(getFireCount()).toBe(0)        // never fired — no cold rewrite into the storm
    expect(ticks.n).toBe(0)               // returned at the disarm-gate, before onTick
    expect(e._registry.size).toBe(0)      // DISARMED — stale snapshot dropped
    expect(e._timer).toBeNull()           // timer stopped; re-arms on next real request
  })

  test('disarmed engine re-arms cleanly on the next real request', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const ticks = { n: 0 }
    const { e } = mkEngine(breaker, ticks)
    arm(e)
    breaker.trip(Date.now(), { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    await e._tick()
    expect(e._registry.size).toBe(0) // disarmed

    // A real request returns: the engine re-snapshots and re-arms.
    arm(e)
    expect(e._registry.size).toBeGreaterThan(0)
  })

  test('untripped breaker does NOT hold: tick passes the hold-gate (onTick fires)', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const ticks = { n: 0 }
    const { e } = mkEngine(breaker, ticks)
    arm(e)

    await e._tick() // breaker present but never tripped

    expect(ticks.n).toBe(1) // reached the idle-gate → proves hold-gate let it through
  })

  test('breaker auto-clears after cooldown: engine resumes (onTick fires again)', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const ticks = { n: 0 }
    const { e } = mkEngine(breaker, ticks)
    arm(e)

    // Trip in the past so the cooldown has already elapsed by now.
    breaker.trip(Date.now() - 400_000, { lineageKey: 'lin', cacheWrite: 800_000, cacheRead: 0 })
    expect(breaker.isTripped(Date.now())).toBe(false)

    await e._tick()
    expect(ticks.n).toBe(1) // storm passed → no longer held
  })
})
