/**
 * A keepalive fire must name the account that served it.
 *
 * Measured over 2026-08-13..20: keepalive paid again for 91 prefixes it had
 * previously read back, 38.6M tokens, and 73% of that fell inside the half hour
 * after a proxy restart — 21.8% of fires pay in the first ten minutes against
 * 0.12% after three hours. The obvious suspect is that a restart re-serves a
 * session from the OTHER account of the pool, whose cache is worth nothing to
 * it.
 *
 * That suspicion could not be tested: 88 of those 91 fires carried no account
 * at all, because the event read only the per-session pin and most sessions
 * have none. The served account was knowable the whole time — the auth path
 * resolves it on every 401 — so the fire now reports the same thing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ProxyClient } from '../src/proxy-client.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ka-org-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

function mkClient(currentOrg: string | null) {
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 3600 },
    credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response('') },
    eventEmitter: { emit: () => {} },
    livenessChecker: { isAlive: () => true },
    orgIdResolver: { current: () => currentOrg },
    kaSnapshotPath: join(dir, 'snap.json'),
    prefixHistoryPath: join(dir, 'ph.json'),
    proxyStartedAt: 0,
  } as any)
  return c
}

describe('who served the fire', () => {
  test('an unpinned session still names the account currently serving it', () => {
    // This is the case that was blank 88 times out of 91.
    const c = mkClient('acct-current')
    expect((c as any).resolveServedOrg('no-pin-session')).toBe('acct-current')
    ;(c as any).stop?.()
  })

  test('a pinned session names its pin, not the pool default', () => {
    const c = mkClient('acct-current')
    ;(c as any).sessionPins.set('pinned', { orgId: 'acct-pinned' })
    expect((c as any).resolveServedOrg('pinned')).toBe('acct-pinned')
    ;(c as any).stop?.()
  })

  test('with nothing to resolve it is honestly null, not a guess', () => {
    const c = mkClient(null)
    expect((c as any).resolveServedOrg('nobody')).toBeNull()
    ;(c as any).stop?.()
  })

  test('the fire events read the resolver, not the narrower pin map', async () => {
    // Asserted on the SOURCE: the value only appears in a live fire, and a test
    // that mocks its way to the event would prove its own mock. Three earlier
    // guard tests today passed for exactly that reason.
    const src = await Bun.file(new URL('../src/proxy-client.ts', import.meta.url)).text()
    const kaBlock = src.slice(src.indexOf("kind: 'KA_FIRE_START'"), src.indexOf("kind: 'KA_DISARM'"))
    expect(kaBlock).toContain('org: this.resolveServedOrg(sessionId)')
    expect(kaBlock).not.toContain('org: this.sessionPins.get(sessionId)?.orgId ?? null')
  })
})
