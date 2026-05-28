/**
 * EvictionCircuitBreaker — cross-engine back-off on server-side cache-eviction
 * storms. Pure, deterministic (caller passes `now`), no I/O.
 *
 * Scenario it guards: Anthropic evicts cached prefixes server-side; each
 * per-session KeepaliveEngine independently hits the eviction at its own fire
 * time and pays a full cold cache_creation rewrite. The first engine to detect
 * the cold-write signature trips this shared breaker; the others consult it at
 * their fire gate and HOLD (skip the fire) until the storm passes — converting
 * an N-session rewrite cascade into a single rewrite + a brief hold.
 */

import { describe, test, expect } from 'bun:test'
import { EvictionCircuitBreaker, isServerSideEviction } from '../src/eviction-breaker.js'

const meta = (cacheWrite = 800_000, cacheRead = 0) => ({
  sessionId: 'sess-1234',
  lineageKey: 'lin:acct',
  cacheWrite,
  cacheRead,
})

describe('EvictionCircuitBreaker: trip / isTripped', () => {
  test('not tripped initially', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    expect(b.isTripped(1_000)).toBe(false)
    expect(b.lastTrippedAt).toBeNull()
    expect(b.tripCount(1_000)).toBe(0)
  })

  test('a single trip engages the breaker (default minTripsToEngage=1)', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    b.trip(1_000, meta())
    expect(b.isTripped(1_000)).toBe(true)
    expect(b.lastTrippedAt).toBe(1_000)
  })

  test('breaker auto-clears after cooldown elapses', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    b.trip(1_000, meta())
    expect(b.isTripped(1_000 + 299_999)).toBe(true)
    expect(b.isTripped(1_000 + 300_000)).toBe(false) // boundary: cooldown elapsed
    expect(b.isTripped(1_000 + 400_000)).toBe(false)
  })

  test('cooldownRemainingMs counts down and floors at 0', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    b.trip(1_000, meta())
    expect(b.cooldownRemainingMs(1_000)).toBe(300_000)
    expect(b.cooldownRemainingMs(1_000 + 100_000)).toBe(200_000)
    expect(b.cooldownRemainingMs(1_000 + 500_000)).toBe(0)
  })

  test('a later trip extends the cooldown window', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    b.trip(1_000, meta())
    b.trip(200_000, meta()) // re-trip during an ongoing storm
    expect(b.isTripped(200_000 + 299_999)).toBe(true)
    expect(b.isTripped(200_000 + 300_000)).toBe(false)
  })
})

describe('EvictionCircuitBreaker: minTripsToEngage (false-positive guard)', () => {
  test('with minTripsToEngage=2, one trip does NOT engage', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000, minTripsToEngage: 2, windowMs: 300_000 })
    b.trip(1_000, meta())
    expect(b.isTripped(1_000)).toBe(false) // single trip = possible local marker-slide, not systemic
    expect(b.tripCount(1_000)).toBe(1)
  })

  test('with minTripsToEngage=2, two trips within window engage', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000, minTripsToEngage: 2, windowMs: 300_000 })
    b.trip(1_000, meta())
    b.trip(120_000, meta())
    expect(b.isTripped(120_000)).toBe(true)
  })

  test('trips older than windowMs are pruned from the engage count', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000, minTripsToEngage: 2, windowMs: 60_000 })
    b.trip(1_000, meta())
    b.trip(1_000 + 120_000, meta()) // first trip now outside the 60s window
    expect(b.tripCount(1_000 + 120_000)).toBe(1)
    expect(b.isTripped(1_000 + 120_000)).toBe(false)
  })
})

describe('EvictionCircuitBreaker: observability', () => {
  test('records last trip meta for logging/alerting', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    b.trip(5_000, meta(921_444, 63_464))
    expect(b.lastTrip?.cacheWrite).toBe(921_444)
    expect(b.lastTrip?.sessionId).toBe('sess-1234')
  })

  test('disabled breaker (cooldownMs<=0) never engages', () => {
    const b = new EvictionCircuitBreaker({ cooldownMs: 0 })
    b.trip(1_000, meta())
    expect(b.isTripped(1_000)).toBe(false)
  })
})

describe('isServerSideEviction: distinguishes server eviction from local cause', () => {
  const INTERVAL = 1_800_000 // 30 min (1h-TTL cadence)

  test('cold write on a stable (KA-only-warmed) snapshot = server-side → trips', () => {
    expect(isServerSideEviction({
      cacheWrite: 800_000, cacheRead: 0,
      msSinceLastRealRequest: 3_600_000, // 1h since any real request — KA-warmed only
      intervalMs: INTERVAL,
    })).toBe(true)
  })

  test('cold write right after a real request = local prefix-slide → does NOT trip', () => {
    // A recent real request (e.g. a user-authorized [%cache-rewrite-ok%] rewrite)
    // moved the cache_control prefix; the cold write is locally explained.
    expect(isServerSideEviction({
      cacheWrite: 800_000, cacheRead: 0,
      msSinceLastRealRequest: 5_000, // 5s ago — user is actively working
      intervalMs: INTERVAL,
    })).toBe(false)
  })

  test('healthy warm refresh (large read, tiny write) never trips', () => {
    expect(isServerSideEviction({
      cacheWrite: 200, cacheRead: 500_000,
      msSinceLastRealRequest: 3_600_000,
      intervalMs: INTERVAL,
    })).toBe(false)
  })

  test('warm-partial rewrite (read >= 10% of write) is not a cold eviction', () => {
    expect(isServerSideEviction({
      cacheWrite: 500_000, cacheRead: 100_000, // ratio 0.2 > 0.1
      msSinceLastRealRequest: 3_600_000,
      intervalMs: INTERVAL,
    })).toBe(false)
  })

  test('small cold write below threshold is ignored', () => {
    expect(isServerSideEviction({
      cacheWrite: 5_000, cacheRead: 0,
      msSinceLastRealRequest: 3_600_000,
      intervalMs: INTERVAL,
    })).toBe(false)
  })

  test('no lineage history (msSinceLastRealRequest=Infinity) on a cold write trips', () => {
    expect(isServerSideEviction({
      cacheWrite: 800_000, cacheRead: 0,
      msSinceLastRealRequest: Infinity,
      intervalMs: INTERVAL,
    })).toBe(true)
  })
})
