/**
 * quota-watcher — 5h level thresholds (founder policy 2026-08-16, topic 4286).
 *
 * Agents given the critical signal at 98% could not finish their current step
 * in the remaining 2% and ran into 100% + a 429 storm. The critical wall moved
 * 0.98 → 0.90 (10% headroom buys a lossless wrap-up); the early warning stays
 * at 0.85. Mirrors the engine-side stop wall (signal-wire quota-critical-5h,
 * also 0.90).
 *
 * Both poles per boundary, driven through the real ingest path — a green test
 * on a fixture the processor never produces proves nothing.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { __testing } from '../src/quota-watcher.js'

const PROXY_PID = 2570116
const ORG = 'f9420373-0aff-4114-abd1-98e5b26bf0e8'

function statsLine(util5h: number, tsMs: number) {
  return {
    v: 1,
    ts: new Date(tsMs).toISOString(),
    pid: PROXY_PID,
    type: 'stream',
    org: ORG,
    ses: 'ses1',
    rateLimit: { status: 'allowed', util5h, util7d: 0.1 },
  }
}

function levelAt(util5h: number): string {
  __testing.reset()
  __testing.ingestStatsLine(statsLine(util5h, Date.now()))
  return __testing.snapshot().accounts[ORG].level
}

describe('quota-watcher — 5h level thresholds', () => {
  beforeEach(() => __testing.reset())

  test('critical wall is 0.90: warning just below, critical at and above', () => {
    expect(levelAt(0.89)).toBe('warning')
    expect(levelAt(0.9)).toBe('critical')
    expect(levelAt(0.91)).toBe('critical')
  })

  test('early warning stays at 0.85: ok just below, warning at and above', () => {
    expect(levelAt(0.84)).toBe('ok')
    expect(levelAt(0.85)).toBe('warning')
    expect(levelAt(0.86)).toBe('warning')
  })
})
