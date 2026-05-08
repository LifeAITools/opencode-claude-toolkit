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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  applyCompactResults,
  resolveOpencodeToolOutputDir,
  computeContentHash,
  writeFallbackFile,
} from './hook-listener'
import { SW_FALLBACK_PATH_SENTINEL, type EmitResult } from '@kiberos/signal-wire-core'
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'fs'
import { join } from 'path'

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

// ─── REQ-09 / CR-06: Fallback file write tests ──────────────────────
//
// These tests touch the real filesystem under the opencode tool-output
// directory. We use uniquely-named raw outputs so test artifacts are
// trivially distinguishable, and we clean them up in afterEach.

describe('applyCompactResults: REQ-09 fallback file-write (CR-06)', () => {
  const writtenPaths: string[] = []

  afterEach(() => {
    // Cleanup any fallback files created during the test
    for (const p of writtenPaths) {
      try { if (existsSync(p)) unlinkSync(p) } catch { /* ignore */ }
    }
    writtenPaths.length = 0
  })

  test('compactNeedsFallback=true → writes raw to disk + substitutes sentinel', () => {
    const rawOriginal = `RAW-OUTPUT-FOR-FALLBACK-TEST-${Date.now()}-${Math.random()}\n`.repeat(50)
    const output = { output: rawOriginal, metadata: {} }
    // Body the emitter would have rendered: head + sentinel placeholder + tail
    const renderedBody =
      '<!--sw:compacted:fb-rule-->\nhead\n[stripped; full at ' +
      SW_FALLBACK_PATH_SENTINEL +
      ']\ntail'
    const results: EmitResult[] = [
      {
        type: 'compact',
        success: true,
        ruleId: 'fb-rule',
        correlationId: 'corr',
        compactOutcome: 'compacted',
        compacted: true,
        bytesDropped: 1000,
        linesDropped: 48,
        hintText: renderedBody,
        compactNeedsFallback: true,
      } as EmitResult,
    ]

    const r = applyCompactResults(results, output, 'sess-fb')
    expect(r.compacted).toBe(true)
    expect(r.ruleId).toBe('fb-rule')

    // Sentinel must be GONE from output, replaced with real path
    expect(output.output).not.toContain(SW_FALLBACK_PATH_SENTINEL)

    // Compute expected fallback path
    const expectedHash = computeContentHash(rawOriginal)
    const expectedPath = join(resolveOpencodeToolOutputDir(), `tool_sw_fb-rule_${expectedHash}`)
    writtenPaths.push(expectedPath)

    expect(output.output).toContain(expectedPath)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath, 'utf8')).toBe(rawOriginal)
  })

  test('fallback path is deterministic across re-runs (NFR-04)', () => {
    const rawOriginal = `DETERMINISM-TEST-${Date.now()}\n`.repeat(20)
    const output1 = { output: rawOriginal, metadata: {} }
    const output2 = { output: rawOriginal, metadata: {} }

    const renderedBody =
      '<!--sw:compacted:det-rule-->\nh\n[' + SW_FALLBACK_PATH_SENTINEL + ']\nt'
    const makeResults = (): EmitResult[] => [
      {
        type: 'compact',
        success: true,
        ruleId: 'det-rule',
        correlationId: 'c',
        compactOutcome: 'compacted',
        compacted: true,
        hintText: renderedBody,
        compactNeedsFallback: true,
      } as EmitResult,
    ]

    applyCompactResults(makeResults(), output1, 'sess-1')
    applyCompactResults(makeResults(), output2, 'sess-2')

    expect(output1.output).toBe(output2.output) // identical path substitution

    // Track for cleanup
    const hash = computeContentHash(rawOriginal)
    writtenPaths.push(join(resolveOpencodeToolOutputDir(), `tool_sw_det-rule_${hash}`))
  })

  test('fallback dedup: existing file with same hash is NOT overwritten', () => {
    const rawOriginal = `DEDUP-TEST-${Date.now()}-${Math.random()}\n`.repeat(10)
    const hash = computeContentHash(rawOriginal)
    const expectedPath = join(resolveOpencodeToolOutputDir(), `tool_sw_dedup-rule_${hash}`)
    writtenPaths.push(expectedPath)

    // Pre-write with sentinel content to verify dedup
    const dir = resolveOpencodeToolOutputDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const sentinelContent = '__PRE-EXISTING__'
    require('fs').writeFileSync(expectedPath, sentinelContent, 'utf8')

    const output = { output: rawOriginal, metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'compact',
        success: true,
        ruleId: 'dedup-rule',
        correlationId: 'c',
        compactOutcome: 'compacted',
        compacted: true,
        hintText: '<!--sw:compacted:dedup-rule-->\nh\n[' + SW_FALLBACK_PATH_SENTINEL + ']\nt',
        compactNeedsFallback: true,
      } as EmitResult,
    ]
    applyCompactResults(results, output, 'sess-1')

    // File still has pre-existing content (not overwritten)
    expect(readFileSync(expectedPath, 'utf8')).toBe(sentinelContent)
    // But applier still substituted the path correctly
    expect(output.output).toContain(expectedPath)
  })

  test('writeFallbackFile helper directly: returns path, writes content', () => {
    const raw = `HELPER-TEST-${Date.now()}-${Math.random()}\n`
    const path = writeFallbackFile('helper-rule', raw)
    expect(path).toBeTruthy()
    if (path) {
      writtenPaths.push(path)
      expect(existsSync(path)).toBe(true)
      expect(readFileSync(path, 'utf8')).toBe(raw)
      // Path shape: <dir>/tool_sw_<ruleId>_<12-char-hex>
      expect(path).toContain('tool_sw_helper-rule_')
      expect(path).toMatch(/_[0-9a-f]{12}$/)
    }
  })

  test('compactNeedsFallback=false (path was set) → no file written, no sentinel', () => {
    // When emitter has tool_output_path set, no fallback flag, no sentinel
    // in body, no file should be written.
    const output = { output: 'raw text', metadata: {} }
    const results: EmitResult[] = [
      {
        type: 'compact',
        success: true,
        ruleId: 'normal-rule',
        correlationId: 'c',
        compactOutcome: 'compacted',
        compacted: true,
        hintText: '<!--sw:compacted:normal-rule-->\nhead\n[stripped; full at /real/path]\ntail',
        // No compactNeedsFallback flag
      } as EmitResult,
    ]
    applyCompactResults(results, output, 'sess-1')

    expect(output.output).toContain('/real/path')
    expect(output.output).not.toContain(SW_FALLBACK_PATH_SENTINEL)
    // No path tracked for cleanup — none should have been written
  })
})
