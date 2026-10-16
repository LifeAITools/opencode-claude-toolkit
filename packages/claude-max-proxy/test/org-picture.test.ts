/**
 * org picture — the COMPLETE organization roster (S1 / D1).
 *
 * BEFORE: the quota file's `accounts` held only orgs that had just served
 * traffic — `recomputeAccountFromPids` DELETES an account once no pid state
 * remains, so a cold org VANISHED and the layer could see 1 of 4 orgs.
 *
 * AFTER: `composeOrgPicture` joins the account vault (all orgs) with the
 * measured accounts, so EVERY org is present — a cold one with
 * `windowsKnown:false` instead of absent.
 *
 * These tests drive the PURE composer with a hand-built vault and a hand-built
 * measured map, so they assert the roster rule, not this machine's files.
 */

import { describe, test, expect } from 'bun:test'
import { composeOrgPicture, type VaultOrgEntry } from '../src/quota-watcher.js'

const NOW = 1_700_000_000_000
const ORG_COLD = 'aaaa1111-cold'   // vault only — never served traffic
const ORG_HOT = 'bbbb2222-hot'     // served, healthy
const ORG_FULL = 'cccc3333-full'   // served, week at the wall
const ORG_DEAD = 'dddd4444-dead'   // vault only, access token expired

function entry(orgId: string, over: Partial<VaultOrgEntry> = {}): VaultOrgEntry {
  return { orgId, expiresAt: NOW + 3_600_000, hasRefreshToken: true, ...over }
}

function acct(over: Record<string, unknown> = {}): any {
  return {
    accountHint: 'x', util5h: 0.1, util7d: 0.2, resetAt: null, reset7dAt: null,
    reset5hAt: null, reset7dAt: null, level: 'ok', message: '', issuedAt: '', pids: [],
    ...over,
  }
}

describe('org picture — complete roster (S1/D1)', () => {
  test('a COLD org (no traffic) is present, not absent', () => {
    const vault = [entry(ORG_COLD), entry(ORG_HOT), entry(ORG_FULL), entry(ORG_DEAD, { expiresAt: NOW - 1 })]
    const measured = new Map<string, any>([
      [ORG_HOT, acct({ util5h: 0.05, util7d: 0.4, level: 'ok' })],
      [ORG_FULL, acct({ util5h: 0.13, util7d: 0.99, level: 'critical' })],
    ])

    const pic = composeOrgPicture(vault, measured, NOW)

    // The whole point: ALL FOUR, where `accounts` held only the two with traffic.
    expect(pic.map((o) => o.orgId).sort()).toEqual(
      [ORG_COLD, ORG_HOT, ORG_FULL, ORG_DEAD].sort(),
    )

    const cold = pic.find((o) => o.orgId === ORG_COLD)!
    expect(cold.windowsKnown).toBe(false)
    expect(cold.util5h).toBeNull()
    expect(cold.util7d).toBeNull()
    expect(cold.level).toBeNull()
    // Valid token + unknown windows = usable, treated as full remainder downstream.
    expect(cold.status).toBe('active')

    const hot = pic.find((o) => o.orgId === ORG_HOT)!
    expect(hot.windowsKnown).toBe(true)
    expect(hot.util7d).toBe(0.4)
    expect(hot.status).toBe('active')

    const full = pic.find((o) => o.orgId === ORG_FULL)!
    expect(full.status).toBe('exhausted')
    expect(full.level).toBe('critical')

    const dead = pic.find((o) => o.orgId === ORG_DEAD)!
    expect(dead.status).toBe('token_expired')
  })

  test('token expiry outranks an exhausted window in status', () => {
    const vault = [entry(ORG_DEAD, { expiresAt: NOW - 1 })]
    const measured = new Map<string, any>([[ORG_DEAD, acct({ level: 'critical', util7d: 1 })]])
    expect(composeOrgPicture(vault, measured, NOW)[0].status).toBe('token_expired')
  })

  test('carries the human account name from the vault (not just the org number)', () => {
    const vault = [entry(ORG_COLD, { email: 'a@b.c', orgName: "a@b.c's Organization" })]
    const pic = composeOrgPicture(vault, new Map(), NOW)
    expect(pic[0].accountEmail).toBe('a@b.c')
    expect(pic[0].orgName).toBe("a@b.c's Organization")
  })

  test('no vault entries → empty picture (never invents orgs)', () => {
    expect(composeOrgPicture([], new Map(), NOW)).toEqual([])
  })
})
