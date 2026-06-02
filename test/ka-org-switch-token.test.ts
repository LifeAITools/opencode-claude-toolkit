import { describe, test, expect, setSystemTime } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = (ttl = '1h') => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
})

function mkEngine() {
  const captured: { headers: Record<string, string> }[] = []
  const e = new KeepaliveEngine({
    getToken: async () => 'NEW-token',
    doFetch: async function* (_body, headers): AsyncGenerator<StreamEvent> {
      captured.push({ headers })
      yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
    },
    getRateLimitInfo: (): RateLimitInfo => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
  })
  return { e, captured }
}

function arm(e: KeepaliveEngine, auth: string): string {
  const key = e.notifyRealRequestStart('claude-opus-4-7', sys(), { Authorization: auth })
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  return key
}

describe('KeepaliveEngine — org-switch-pending lifecycle', () => {
  test('mark sets the flag; only clearOrgSwitchPending removes it (complete does NOT)', () => {
    const { e } = mkEngine()
    const key = arm(e, 'Bearer OLD')
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(true)

    e.clearOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    // Per-session pin model: a real request can COMPLETE while the session is
    // still HOLDING the old org, so completion must NOT clear the flag — the pin
    // owner (ProxyClient) clears it explicitly on rebind / same-org.
    e.notifyRealRequestComplete({ inputTokens: 60_000, outputTokens: 5, cacheReadInputTokens: 0 } as any, key)
    expect(e._orgSwitchPending.has(key)).toBe(true)    // still held — completion does not clear
    e.clearOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(false)   // cleared explicitly
  })

  test('pending lineage → KA fire replays the snapshot OLD token (not getToken)', async () => {
    const t0 = Date.now()
    setSystemTime(t0)
    const { e, captured } = mkEngine()
    const key = arm(e, 'Bearer OLD')
    e.markOrgSwitchPending(key)
    setSystemTime(t0 + 120_000)   // past the 60s fire interval, within 5m TTL → fires
    await e._tick()
    setSystemTime()               // reset
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.at(-1)!.headers.Authorization).toBe('Bearer OLD')  // old token, NOT NEW-token
  })

  test('non-pending lineage → KA fire uses fresh getToken (current behavior)', async () => {
    const t0 = Date.now()
    setSystemTime(t0)
    const { e, captured } = mkEngine()
    arm(e, 'Bearer OLD')
    setSystemTime(t0 + 120_000)
    await e._tick()
    setSystemTime()
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.at(-1)!.headers.Authorization).toBe('Bearer NEW-token')
  })
})
