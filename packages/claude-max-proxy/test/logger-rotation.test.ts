/**
 * Tests: claude-max-proxy/src/logger.ts — size-based log rotation.
 *
 * Covers the RotatingSink mechanics behind startLogger's human + JSONL
 * streams (exported as __rotationInternals for testability):
 *   1. Rotate on threshold breach: active → .1, fresh active starts.
 *   2. Backup shift: repeated rotations cascade .1→.2→…→.<keep>.
 *   3. Oldest dropped: nothing beyond .<keep> survives.
 *   4. Oversized existing file self-heals on first write (seed > cap).
 *   5. maxMb=0 disables rotation entirely.
 *   6. A single line larger than the cap still lands (no infinite rotation).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'fs'
import { gunzipSync } from 'zlib'
import { tmpdir } from 'os'
import { join } from 'path'
import { __rotationInternals } from '../src/logger.js'

const { makeSink, writeRotating } = __rotationInternals

let dir: string
let logPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cmp-logrot-'))
  logPath = join(dir, 'proxy.jsonl')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// 100-byte line (incl. newline) makes thresholds easy to reason about.
const LINE = 'x'.repeat(99) + '\n'

describe('log rotation: threshold + backup shift', () => {
  test('rotates active → .1 when the next write would breach the cap', () => {
    // cap = 250 bytes → after 2 lines (200B) the 3rd would breach → rotate.
    const sink = makeSink(logPath, 0, 3, false)
    sink.maxBytes = 250
    writeRotating(sink, LINE) // 100
    writeRotating(sink, LINE) // 200
    expect(existsSync(`${logPath}.1`)).toBe(false)
    writeRotating(sink, LINE) // would be 300 > 250 → rotate first, then write
    expect(existsSync(`${logPath}.1`)).toBe(true)
    // .1 holds the two pre-rotation lines; active holds exactly one.
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe(LINE + LINE)
    expect(readFileSync(logPath, 'utf8')).toBe(LINE)
    expect(sink.bytes).toBe(100)
  })

  test('cascading rotations shift .1→.2→…  and drop beyond keep', () => {
    const keep = 3
    const sink = makeSink(logPath, 0, keep, false)
    sink.maxBytes = 150 // each 100B line after the first triggers a rotation
    // 100-byte lines tagged with their index so ordering is verifiable.
    const mkline = (i: number) => String(i).padEnd(99, 'x') + '\n'
    for (let i = 0; i < 12; i++) writeRotating(sink, mkline(i))
    // Exactly keep backups exist; none beyond.
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(existsSync(`${logPath}.2`)).toBe(true)
    expect(existsSync(`${logPath}.3`)).toBe(true)
    expect(existsSync(`${logPath}.4`)).toBe(false)
    // .1 is the most recent backup, .3 the oldest retained — ordering preserved.
    const idxOf = (p: string) => parseInt(readFileSync(p, 'utf8'), 10)
    expect(idxOf(`${logPath}.1`)).toBeGreaterThan(idxOf(`${logPath}.3`))
  })
})

describe('log rotation: edge cases', () => {
  test('oversized pre-existing file self-heals on first write', () => {
    // Simulate the live 196 MB file: seed an over-cap file, then a tiny cap.
    writeFileSync(logPath, 'o'.repeat(500))
    const sink = makeSink(logPath, 0, 2, false)
    sink.maxBytes = 200 // existing 500B already over cap
    expect(sink.bytes).toBe(500) // seeded from statSync
    writeRotating(sink, LINE)
    // First write rotates the oversized file out to .1, active is fresh.
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(statSync(`${logPath}.1`).size).toBe(500)
    expect(readFileSync(logPath, 'utf8')).toBe(LINE)
  })

  test('maxMb=0 disables rotation (file grows unbounded)', () => {
    const sink = makeSink(logPath, 0, 5, false) // maxBytes resolves to 0
    expect(sink.maxBytes).toBe(0)
    for (let i = 0; i < 50; i++) writeRotating(sink, LINE)
    expect(existsSync(`${logPath}.1`)).toBe(false)
    expect(statSync(logPath).size).toBe(50 * 100)
  })

  test('a single line larger than the cap still lands (no infinite rotation)', () => {
    const sink = makeSink(logPath, 0, 2, false)
    sink.maxBytes = 50
    const huge = 'h'.repeat(500) + '\n'
    writeRotating(sink, huge) // empty active → must NOT rotate, must write
    expect(existsSync(`${logPath}.1`)).toBe(false)
    expect(readFileSync(logPath, 'utf8')).toBe(huge)
    // Next write sees a non-empty over-cap active → rotates the huge line out.
    writeRotating(sink, 'small\n')
    expect(existsSync(`${logPath}.1`)).toBe(true)
    expect(readFileSync(`${logPath}.1`, 'utf8')).toBe(huge)
    expect(readFileSync(logPath, 'utf8')).toBe('small\n')
  })

  test('maxMb → maxBytes conversion uses MB (1024×1024)', () => {
    const sink = makeSink(logPath, 100, 5, false)
    expect(sink.maxBytes).toBe(100 * 1024 * 1024)
  })
})

describe('log rotation: gzip backups', () => {
  test('rotated backup is compressed to .1.gz and decompresses to original', async () => {
    const sink = makeSink(logPath, 0, 3, true)
    sink.maxBytes = 150
    const a = 'a'.repeat(99) + '\n'
    const b = 'b'.repeat(99) + '\n'
    writeRotating(sink, a)            // active = [a]
    writeRotating(sink, b)            // 200 > 150 → rotate: a→.1 (gzip bg), active = [b]
    await sink.lastCompress           // wait for background compression
    // No plain .1 left; a .1.gz exists and round-trips to the pre-rotation content.
    expect(existsSync(`${logPath}.1`)).toBe(false)
    expect(existsSync(`${logPath}.1.gz`)).toBe(true)
    expect(gunzipSync(readFileSync(`${logPath}.1.gz`)).toString()).toBe(a)
    expect(readFileSync(logPath, 'utf8')).toBe(b)
    // No .partial residue.
    expect(existsSync(`${logPath}.1.gz.partial`)).toBe(false)
  })

  test('gzip scheme shifts .N.gz and drops beyond keep', async () => {
    const keep = 2
    const sink = makeSink(logPath, 0, keep, true)
    sink.maxBytes = 150
    const mkline = (i: number) => String(i).padEnd(99, 'x') + '\n'
    for (let i = 0; i < 6; i++) {
      writeRotating(sink, mkline(i))
      if (sink.lastCompress) await sink.lastCompress
    }
    expect(existsSync(`${logPath}.1.gz`)).toBe(true)
    expect(existsSync(`${logPath}.2.gz`)).toBe(true)
    expect(existsSync(`${logPath}.3.gz`)).toBe(false) // dropped beyond keep
    // .1.gz is newer than .2.gz (higher index content).
    const idx = (p: string) => parseInt(gunzipSync(readFileSync(p)).toString(), 10)
    expect(idx(`${logPath}.1.gz`)).toBeGreaterThan(idx(`${logPath}.2.gz`))
  })
})
