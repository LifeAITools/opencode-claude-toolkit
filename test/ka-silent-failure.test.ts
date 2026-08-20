/**
 * A failure that looks exactly like a healthy quiet.
 *
 * Twice on 2026-08-19 the same shape cost a working day: a keepalive fire that
 * recorded only its successes made "the warm-up never ran" indistinguishable
 * from "the warm-up was fine", and a fleet-wide disarm that no one announced
 * looked like twenty-six healthy engines. These are the two remaining places in
 * the warm-cache path where a real failure produced the same nothing as
 * success — and both are load-bearing.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { saveKaSnapshots } from '../src/ka-snapshot-store.js'
import { mkdtempSync, rmSync, chmodSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ka-snap-')) })
afterEach(() => { try { chmodSync(dir, 0o700); rmSync(dir, { recursive: true, force: true }) } catch {} })

describe('persisting the snapshot registry', () => {
  test('a written file reports success', () => {
    const r = saveKaSnapshots({}, join(dir, 'snap.json'))
    expect(r.ok).toBe(true)
    expect(existsSync(join(dir, 'snap.json'))).toBe(true)
  })

  test('a file it CANNOT write reports the failure instead of returning nothing', () => {
    // Every session revives from this file. An unwritten one costs the whole
    // fleet its warmth at the next restart, and until now that cost arrived
    // with no warning of any kind.
    const r = saveKaSnapshots({}, join(dir, 'no-such-dir', 'snap.json'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.length).toBeGreaterThan(0)
  })

  test('it still never throws — the request path must not break for a log file', () => {
    expect(() => saveKaSnapshots({}, '/proc/definitely/not/writable/snap.json')).not.toThrow()
  })
})
