import { describe, test, expect } from 'bun:test'
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
  test('mark sets the flag; clear and complete remove it', () => {
    const { e } = mkEngine()
    const key = arm(e, 'Bearer OLD')
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(true)

    e.clearOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    // a completed real request = user proceeded → flag cleared on re-registration
    e.notifyRealRequestComplete({ inputTokens: 60_000, outputTokens: 5, cacheReadInputTokens: 0 } as any, key)
    expect(e._orgSwitchPending.has(key)).toBe(false)
  })
})
