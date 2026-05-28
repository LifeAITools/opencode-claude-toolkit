/**
 * KA self-heal: a live, idle session must keep its cache warm even after its
 * snapshot was dropped (reload / restart-no-revive) — without waiting for a new
 * real request. Root cause it fixes: engine.reload() clears the registry and
 * only re-arms on the next real request, so a main agent idle while sub-agents
 * work on other lineages silently goes cold (observed: session 60ac386e, idle
 * 7813s, 0 KA fires, avoidable:ttl-expiry block).
 *
 * Fixture (bunfig preload): 5m TTL, 60s interval.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = (ttl?: string) => ({
  system: [{ type: 'text', text: 'sys', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }],
})

function mkEngine(opts: { onTick?: () => void; ownerAlive?: () => boolean } = {}) {
  let fires = 0
  const e = new KeepaliveEngine({
    config: { onTick: opts.onTick },
    getToken: async () => 'fake-token',
    doFetch: async function* (): AsyncGenerator<StreamEvent> {
      fires++
      yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
    },
    getRateLimitInfo: (): RateLimitInfo => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
    isOwnerAlive: opts.ownerAlive,
  })
  return { e, fires: () => fires }
}

function arm(e: KeepaliveEngine): string {
  const key = e.notifyRealRequestStart('claude-opus-4-7', sys('1h'), {})
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  return key
}

describe('KA self-heal after snapshot drop', () => {
  test('reload then tick → re-primes registry (does NOT stay empty)', async () => {
    const { e } = mkEngine()
    arm(e)
    expect(e._registry.size).toBeGreaterThan(0)

    e.reload('cli_reload')
    expect(e._registry.size).toBe(0) // reload drops the snapshot

    await e._tick()
    expect(e._registry.size).toBeGreaterThan(0) // SELF-HEALED: re-primed from last snapshot
  })

  test('does NOT self-heal when owner PID is dead', async () => {
    const { e } = mkEngine({ ownerAlive: () => false })
    arm(e)
    e.reload('cli_reload')
    await e._tick()
    expect(e._registry.size).toBe(0) // owner dead → stay disarmed
  })

  test('does NOT self-heal when cache is beyond TTL', async () => {
    const { e } = mkEngine()
    arm(e)
    e.reload('cli_reload')
    e._setCacheWrittenAt(Date.now() - 3 * 3600 * 1000) // 3h ago, way past 5m fixture TTL
    await e._tick()
    expect(e._registry.size).toBe(0) // cache dead → don't re-prime a corpse
  })

  test('does NOT self-heal after a terminal disarm (cache expired during sleep)', async () => {
    const { e } = mkEngine()
    arm(e)
    // simulate the wake-from-sleep terminal disarm by aging the cache then ticking;
    // afterwards a normal tick must not resurrect it.
    e._setCacheWrittenAt(Date.now() - 3 * 3600 * 1000)
    await e._tick() // this tick disarms (cache_expired_during_sleep), marks non-eligible
    e._setCacheWrittenAt(Date.now()) // even if cache looks fresh again
    await e._tick()
    expect(e._registry.size).toBe(0) // terminal disarm is not self-heal-eligible
  })
})
