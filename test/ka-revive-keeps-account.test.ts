/**
 * A revived session must be warmed on the account its cache belongs to.
 *
 * Anthropic caches per account, so a prefix bought under one account is worth
 * nothing to the other. The binding used to be restored only on the session's
 * next REAL request — and the sessions keepalive exists for are exactly the
 * ones that send none. So after every restart a revived warm-up fired against
 * whatever account happened to be active and bought the whole prefix again.
 *
 * Measured 2026-08-13..20 across the fleet: 21.8% of fires in the first ten
 * minutes after a restart paid a full rewrite, against 0.12% three hours later
 * — roughly a million tokens per restart, 27 restarts in that week. The founder
 * named this cause from the outside before the code was opened.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ProxyClient } from '../src/proxy-client.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ka-revive-org-')) })
afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

function mkClient(currentOrg: string) {
  return new ProxyClient({
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
}

describe('re-binding a revived session', () => {
  test('a session whose cache belongs to the OTHER account is re-bound to it', () => {
    const c: any = mkClient('acct-active')
    c.orgVault.upsert?.({ orgId: 'acct-owner', accessToken: 'tok-owner', expiresAt: Date.now() + 3_600_000 })
    c.restorePinForRevivedSession('sess-1', 'acct-owner')
    expect(c.sessionPins.get('sess-1')?.orgId).toBe('acct-owner')
    c.stop?.()
  })

  test('a session already on the active account is left alone', () => {
    const c: any = mkClient('acct-active')
    c.restorePinForRevivedSession('sess-2', 'acct-active')
    expect(c.sessionPins.has('sess-2')).toBe(false)   // no needless binding
    c.stop?.()
  })

  test('a snapshot with no account recorded changes nothing', () => {
    // Older snapshot files carry no account at all — they must not be guessed at.
    const c: any = mkClient('acct-active')
    c.restorePinForRevivedSession('sess-3', null)
    expect(c.sessionPins.has('sess-3')).toBe(false)
    c.stop?.()
  })

  test('an expired vault entry is refused AND announced — silence would look like success', () => {
    // Founder, 2026-08-20: several accounts are in use and get switched during
    // the day, and a restart must not send everything to the wrong one. If the
    // account that owns this cache cannot be spoken for, warming on whatever is
    // active is not a partial success — it is a guaranteed full-price purchase
    // of a prefix the session will never read, repeated every interval.
    const c: any = mkClient('acct-active')
    c.orgVault.upsert?.({ orgId: 'acct-old', accessToken: 'stale', expiresAt: Date.now() - 1000 })
    expect(c.restorePinForRevivedSession('sess-4', 'acct-old')).toBe('account-unavailable')
    expect(c.sessionPins.has('sess-4')).toBe(false)
    c.stop?.()
  })

  test('an account with no vault entry at all is refused the same way', () => {
    const c: any = mkClient('acct-active')
    expect(c.restorePinForRevivedSession('sess-5', 'acct-never-seen')).toBe('account-unavailable')
    c.stop?.()
  })

  test('the three harmless cases report ok, so nothing is dropped for nothing', () => {
    const c: any = mkClient('acct-active')
    expect(c.restorePinForRevivedSession('s-a', null)).toBe('ok')            // old snapshot
    expect(c.restorePinForRevivedSession('s-b', 'acct-active')).toBe('ok')   // already right
    c.sessionPins.set('s-c', { orgId: 'acct-live' })
    expect(c.restorePinForRevivedSession('s-c', 'acct-other')).toBe('ok')    // live binding wins
    c.stop?.()
  })

  test('the registry records WHOSE cache each snapshot is', async () => {
    // The founder asked for this by name: the file must say which session and
    // which account. Asserted on the source that writes the record.
    const src = await Bun.file(new URL('../src/proxy-client.ts', import.meta.url)).text()
    const block = src.slice(src.indexOf('private collectKaSnapshots'), src.indexOf('private collectKaSnapshots') + 900)
    expect(block).toContain('orgId: this.resolveServedOrg(s.sessionId)')
  })

  test('and the revive path actually CALLS the re-binding', async () => {
    // The tests above drive the method directly, so none of them would notice
    // the call being dropped from revive — the wiring needs its own assertion.
    const src = await Bun.file(new URL('../src/proxy-client.ts', import.meta.url)).text()
    const block = src.slice(src.indexOf('private reviveKaSnapshots'), src.indexOf('private restorePinForRevivedSession'))
    expect(block).toContain("this.restorePinForRevivedSession(sid, ps.orgId) === 'account-unavailable'")
    // and it must DROP rather than revive-anyway — the whole point of the verdict
    expect(block).toContain("this.recordReviveDrop(sid, ps, 'account-unavailable')")
  })
})
