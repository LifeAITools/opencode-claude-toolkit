/**
 * A diagnostic line must name WHO wrote it.
 *
 * On 2026-08-19 six short-lived processes fired keepalives against dead
 * prefixes for a whole day, and every line they left behind said only `pid=N`.
 * By the time anyone looked, those numbers belonged to nothing: the processes
 * could not be identified at all, and the investigation ran on inference where
 * it should have run on a read. The identity stamp exists so that never repeats.
 */

import { describe, test, expect } from 'bun:test'
import { RUNTIME_IDENTITY } from '../src/keepalive-engine.js'

describe('runtime identity stamp', () => {
  test('names the program and its parent, so a dead pid is still identifiable', () => {
    expect(RUNTIME_IDENTITY).toMatch(/^prog=\S+ exec=\S+ ppid=\S+$/)
    expect(RUNTIME_IDENTITY).not.toContain('prog= ')
  })

  test('never contains a newline — one diagnostic event stays one line', () => {
    // A newline here would split every stamped line in two and silently break
    // every log reader that counts events.
    expect(RUNTIME_IDENTITY).not.toContain('\n')
  })

  test('a process with no script still says WHAT it is', () => {
    // `bun -e`, a compiled binary and a worker all have no argv[1]. The first
    // version of this stamp printed `prog=unknown` for them and named nothing —
    // the very gap it was written to close. The runtime name always resolves,
    // so the line is never fully anonymous.
    expect(RUNTIME_IDENTITY).toMatch(/exec=[^ ]+/)
    expect(RUNTIME_IDENTITY).not.toMatch(/exec=(na|unknown)\b/)
  })
})

describe('identifiers in diagnostics', () => {
  test('the keep-warm line prints the WHOLE lineage key', async () => {
    // The key is composite (`<systemHash>:<toolsHash>`), and two DIFFERENT
    // lineages of one session can share its first half — measured 2026-08-20
    // in a live registry: 44433d8e10db:d7e7ba4a2fe9 and 44433d8e10db:39586a31d6ee.
    // The first version of this line cut the key at 12 characters, i.e. exactly
    // where it stops being unique, so the log named a lineage that could be
    // either of two. A truncated identifier cannot be searched or acted on.
    const src = await Bun.file(new URL('../src/keepalive-engine.ts', import.meta.url)).text()
    const line = src.split('\n').find((l) => l.includes('KA_EVICTION_KEEP_WARM'))
    expect(line).toBeDefined()
    expect(line).toContain('lineage=${best.lineageKey}')
    expect(line).not.toMatch(/lineageKey\.slice\(/)
  })
})
