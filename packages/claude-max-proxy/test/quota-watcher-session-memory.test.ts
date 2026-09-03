/**
 * The session→account map has to survive a restart and an idle agent.
 *
 * 🔴 WHY, MEASURED 2026-09-03 BY THE CONSUMER, not by us. The founder asked the
 * wake-router not to wake an agent whose 5h window is over 95% spent. It can
 * only judge a session whose account it can resolve — and its owner measured
 * 2 of 6 live sessions resolvable at 13:14 that day, against 24 of 30 two hours
 * earlier. The drop was not decay: the proxy had been redeployed in between.
 *
 * Two separate holes produced that number, and both are pinned here.
 *
 *   1. A restart emptied the map. Reset expectations were carried forward from
 *      the previous snapshot; the session bindings beside them were not.
 *   2. What survived was then aged out on the PID clock — 30 minutes of
 *      silence — which is exactly the profile of the sleeping agent the whole
 *      rule exists to protect.
 *
 * Carrying a session binding forward is safe because it does not decay: a
 * session holds its account for its whole life and only a human's explicit
 * reload moves it (project rail `no-live-account-migration`).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { __testing } from '../src/quota-watcher.js'

const ORG = 'f9420373-0aff-4114-abd1-98e5b26bf0e8'
const HOUR = 60 * 60_000

beforeEach(() => __testing.reset())

describe('a session binding survives what the pid state must not', () => {
  test('a restart carries the map forward instead of starting blank', () => {
    __testing.seedFromPreviousSnapshot({
      version: 1,
      updatedAt: new Date().toISOString(),
      accounts: {},
      pids: {},
      sessions: { 'sleepy-agent': { org: ORG, lastSeenAt: Date.now() - 3 * HOUR } },
    } as never)
    expect(__testing.snapshot().sessions?.['sleepy-agent']?.org).toBe(ORG)
  })

  test('the carried entry keeps its ORIGINAL lastSeenAt — an old reading stays legible as old', () => {
    const seenAt = Date.now() - 5 * HOUR
    __testing.seedFromPreviousSnapshot({
      version: 1, updatedAt: new Date().toISOString(), accounts: {}, pids: {},
      sessions: { 's1': { org: ORG, lastSeenAt: seenAt } },
    } as never)
    // Stamping it to now would tell the consumer this session was heard from
    // seconds ago, which is the one thing it must not believe.
    expect(__testing.snapshot().sessions?.['s1']?.lastSeenAt).toBe(seenAt)
  })

  // 🔴 A POSITIVE CONTROL FOR THE TEST BELOW. `pruneStaleStates` takes `now` as
  // an argument; calling it bare makes every comparison NaN, so nothing is ever
  // deleted and "the entry survived" passes for a reason that has nothing to do
  // with the rule. That is exactly how the first draft of this file passed.
  test('the pruner can in fact delete — otherwise "it survived" proves nothing', () => {
    __testing.seedFromPreviousSnapshot({
      version: 1, updatedAt: new Date().toISOString(), accounts: {}, pids: {},
      sessions: { 'very-old': { org: ORG, lastSeenAt: Date.now() - 100 * HOUR } },
    } as never)
    __testing.pruneStaleStates(Date.now())
    expect(__testing.snapshot().sessions?.['very-old']).toBeUndefined()
  })

  test('a session idle for two hours is still resolvable — the pid clock no longer applies', () => {
    __testing.seedFromPreviousSnapshot({
      version: 1, updatedAt: new Date().toISOString(), accounts: {}, pids: {},
      sessions: { 'idle-2h': { org: ORG, lastSeenAt: Date.now() - 2 * HOUR } },
    } as never)
    __testing.pruneStaleStates(Date.now())
    expect(__testing.snapshot().sessions?.['idle-2h']?.org).toBe(ORG)
  })

  test('but it is not remembered forever — past 12h it is forgotten', () => {
    __testing.seedFromPreviousSnapshot({
      version: 1, updatedAt: new Date().toISOString(), accounts: {}, pids: {},
      sessions: { 'ancient': { org: ORG, lastSeenAt: Date.now() - 13 * HOUR } },
    } as never)
    __testing.pruneStaleStates(Date.now())
    expect(__testing.snapshot().sessions?.['ancient']).toBeUndefined()
  })

  test('a malformed entry is skipped, not carried as a half-fact', () => {
    __testing.seedFromPreviousSnapshot({
      version: 1, updatedAt: new Date().toISOString(), accounts: {}, pids: {},
      sessions: {
        'good': { org: ORG, lastSeenAt: Date.now() },
        'no-org': { lastSeenAt: Date.now() },
        'no-time': { org: ORG },
      },
    } as never)
    const s = __testing.snapshot().sessions ?? {}
    expect(s['good']).toBeTruthy()
    expect(s['no-org']).toBeUndefined()
    expect(s['no-time']).toBeUndefined()
  })
})
