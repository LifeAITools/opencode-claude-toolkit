/**
 * Tests: provider.ts:buildStatsUsage — Phase 3.B (omit-when-absent contract).
 *
 * The helper is the JSONL-writer side of the 3.B subfield wire-in: SSE
 * parsers populate optional TokenUsage subfields (cacheCreation5m/1h/Deleted)
 * only when Anthropic actually reports them; this helper must propagate the
 * absent → omitted contract so existing log analysers don't see surprise
 * zero values for entries pre-dating 1h-TTL rollout (OQ-02 / REQ-05).
 */

import { describe, test, expect } from 'bun:test'
import { buildStatsUsage } from '../provider.js'

describe('buildStatsUsage — omit-when-absent', () => {
  test('always emits in/out/cacheRead/cacheWrite (filled with 0 on undefined)', () => {
    const out = buildStatsUsage({})
    expect(out.in).toBe(0)
    expect(out.out).toBe(0)
    expect(out.cacheRead).toBe(0)
    expect(out.cacheWrite).toBe(0)
    // Subfields MUST be absent when source undefined.
    expect('cacheWrite5m' in out).toBe(false)
    expect('cacheWrite1h' in out).toBe(false)
    expect('cacheDeleted' in out).toBe(false)
  })

  test('emits cacheWrite5m only when source is a number', () => {
    const out = buildStatsUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 200,
      cacheCreation5mInputTokens: 150,
    })
    expect(out.cacheWrite5m).toBe(150)
    expect('cacheWrite1h' in out).toBe(false)
    expect('cacheDeleted' in out).toBe(false)
  })

  test('emits cacheWrite1h + cacheDeleted independently', () => {
    const out = buildStatsUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheCreation1hInputTokens: 1039,
      cacheDeletedInputTokens: 0,
    })
    expect(out.cacheWrite1h).toBe(1039)
    expect(out.cacheDeleted).toBe(0) // 0 IS a valid value (deletion happened, count=0)
    expect('cacheWrite5m' in out).toBe(false)
  })

  test('null usage object → defaults emitted, no subfields', () => {
    const out = buildStatsUsage(null)
    expect(out.in).toBe(0)
    expect('cacheWrite5m' in out).toBe(false)
    expect('cacheWrite1h' in out).toBe(false)
    expect('cacheDeleted' in out).toBe(false)
  })

  test('non-number subfield (defensive) → omitted', () => {
    const out = buildStatsUsage({
      inputTokens: 1,
      cacheCreation5mInputTokens: 'oops' as any,
      cacheCreation1hInputTokens: undefined,
    })
    expect('cacheWrite5m' in out).toBe(false)
    expect('cacheWrite1h' in out).toBe(false)
  })

  test('full payload — all 7 keys present', () => {
    const out = buildStatsUsage({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 5000,
      cacheCreationInputTokens: 1200,
      cacheCreation5mInputTokens: 200,
      cacheCreation1hInputTokens: 1000,
      cacheDeletedInputTokens: 50,
    })
    expect(out).toEqual({
      in: 100,
      out: 50,
      cacheRead: 5000,
      cacheWrite: 1200,
      cacheWrite5m: 200,
      cacheWrite1h: 1000,
      cacheDeleted: 50,
    })
  })
})
