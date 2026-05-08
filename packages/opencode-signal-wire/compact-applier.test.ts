/**
 * Integration tests for applyCompactResults.
 *
 * Per PRP plan task T11 + s3.5 inline action item A2 (cross-rule
 * idempotency test enumeration).
 *
 * Verifies the platform-adapter side of the tool-output-compaction
 * feature: mutation of output.output, idempotency at applier level
 * (cross-rule per REQ-15), priority-ordered iteration with first-wins,
 * and pass-through behavior on errors / non-matches.
 */

import { describe, test, expect } from 'bun:test'
import { applyCompactResults } from './hook-listener'
import type { EmitResult } from '@kiberos/signal-wire-core'

function makeCompactResult(overrides: Partial<EmitResult> = {}): EmitResult {
  return {
    type: 'compact',
    success: true,
    ruleId: 'test-rule',
    correlationId: 'test-corr',
    compactOutcome: 'compacted',
    compacted: true,
    bytesDropped: 1000,
    linesDropped: 50,
    hintText: '<!--sw:compacted:test-rule-->\nhead\n[stripped]\ntail',
    ...overrides,
  } as EmitResult
}

describe('applyCompactResults: happy path', () => {
  test('mutates output.output when compact result is success+compacted', () => {
    const output = { output: 'original raw text', metadata: {} }
    const results: EmitResult[] = [makeCompactResult()]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(true)
    expect(r.outcome).toBe('compacted')
    expect(r.bytesDropped).toBe(1000)
    expect(r.linesDropped).toBe(50)
    expect(r.ruleId).toBe('test-rule')
    expect(output.output).toBe('<!--sw:compacted:test-rule-->\nhead\n[stripped]\ntail')
  })
})

describe('applyCompactResults: per-rule idempotency (emitter-level)', () => {
  test('already-compacted outcome → no mutation', () => {
    const output = { output: 'something', metadata: {} }
    const results: EmitResult[] = [
      makeCompactResult({ compactOutcome: 'already-compacted', compacted: false, hintText: undefined }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('already-compacted')
    expect(output.output).toBe('something') // unchanged
  })
})

describe('applyCompactResults: cross-rule idempotency (REQ-15, A2 from s3.5)', () => {
  test('output already has marker from another rule → no further compact rules fire', () => {
    // Output already compacted by some other rule (different marker)
    const output = {
      output: '<!--sw:compacted:other-rule-->\npreserved head\n[stripped by other]\npreserved tail',
      metadata: {},
    }
    // Even though we pass a successful compact result, applier should detect
    // the existing marker at top and skip.
    const results: EmitResult[] = [makeCompactResult({ ruleId: 'this-rule' })]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('already-compacted')
    expect(r.ruleId).toBeNull() // applier-level skip, no rule ran
    expect(output.output.startsWith('<!--sw:compacted:other-rule-->')).toBe(true) // unchanged
  })

  test('single-rule order: first successful compact wins, subsequent skipped', () => {
    const output = { output: 'raw text', metadata: {} }
    // Two compact results in priority order — first should win, second
    // ignored even if both are successful.
    const results: EmitResult[] = [
      makeCompactResult({
        ruleId: 'rule-a',
        hintText: '<!--sw:compacted:rule-a-->\nA-head\n[A]\nA-tail',
        bytesDropped: 100,
        linesDropped: 10,
      }),
      makeCompactResult({
        ruleId: 'rule-b',
        hintText: '<!--sw:compacted:rule-b-->\nB-head\n[B]\nB-tail',
        bytesDropped: 200,
        linesDropped: 20,
      }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(true)
    expect(r.ruleId).toBe('rule-a') // first wins
    expect(r.bytesDropped).toBe(100)
    expect(output.output).toContain('rule-a')
    expect(output.output).not.toContain('rule-b')
  })
})

describe('applyCompactResults: pass-through cases', () => {
  test('output-too-small → no mutation, tries next rule', () => {
    const output = { output: 'small', metadata: {} }
    const results: EmitResult[] = [
      makeCompactResult({ compactOutcome: 'output-too-small', compacted: false, hintText: undefined }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('no-match') // exhausted all results
    expect(output.output).toBe('small')
  })

  test('no-match → tries next compact rule, eventually no-match if none fire', () => {
    const output = { output: 'something', metadata: {} }
    const results: EmitResult[] = [
      makeCompactResult({ compactOutcome: 'no-match', compacted: false, hintText: undefined }),
      makeCompactResult({ compactOutcome: 'no-match', compacted: false, hintText: undefined, ruleId: 'rule-2' }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('no-match')
    expect(output.output).toBe('something')
  })

  test('error outcome → logged, output unchanged, fail-open per NFR-08', () => {
    const output = { output: 'original', metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'compact',
        success: false,
        ruleId: 'broken-rule',
        correlationId: 'corr',
        compactOutcome: 'error',
        error: 'something broke',
      } as EmitResult,
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('no-match') // tries next, none → no-match
    expect(output.output).toBe('original') // NFR-08 fail-open
  })

  test('mixed: error followed by successful compact → second wins', () => {
    const output = { output: 'big text content here', metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'compact',
        success: false,
        ruleId: 'broken-rule',
        correlationId: 'corr',
        compactOutcome: 'error',
        error: 'broke',
      } as EmitResult,
      makeCompactResult({ ruleId: 'good-rule', hintText: '<!--sw:compacted:good-rule-->\nh\n[c]\nt' }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(true)
    expect(r.ruleId).toBe('good-rule')
    expect(output.output).toContain('good-rule')
  })
})

describe('applyCompactResults: ignores non-compact results', () => {
  test('hint result among compact results → ignored, looks at next compact', () => {
    const output = { output: 'raw', metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'hint',
        success: true,
        ruleId: 'hint-rule',
        correlationId: 'corr',
        hintText: 'some hint',
      } as EmitResult,
      makeCompactResult({ ruleId: 'compact-rule' }),
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(true)
    expect(r.ruleId).toBe('compact-rule')
  })

  test('no compact results at all → no-match', () => {
    const output = { output: 'raw', metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'hint',
        success: true,
        ruleId: 'hint-only',
        correlationId: 'corr',
        hintText: 'h',
      } as EmitResult,
    ]
    const r = applyCompactResults(results, output, 'sess-1')

    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('no-match')
    expect(output.output).toBe('raw')
  })
})

describe('applyCompactResults: empty / edge', () => {
  test('empty results array → no-match, output unchanged', () => {
    const output = { output: 'raw', metadata: {} }
    const r = applyCompactResults([], output, 'sess-1')
    expect(r.compacted).toBe(false)
    expect(r.outcome).toBe('no-match')
    expect(output.output).toBe('raw')
  })
})
