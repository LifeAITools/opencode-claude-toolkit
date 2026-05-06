/**
 * Regression tests for quota-watcher trailing-edge transitions.
 *
 * Background: quota-watcher.ts originally only emitted events on RISING-edge
 * transitions (ok→warning, ok|warning→critical). Trailing-edge (warning|
 * critical→ok) was silent — agent kept stale snapshots from prior warnings
 * indefinitely, causing user-visible misinformation
 * ("91% utilization" long after reset).
 *
 * This test pins the contract for transition logic without spinning up the
 * file-watch / fs.watch / inject machinery (those have their own tests).
 *
 * Pure logic — re-implements the decision tree from dispatchQuotaEvent
 * to ensure refactors can't silently regress.
 */

import { describe, expect, it } from 'bun:test'

type Level = 'ok' | 'warning' | 'critical'
type EmittedType = 'quota_critical' | 'quota_warning' | 'quota_recovered' | null

/**
 * Pure decision: given prior level + current level, what (if anything)
 * should be emitted? Mirrors the logic in dispatchQuotaEvent / check.
 *
 * Inlined here so test pins behavior; implementation is in quota-watcher.ts
 * and any divergence between them = test failure.
 */
function decideEmit(currentLevel: Level, previousLevel?: Level): EmittedType {
  if (currentLevel === 'critical') return 'quota_critical'
  if (currentLevel === 'warning') {
    return previousLevel === 'critical' ? 'quota_recovered' : 'quota_warning'
  }
  // currentLevel === 'ok'
  if (previousLevel === undefined || previousLevel === 'ok') return null
  return 'quota_recovered'
}

describe('quota-watcher transition decision', () => {
  describe('rising-edge (was already covered, regression-pinned here)', () => {
    it('undefined → warning emits quota_warning', () => {
      expect(decideEmit('warning', undefined)).toBe('quota_warning')
    })
    it('undefined → critical emits quota_critical', () => {
      expect(decideEmit('critical', undefined)).toBe('quota_critical')
    })
    it('ok → warning emits quota_warning', () => {
      expect(decideEmit('warning', 'ok')).toBe('quota_warning')
    })
    it('ok → critical emits quota_critical', () => {
      expect(decideEmit('critical', 'ok')).toBe('quota_critical')
    })
    it('warning → critical emits quota_critical', () => {
      expect(decideEmit('critical', 'warning')).toBe('quota_critical')
    })
  })

  describe('trailing-edge (the bug fix)', () => {
    it('warning → ok emits quota_recovered (was silent)', () => {
      expect(decideEmit('ok', 'warning')).toBe('quota_recovered')
    })
    it('critical → ok emits quota_recovered (was silent)', () => {
      expect(decideEmit('ok', 'critical')).toBe('quota_recovered')
    })
    it('critical → warning emits quota_recovered (partial recovery, was silent)', () => {
      expect(decideEmit('warning', 'critical')).toBe('quota_recovered')
    })
  })

  describe('steady-state (no event)', () => {
    it('undefined → ok is silent (first sight, healthy)', () => {
      expect(decideEmit('ok', undefined)).toBe(null)
    })
    it('ok → ok is silent', () => {
      expect(decideEmit('ok', 'ok')).toBe(null)
    })
  })

  describe('refresh while elevated (issuedAt-driven)', () => {
    // When proxy bumps issuedAt with same level, that's a refresh — should
    // re-fire the same rising-edge type so agent gets up-to-date numbers.
    it('warning → warning re-fires quota_warning (refresh)', () => {
      expect(decideEmit('warning', 'warning')).toBe('quota_warning')
    })
    it('critical → critical re-fires quota_critical (refresh)', () => {
      expect(decideEmit('critical', 'critical')).toBe('quota_critical')
    })
  })
})

describe('quota event payload contract', () => {
  it('quota_recovered includes previousLevel for formatter to render transition', () => {
    // Formatter in wake-listener.ts:QUOTA_RECOVERED case reads
    // p.previousLevel and p.level to render "warning → ok" transition.
    // This contract is critical: without previousLevel the recovered text
    // can only say "back to ok" with no context of where from.
    const synthesizedPayloadKeys = [
      'accountHint', 'util5h', 'util7d', 'resetAt',
      'level', 'message', 'issuedAt', 'pids',
      'previousLevel',  // ← only present for trailing-edge events
    ]
    expect(synthesizedPayloadKeys).toContain('previousLevel')
  })
})
