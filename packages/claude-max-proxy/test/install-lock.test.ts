/**
 * Two bootstraps meeting at the same installer.
 *
 * Why this is guarded at all — measured 2026-08-20 and reported by the
 * lat-context owner from the founder's screen: a detached bootstrap could not
 * see the healthy `claude` on its stripped PATH, so it reinstalled the global
 * npm package on every start. Five installs inside two minutes, and two of them
 * collided while npm was renaming the package directory: `ENOTEMPTY`, and the
 * bootstrap failed. That package is the binary every agent on the machine
 * launches from, so a collision at the wrong moment leaves the machine with no
 * `claude` at all.
 *
 * The PATH half of that fix removes the reason to install. This half removes
 * the collision itself, for every other reason an install might still be due.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { withInstallLock, decideInstallOutcome } from '../bin/install-lock.ts'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'install-lock-')) })
afterEach(() => { try { rmSync(root, { recursive: true, force: true }) } catch {} })

describe('withInstallLock', () => {
  test('two racers produce exactly ONE install, and the loser sees the work already done', async () => {
    let installs = 0
    let installed = false
    const install = async () => {
      installs++
      await new Promise((r) => setTimeout(r, 120))   // npm renaming its directory
      installed = true
    }
    await Promise.all([
      withInstallLock('tool', () => !installed, install, root, 5_000),
      withInstallLock('tool', () => !installed, install, root, 5_000),
    ])
    expect(installs).toBe(1)
    expect(installed).toBe(true)
  })

  test('the lock is released, so the next bootstrap is not blocked by the last one', async () => {
    await withInstallLock('tool', () => true, async () => {}, root, 5_000)
    expect(readdirSync(root)).not.toContain('tool.lock')
    let ran = false
    await withInstallLock('tool', () => true, async () => { ran = true }, root, 5_000)
    expect(ran).toBe(true)
  })

  test('an install that throws still releases the lock — a crash must not wedge the machine', async () => {
    await expect(
      withInstallLock('tool', () => true, async () => { throw new Error('npm blew up') }, root, 5_000),
    ).rejects.toThrow('npm blew up')
    expect(existsSync(join(root, 'tool.lock'))).toBe(false)
  })

  test('nothing is installed when it is no longer needed', async () => {
    let installs = 0
    await withInstallLock('tool', () => false, async () => { installs++ }, root, 5_000)
    expect(installs).toBe(0)
  })
})

describe('what a failed install means', () => {
  test('a failed install with the tool PRESENT must not end the bootstrap', () => {
    // The 2026-08-20 case exactly: npm collided with another installer and
    // failed, the CLI had been on the machine all along, and exiting there left
    // the founder looking at an empty shell with no agent in it.
    expect(decideInstallOutcome({ installSucceeded: false, presentAfter: true })).toBe('already-present')
  })

  test('a failed install with the tool ABSENT is worth stopping for', () => {
    expect(decideInstallOutcome({ installSucceeded: false, presentAfter: false })).toBe('fatal')
  })

  test('a succeeded install that produced nothing is still fatal — success is the tool being there', () => {
    // npm can exit 0 and leave nothing usable behind (wrong prefix, partial
    // write). The bootstrap needs the tool, not the exit code.
    expect(decideInstallOutcome({ installSucceeded: true, presentAfter: false })).toBe('fatal')
  })

  test('the ordinary success', () => {
    expect(decideInstallOutcome({ installSucceeded: true, presentAfter: true })).toBe('installed')
  })
})
