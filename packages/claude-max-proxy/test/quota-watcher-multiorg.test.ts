/**
 * quota-watcher — multi-org account isolation (single shared proxy pid).
 *
 * The stats-emitter stamps EVERY line with the one proxy process pid
 * (`pid: PROXY_PID`), regardless of which org served the request. The processor
 * keyed `pidStates` by that bare pid, so two concurrently-served orgs collapsed
 * onto ONE oscillating account: recomputeAccountFromPids found zero pids for the
 * just-left org and deleted it, leaving `accounts` with a single org at a time.
 *
 * The reader (signal-wire hook) resolves session→org correctly but then looks
 * the org up in `accounts`; with only one org present it fell through to that
 * org's number — so a session on a HEALTHY org saw an EXHAUSTED org's util and
 * vice-versa (false cross-org quota display feeding both the badge AND the
 * agent's quota gate; observed live 2026-06-24: a b3219c9b session at real 7d=57%
 * shown f9420373's 7d=99%, a held f9420373 session shown b3219c9b's 57%).
 *
 * Fix: key pidStates by `${pid}::${org}` so each live org is its own virtual
 * client and `accounts` holds one independent AccountState per org.
 *
 * These tests drive the pure processor surface and FAIL on the pre-fix code
 * (accounts would contain a single org).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { __testing } from '../src/quota-watcher.js'

const PROXY_PID = 2570116 // single shared proxy process pid (the bug's premise)
const ORG_A = 'f9420373-0aff-4114-abd1-98e5b26bf0e8' // exhausted
const ORG_B = 'b3219c9b-0b6e-4e9e-8f7e-ca606d3d03c9' // healthy

function statsLine(
  org: string,
  ses: string,
  util5h: number,
  util7d: number,
  tsMs: number,
) {
  return {
    v: 1,
    ts: new Date(tsMs).toISOString(),
    pid: PROXY_PID,
    type: 'stream',
    org,
    ses,
    rateLimit: { status: 'allowed', util5h, util7d },
  }
}

describe('quota-watcher — multi-org account isolation', () => {
  beforeEach(() => __testing.reset())

  test('two orgs through ONE proxy pid keep independent accounts', () => {
    const t = Date.now()
    // Interleave exactly the way concurrent sessions hit the proxy.
    __testing.ingestStatsLine(statsLine(ORG_A, 'sesA', 0.02, 0.99, t))
    __testing.ingestStatsLine(statsLine(ORG_B, 'sesB', 0.05, 0.57, t + 1))
    __testing.ingestStatsLine(statsLine(ORG_A, 'sesA', 0.02, 0.99, t + 2))
    __testing.ingestStatsLine(statsLine(ORG_B, 'sesB', 0.05, 0.57, t + 3))

    const snap = __testing.snapshot()
    // Pre-fix: exactly ONE key here (the last-served org). Fix: BOTH present.
    expect(Object.keys(snap.accounts).sort()).toEqual([ORG_B, ORG_A].sort())
    // Each account carries ITS OWN util — no cross-contamination.
    expect(snap.accounts[ORG_A].util7d).toBe(0.99)
    expect(snap.accounts[ORG_A].util5h).toBe(0.02)
    expect(snap.accounts[ORG_B].util7d).toBe(0.57)
    expect(snap.accounts[ORG_B].util5h).toBe(0.05)
  })

  test('a session on the healthy org never resolves to the exhausted number', () => {
    const t = Date.now()
    __testing.ingestStatsLine(statsLine(ORG_A, 'sesA', 0.02, 0.99, t))
    __testing.ingestStatsLine(statsLine(ORG_B, 'sesB', 0.05, 0.57, t + 1))
    // ORG_A served most-recently — the pre-fix collapse left only ORG_A.

    const snap = __testing.snapshot()
    // The reader path: session → org → accounts[org]. sesB must see ORG_B's 57%.
    const sesBOrg = snap.sessions![ 'sesB' ].org
    expect(sesBOrg).toBe(ORG_B)
    expect(snap.accounts[sesBOrg].util7d).toBe(0.57)

    // Symmetric: the exhausted-org session must still see 99% (no false-OK).
    const sesAOrg = snap.sessions!['sesA'].org
    expect(sesAOrg).toBe(ORG_A)
    expect(snap.accounts[sesAOrg].util7d).toBe(0.99)
  })

  test('account.pids reference real snapshot pid keys (reader freshness lookup)', () => {
    const t = Date.now()
    __testing.ingestStatsLine(statsLine(ORG_A, 'sesA', 0.02, 0.99, t))
    __testing.ingestStatsLine(statsLine(ORG_B, 'sesB', 0.05, 0.57, t + 1))

    const snap = __testing.snapshot()
    // Every pid key listed on an account must exist in the snapshot.pids map —
    // the hook indexes pids[key].lastSeenAt to gate per-account staleness.
    for (const acct of Object.values(snap.accounts)) {
      for (const pidKey of acct.pids) {
        expect(snap.pids[pidKey]).toBeDefined()
        expect(snap.pids[pidKey].lastSeenAt).toBeGreaterThan(0)
      }
    }
    // Composite keying: distinct entry per org under the shared proxy pid.
    expect(snap.pids[`${PROXY_PID}::${ORG_A}`]).toBeDefined()
    expect(snap.pids[`${PROXY_PID}::${ORG_B}`]).toBeDefined()
  })

  test('legacy lines with no org field keep bare-pid keying (back-compat)', () => {
    const t = Date.now()
    // No `org` → trajectory-inferred accountHint, bare-pid key.
    __testing.ingestStatsLine({
      v: 1, ts: new Date(t).toISOString(), pid: PROXY_PID, type: 'stream',
      ses: 'sesLegacy', rateLimit: { status: 'allowed', util5h: 0.4, util7d: 0.5 },
    })
    const snap = __testing.snapshot()
    expect(Object.keys(snap.accounts).length).toBe(1)
    const onlyAcct = Object.values(snap.accounts)[0]
    // bare-pid key (no '::' composite)
    expect(onlyAcct.pids[0]).toBe(String(PROXY_PID))
    expect(onlyAcct.util7d).toBe(0.5)
  })
})
