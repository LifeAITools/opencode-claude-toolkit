/**
 * writeThoughtFile — opencode twin of the Claude Code hook's thought-writer
 * (proactive-memory-recall Phase 1.5). Contract mirrored from
 * signal-wire-core/scripts/memory-recall-common.ts: session-keyed filename
 * (sanitized sid), atomic tmp+rename, fail-open, prompt travels via FILE.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { writeThoughtFile } from './hook-listener'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thought-writer-test-'))
  process.env.MEMORY_RECALL_STATE_DIR = dir
})

afterEach(() => {
  delete process.env.MEMORY_RECALL_STATE_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('writeThoughtFile', () => {
  test('writes the prompt to a session-keyed thought file', () => {
    const ok = writeThoughtFile('ses_0c3c2de41ffeUG6AhX4aq0SpbF', 'какой у нас план по памяти?')
    expect(ok).toBe(true)
    const content = readFileSync(join(dir, 'thought-ses_0c3c2de41ffeUG6AhX4aq0SpbF.txt'), 'utf8')
    expect(content).toBe('какой у нас план по памяти?')
  })

  test('sanitizes exotic session ids the same way memory-recall-common.safe() does', () => {
    writeThoughtFile('ses/../weird:id', 'x')
    const files = readdirSync(dir)
    expect(files).toEqual(['thought-ses____weird_id.txt'])
  })

  test('overwrite is last-writer-wins (same session, newer thought replaces)', () => {
    writeThoughtFile('s1', 'первая мысль')
    writeThoughtFile('s1', 'вторая мысль')
    expect(readFileSync(join(dir, 'thought-s1.txt'), 'utf8')).toBe('вторая мысль')
  })

  test('no-ops on empty prompt or missing session id', () => {
    expect(writeThoughtFile('s1', '')).toBe(false)
    expect(writeThoughtFile(null, 'text')).toBe(false)
    expect(writeThoughtFile(undefined, 'text')).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  test('leaves no tmp files behind (atomic rename)', () => {
    writeThoughtFile('s2', 'мысль')
    const leftovers = readdirSync(dir).filter(f => f.includes('.tmp.'))
    expect(leftovers).toEqual([])
  })

  test('fail-open on unwritable dir (returns false, never throws)', () => {
    process.env.MEMORY_RECALL_STATE_DIR = '/proc/definitely-not-writable/state'
    expect(() => writeThoughtFile('s3', 'мысль')).not.toThrow()
    expect(writeThoughtFile('s3', 'мысль')).toBe(false)
  })
})
