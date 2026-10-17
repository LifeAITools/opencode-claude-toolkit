/**
 * Hint budget — the adapter must take it from the RULE SET, not hold its own.
 *
 * The engine stamps every result with `maxChars` (from
 * `RuleSet._meta.hint_max_chars`, core ≥ fad7b41). The adapter held 4000 while
 * the core held 0 (no trim) — two numbers that could drift silently. These
 * tests pin the precedence: rule set → env → 4000 default (the last two are the
 * bridge for the daemon-absent path, where the bundled rule set has no field).
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { hintBudget } from './hook-listener.js'

function res(over: Record<string, unknown> = {}): any {
  return { ruleId: 'r', text: 't', priority: 1, ...over }
}

describe('hintBudget — budget comes from the rule set', () => {
  beforeEach(() => { delete process.env.SW_HINT_MAX_CHARS })

  test('the rule set value wins', () => {
    expect(hintBudget([res({ maxChars: 2500 })])).toBe(2500)
  })

  test('the FIRST result carrying it wins (engine stamps them all the same)', () => {
    expect(hintBudget([res(), res({ maxChars: 1234 })])).toBe(1234)
  })

  test('absent → the 4000 default', () => {
    expect(hintBudget([res()])).toBe(4000)
    expect(hintBudget([])).toBe(4000)
  })

  test('env is the bridge when the rule set carries nothing', () => {
    process.env.SW_HINT_MAX_CHARS = '777'
    expect(hintBudget([res()])).toBe(777)
    // A real rule-set value still outranks the env bridge.
    expect(hintBudget([res({ maxChars: 2500 })])).toBe(2500)
  })

  test('a non-positive / non-numeric value is ignored, not obeyed', () => {
    expect(hintBudget([res({ maxChars: 0 })])).toBe(4000)
    expect(hintBudget([res({ maxChars: -5 })])).toBe(4000)
    expect(hintBudget([res({ maxChars: 'x' })])).toBe(4000)
    expect(hintBudget([res({ maxChars: Number.NaN })])).toBe(4000)
  })
})
