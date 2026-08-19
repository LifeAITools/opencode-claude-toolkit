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
    expect(RUNTIME_IDENTITY).toMatch(/^prog=\S+ ppid=\S+$/)
    expect(RUNTIME_IDENTITY).not.toContain('prog= ')
  })

  test('never contains a newline — one diagnostic event stays one line', () => {
    // A newline here would split every stamped line in two and silently break
    // every log reader that counts events.
    expect(RUNTIME_IDENTITY).not.toContain('\n')
  })
})
