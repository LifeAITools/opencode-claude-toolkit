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

  // M3 (per-org-token-rotation): a HELD cross-org session's KA fire must carry
  // the token that `getToken()` resolves — in the proxy that closure resolves
  // the session's SERVED (held) org and routes through withFreshOrgToken, so it
  // returns the held org's REFRESHED vault token, not the active account's. At
  // the engine level this reduces to: a non-pending fire uses whatever the
  // (served-org-aware) getToken returns, even after the held token rotated.
  test('M3: held-session (non-pending) KA fire carries the getToken()-resolved refreshed held-org token', async () => {
    const t0 = Date.now()
    setSystemTime(t0)
    let heldOrgToken = 'HELD-old'
    const captured: { headers: Record<string, string> }[] = []
    const e = new KeepaliveEngine({
      getToken: async () => heldOrgToken,   // proxy's served-org resolver
      doFetch: async function* (_body, headers): AsyncGenerator<StreamEvent> {
        captured.push({ headers })
        yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
      },
      getRateLimitInfo: (): RateLimitInfo => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
    })
    arm(e, 'Bearer HELD-old')
    heldOrgToken = 'HELD-refreshed'          // proxy refreshed the held org's vault token
    setSystemTime(t0 + 120_000)
    await e._tick()
    setSystemTime()
    expect(captured.at(-1)!.headers.Authorization).toBe('Bearer HELD-refreshed')  // NOT the stale held token, NOT the active account
  })

  // H3 (force-on-401): on a KA auth error the engine invokes onAuthError with
  // the exact token that was rejected (mirror CC's handleOAuth401Error), BEFORE
  // the retry chain rebuilds Authorization from a fresh getToken().
  test('H3: onAuthError backstop fires with the rejected token on a 401', async () => {
    const t0 = Date.now()
    setSystemTime(t0)
    const seen: string[] = []
    const e = new KeepaliveEngine({
      getToken: async () => 'TOK',
      onAuthError: async (failed: string) => { seen.push(failed) },
      doFetch: async function* (): AsyncGenerator<StreamEvent> {
        const err = new Error('OAuth access token has expired') as Error & { status?: number }
        err.status = 401
        throw err
        // eslint-disable-next-line no-unreachable
        yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' }
      },
      getRateLimitInfo: (): RateLimitInfo => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
    })
    arm(e, 'Bearer TOK')
    setSystemTime(t0 + 120_000)
    await e._tick()
    setSystemTime()
    e.stop()   // clear the scheduled auth-retry timer
    expect(seen).toContain('TOK')   // backstop received the rejected token
  })
})
