/**
 * org picture — the COMPLETE organization roster (S1 / D1), including windows
 * CARRIED across a watcher restart.
 *
 * BEFORE: the quota file's `accounts` held only orgs that had just served
 * traffic — `recomputeAccountFromPids` DELETES an account once no pid state
 * remains — so a cold org VANISHED and the layer could see 1 of 4 orgs.
 *
 * AFTER: `composeOrgPicture` joins the account vault (all orgs) with the
 * measured accounts AND the windows carried from the previous snapshot, so an org
 * measured as exhausted a minute ago does not read as "unknown = full remainder"
 * just because the watcher restarted.
 *
 * These tests drive the PURE composer with hand-built maps — no disk.
 */

import { describe, test, expect } from 'bun:test'
import { composeOrgPicture, type VaultOrgEntry, type CarriedWindow } from '../src/quota-watcher.js'

const NOW = Date.UTC(2026, 9, 17, 1, 0, 0)
const ORG_COLD = 'aaaa1111-cold'     // vault only — never measured
const ORG_HOT = 'bbbb2222-hot'       // measured now, healthy
const ORG_FULL = 'cccc3333-full'     // measured now, week at the wall
const ORG_CARRIED = 'eeee5555-carried' // not measured now; windows carried from before
const ORG_DEAD = 'dddd4444-dead'     // vault only, access token expired

function entry(orgId: string, over: Partial<VaultOrgEntry> = {}): VaultOrgEntry {
  return { orgId, expiresAt: NOW + 3_600_000, hasRefreshToken: true, ...over }
}

function acct(over: Record<string, unknown> = {}): any {
  return {
    accountHint: 'x', util5h: 0.1, util7d: 0.2, resetAt: null, reset7dAt: null,
    reset5hAt: null, reset7dAt: null, level: 'ok', message: '', issuedAt: '2026-10-17T00:50:00.000Z', pids: [],
    ...over,
  }
}

function carried(over: Partial<CarriedWindow> = {}): CarriedWindow {
  return {
    util5h: 0.13, util7d: 0.99, reset5hAt: null, reset7dAt: '2026-10-20T22:00:00.000Z',
    level: 'critical', at: '2026-10-17T00:20:00.000Z', ...over,
  }
}

describe('org picture — complete roster, windows carried across restart (S1/D1)', () => {
  test('a COLD org is present with windowsSource=unknown, not absent', () => {
    const vault = [entry(ORG_COLD)]
    const pic = composeOrgPicture(vault, new Map(), new Map(), NOW)
    expect(pic).toHaveLength(1)
    expect(pic[0].windowsSource).toBe('unknown')
    expect(pic[0].util5h).toBeNull()
    expect(pic[0].level).toBeNull()
    expect(pic[0].status).toBe('active') // valid token, windows never measured
  })

  test('measured wins and is stamped measured (with the reading time)', () => {
    const vault = [entry(ORG_HOT), entry(ORG_FULL)]
    const measured = new Map<string, any>([
      [ORG_HOT, acct({ util5h: 0.05, util7d: 0.4, level: 'ok' })],
      [ORG_FULL, acct({ util5h: 0.13, util7d: 0.99, level: 'critical' })],
    ])
    const pic = composeOrgPicture(vault, measured, new Map(), NOW)
    const hot = pic.find(o => o.orgId === ORG_HOT)!
    expect(hot.windowsSource).toBe('measured')
    expect(hot.windowsAt).toBe('2026-10-17T00:50:00.000Z')
    expect(hot.util7d).toBe(0.4)
    expect(pic.find(o => o.orgId === ORG_FULL)!.status).toBe('exhausted')
  })

  test('CARRIED windows keep an exhausted org exhausted — not "unknown/full remainder"', () => {
    const vault = [entry(ORG_CARRIED)]
    const cw = new Map<string, CarriedWindow>([[ORG_CARRIED, carried()]])
    const pic = composeOrgPicture(vault, new Map(), cw, NOW)
    expect(pic[0].windowsSource).toBe('carried')
    expect(pic[0].status).toBe('exhausted')
    expect(pic[0].util7d).toBe(0.99)
    // The reading time is carried AS IS — the consumer must see it is old.
    expect(pic[0].windowsAt).toBe('2026-10-17T00:20:00.000Z')
  })

  test('a carried reading whose WEEK window rolled over is dropped (unknown)', () => {
    const vault = [entry(ORG_CARRIED)]
    const cw = new Map<string, CarriedWindow>([
      [ORG_CARRIED, carried({ reset7dAt: '2026-10-16T00:00:00.000Z' })],
    ])
    const pic = composeOrgPicture(vault, new Map(), cw, NOW)
    expect(pic[0].windowsSource).toBe('unknown')
    expect(pic[0].util7d).toBeNull()
  })

  test('a carried reading whose 5h window rolled over zeroes util5h but keeps the week', () => {
    const vault = [entry(ORG_CARRIED)]
    const cw = new Map<string, CarriedWindow>([
      [ORG_CARRIED, carried({ reset5hAt: '2026-10-16T12:00:00.000Z' })],
    ])
    const pic = composeOrgPicture(vault, new Map(), cw, NOW)
    expect(pic[0].windowsSource).toBe('carried')
    expect(pic[0].util5h).toBe(0)
    expect(pic[0].util7d).toBe(0.99)
  })

  test('a live measurement outranks a carried reading', () => {
    const vault = [entry(ORG_CARRIED)]
    const measured = new Map<string, any>([[ORG_CARRIED, acct({ util5h: 0.02, util7d: 0.3, level: 'ok' })]])
    const cw = new Map<string, CarriedWindow>([[ORG_CARRIED, carried()]])
    const pic = composeOrgPicture(vault, measured, cw, NOW)
    expect(pic[0].windowsSource).toBe('measured')
    expect(pic[0].status).toBe('active')
    expect(pic[0].util7d).toBe(0.3)
  })

  test('a carried entry with NO windows is NOT "carried" — it is unknown', () => {
    // Живой прогон 17.10: снимок без `windowsSource` насеял такие записи, и весь
    // ростер читался как `carried` с пустыми окнами — ложь о происхождении.
    const vault = [entry(ORG_CARRIED)]
    const cw = new Map<string, CarriedWindow>([
      [ORG_CARRIED, { util5h: null, util7d: null, reset5hAt: null, reset7dAt: null, level: null, at: null }],
    ])
    const pic = composeOrgPicture(vault, new Map(), cw, NOW)
    expect(pic[0].windowsSource).toBe('unknown')
  })

  test('token expiry outranks an exhausted window in status', () => {
    const vault = [entry(ORG_DEAD, { expiresAt: NOW - 1 })]
    const cw = new Map<string, CarriedWindow>([[ORG_DEAD, carried()]])
    expect(composeOrgPicture(vault, new Map(), cw, NOW)[0].status).toBe('token_expired')
  })

  test('carries the human account name from the vault', () => {
    const vault = [entry(ORG_COLD, { email: 'a@b.c', orgName: "a@b.c's Organization" })]
    const pic = composeOrgPicture(vault, new Map(), new Map(), NOW)
    expect(pic[0].accountEmail).toBe('a@b.c')
    expect(pic[0].orgName).toBe("a@b.c's Organization")
  })

  test('no vault entries → empty picture (never invents orgs)', () => {
    expect(composeOrgPicture([], new Map(), new Map(), NOW)).toEqual([])
  })
})
