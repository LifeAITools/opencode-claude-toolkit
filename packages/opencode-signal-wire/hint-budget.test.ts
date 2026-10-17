/**
 * Hint budget — comes from the RULE SET, not the adapter.
 *
 * The engine stamps every result with `maxChars`, propagated from
 * `RuleSet._meta.hint_max_chars` (core ≥ 0.37.0), and `packHints` inherits it.
 * The adapter held its own 4000 while the core held 0 (no trim) — two numbers
 * that could drift silently, which is exactly what the primitive exists to end.
 *
 * These tests pin that the adapter NO LONGER overrides the budget: the rendered
 * block is trimmed to the SET's value, and absence is detected (so it can be
 * named) rather than silently substituted with an adapter constant.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { applyChatHintResults, hintsCarryBudget } from './hook-listener.js'

function res(over: Record<string, unknown> = {}): any {
  return { success: true, type: 'hint', ruleId: 'r', hintText: 't', priority: 'medium', ...over }
}

/** Ten ~200-char hints — a block far bigger than a small budget. */
function bigResults(maxChars?: number): any[] {
  return Array.from({ length: 10 }, (_, i) =>
    res({
      ruleId: `r${i}`,
      hintText: 'x'.repeat(200),
      priority: i % 3 === 0 ? 'high' : i % 3 === 1 ? 'medium' : 'low',
      ...(maxChars != null ? { maxChars } : {}),
    }),
  )
}

function chatOutput() {
  return { message: {}, parts: [{ type: 'text', text: 'hello' }] }
}

describe('hint budget — the rule set decides, not the adapter', () => {
  beforeEach(() => {
    // Never touch the machine's live debug log from a test.
    process.env.SW_RENDER_LOG = '/tmp/opencode/sw-render-test.log'
  })

  test('the SET budget trims the block — the adapter passes no maxChars of its own', () => {
    const trimmed = chatOutput()
    applyChatHintResults(bigResults(400), trimmed, 's1')
    const untrimmed = chatOutput()
    applyChatHintResults(bigResults(undefined), untrimmed, 's1')

    const a = (trimmed.parts[0] as { text: string }).text.length
    const b = (untrimmed.parts[0] as { text: string }).text.length
    // The set's 400 cut the block; an adapter-side 4000 would have left it whole
    // (10 × 200 = 2000 < 4000), so a < b is exactly the regression guard.
    expect(a).toBeLessThan(b)
    expect(a).toBeGreaterThan('hello'.length)
  })

  test('no budget on the results → no trim (the core default), block intact', () => {
    const out = chatOutput()
    applyChatHintResults(bigResults(undefined), out, 's1')
    const text = (out.parts[0] as { text: string }).text
    // Untrimmed: all ten 200-char hints survive.
    expect(text.length).toBeGreaterThan(1900)
  })

  test('hintsCarryBudget: ANY carrying result counts, a non-positive one does not', () => {
    expect(hintsCarryBudget([res(), res({ maxChars: 100 })])).toBe(true)
    expect(hintsCarryBudget([res()])).toBe(false)
    expect(hintsCarryBudget([])).toBe(false)
    expect(hintsCarryBudget([res({ maxChars: 0 })])).toBe(false)
    expect(hintsCarryBudget([res({ maxChars: 'x' })])).toBe(false)
  })
})
