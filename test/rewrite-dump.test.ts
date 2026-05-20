/**
 * rewrite-dump — unit tests.
 *
 * Covers the pure prefix-diff and the artifact writer. The diff is what an
 * analysing agent reads first, so its classification (system moved / tools
 * moved / prefix identical) must be exact and never throw.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { diffPrefix, writeRewriteBlockDump } from '../src/rewrite-dump.js'

const sys = (t: string) => [{ type: 'text', text: t, cache_control: { type: 'ephemeral' } }]
const tool = (name: string, desc = 'd') => ({ name, description: desc, input_schema: {} })

describe('diffPrefix', () => {
  test('no baseline → flagged, not a divergence', () => {
    const d = diffPrefix(null, { system: sys('s'), tools: [tool('a')] })
    expect(d.noBaseline).toBe(true)
    expect(d.summary).toContain('first request')
  })

  test('identical prefix → no change, summary says IDENTICAL', () => {
    const p = { system: sys('same'), tools: [tool('a'), tool('b')] }
    const d = diffPrefix({ ...p }, { ...p })
    expect(d.systemChanged).toBe(false)
    expect(d.toolsChanged).toBe(false)
    expect(d.summary).toContain('IDENTICAL')
  })

  test('system text change is detected', () => {
    const d = diffPrefix(
      { system: sys('old'), tools: [] },
      { system: sys('new longer'), tools: [] },
    )
    expect(d.systemChanged).toBe(true)
    expect(d.summary).toContain('system changed')
  })

  test('tool added / removed is detected by name', () => {
    const d = diffPrefix(
      { system: sys('s'), tools: [tool('keep'), tool('drop')] },
      { system: sys('s'), tools: [tool('keep'), tool('new')] },
    )
    expect(d.toolsChanged).toBe(true)
    expect(d.tools.added).toEqual(['new'])
    expect(d.tools.removed).toEqual(['drop'])
  })

  test('tool definition change (same name, new description) is detected', () => {
    const d = diffPrefix(
      { system: sys('s'), tools: [tool('x', 'old desc')] },
      { system: sys('s'), tools: [tool('x', 'new desc')] },
    )
    expect(d.toolsChanged).toBe(true)
    expect(d.tools.definitionChanged).toEqual(['x'])
  })

  test('never throws on malformed input', () => {
    expect(() => diffPrefix(null as any, { system: undefined, tools: 'bad' as any })).not.toThrow()
  })
})

describe('writeRewriteBlockDump', () => {
  test('writes a self-contained artifact with request + diff + verdict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rwd-'))
    const path = writeRewriteBlockDump(dir, {
      sessionId: 'sess-abcdef12',
      lineageKey: 'lin-1',
      rewriteClass: 'avoidable:ttl-expiry',
      predictedTokens: 120000,
      signals: { systemChanged: false, toolsChanged: false, orgChanged: false, idleMs: 700000, ttlMs: 300000 },
      blockedRequest: { model: 'claude-opus-4-7', system: sys('s'), tools: [tool('a')], messages: [] },
      previousPrefix: { system: sys('s'), tools: [tool('a')] },
    })
    expect(path).not.toBeNull()
    const files = readdirSync(dir)
    expect(files.length).toBe(1)
    expect(files[0]).toContain('avoidable_ttl-expiry')
    const art = JSON.parse(readFileSync(path!, 'utf8'))
    expect(art.verdict.rewriteClass).toBe('avoidable:ttl-expiry')
    expect(art.verdict.signals.idleMs).toBe(700000)
    expect(art.blockedRequest.model).toBe('claude-opus-4-7')
    expect(art.prefixDiff.summary).toContain('IDENTICAL')   // ttl-expiry: no content change
    rmSync(dir, { recursive: true, force: true })
  })

  test('returns null (never throws) when the directory cannot be created', () => {
    const path = writeRewriteBlockDump('/proc/nonexistent/cannot/mkdir', {
      sessionId: 's', lineageKey: 'l', rewriteClass: 'x', predictedTokens: 1,
      signals: { systemChanged: false, toolsChanged: false, orgChanged: false, idleMs: null, ttlMs: 1 },
      blockedRequest: {}, previousPrefix: null,
    })
    expect(path).toBeNull()
  })
})
