/**
 * What is committed is what is built.
 *
 * 🔴 THIS PACKAGE SHIPS A BUILT BUNDLE, AND CONSUMERS READ IT, NOT THE SOURCE.
 * `package.json` says `main: dist/index.js` and points `exports` at the same
 * file, and four sibling packages in this repo depend on it — `opencode-claude`
 * resolves it by a symlink straight to this repo root, so whatever sits in
 * `dist/` at that moment is the code it actually runs.
 *
 * 🔴 WHY THERE IS A TEST AND NOT JUST A HABIT. Measured 2026-08-19, on this very
 * repository, one commit after the fact: `dist/index.js` as committed at
 * af7de7e did NOT contain the change that commit was about, because the bundle
 * was rebuilt by the deploy AFTER the commit was made. Anyone checking out that
 * commit and importing the package would have run the previous day's code while
 * the source beside it said otherwise.
 *
 * That is not a novel failure — it is the same one that cost this fleet a day
 * the evening before, in a NEIGHBOUR's package: its source and its compiled
 * binaries carried a fix while the library build that `main`/`exports` pointed
 * at was a day old, so every library consumer kept running the old behaviour
 * and the owner's "already shipped" was true only of the half he could see.
 * The lesson was theirs first; this test is that lesson applied here, where the
 * same shape had been sitting unguarded the whole time.
 *
 * WHAT IT COMPARES, AND WHY THAT IS EXACT. The build is deterministic — the
 * same source produces the same bytes, verified before this test was written —
 * so it rebuilds into a scratch directory and compares byte for byte. No hash
 * to trust, no marker to keep in sync: if the bundle in `dist/` was not built
 * from the source beside it, the bytes differ and this goes red.
 *
 * WHEN IT GOES RED, THE FIX IS ONE COMMAND: `bun run build`, then commit the
 * result together with the source change that caused it.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const ROOT = join(import.meta.dir, '..')

/**
 * Is anything the bundle is built FROM edited but not yet committed?
 *
 * 🔴 This distinction is the difference between a guard and a nuisance, and it
 * was handed to me by packages-signal-wire-core-owner within the hour, from his
 * own version of this check: while you are mid-edit in `src/`, the bundle on
 * disk legitimately does not match the source beside it, and a byte comparison
 * would go red for everyone on every ordinary edit — which is how a warning
 * gets muted, exactly the failure this file exists to prevent elsewhere.
 *
 * The narrowness matters: a dirty `dist/` alone must NOT skip the check, because
 * that is precisely the defect that started this — a bundle rebuilt AFTER the
 * commit, leaving what is committed one step behind what is built.
 */
export function skipsBecauseSourceIsDirty(gitPorcelainForSrc: string): boolean {
  return gitPorcelainForSrc.trim().length > 0
}

function bundleSourceIsDirty(): boolean {
  try {
    // `-- src` narrows git's answer to the bundle's own inputs: a dirty dist/
    // must NOT reach this predicate, or the check would skip exactly the case it
    // was built for.
    const out = execFileSync('git', ['status', '--porcelain', '--', 'src'], {
      cwd: ROOT, encoding: 'utf8',
    })
    return skipsBecauseSourceIsDirty(out)
  } catch {
    // No git, no verdict — better to run the check than to skip it silently.
    return false
  }
}

/**
 * The skip rule on its own, because a skip that quietly became unconditional
 * would leave this whole file green for ever — the exact shape of "honest in
 * the happy case, mute in the one it exists for" that it was written against.
 * Testing the decision separately is what makes both halves able to go red.
 */
describe('when the check steps aside', () => {
  test('a clean src means the comparison RUNS', () => {
    expect(skipsBecauseSourceIsDirty('')).toBe(false)
    expect(skipsBecauseSourceIsDirty('\n')).toBe(false)
  })

  test('an edited source file makes it step aside', () => {
    expect(skipsBecauseSourceIsDirty(' M src/proxy-client.ts\n')).toBe(true)
    expect(skipsBecauseSourceIsDirty('?? src/new-thing.ts\n')).toBe(true)
  })

  test('a dirty dist alone never reaches this rule — git is asked about src only', () => {
    // Guarded by the `-- src` pathspec in the caller: were it dropped, a bundle
    // rebuilt after the commit (the very defect) would silence the check.
    const gitAnswerWhenOnlyDistIsDirty = ''
    expect(skipsBecauseSourceIsDirty(gitAnswerWhenOnlyDistIsDirty)).toBe(false)
  })
})

describe('the shipped bundle matches the source beside it', () => {
  test('dist/index.js is what a build of src produces right now', async () => {
    const committed = join(ROOT, 'dist', 'index.js')
    expect(existsSync(committed)).toBe(true)

    if (bundleSourceIsDirty()) {
      // Said out loud rather than passing quietly: a check that skips in silence
      // reads exactly like a check that ran.
      console.log(
        '[dist-matches-source] SKIPPED — src/ has uncommitted edits, so the bundle '
        + 'is expected to differ. Run `bun run build` and commit dist together with '
        + 'the source change; this check runs again on a clean tree.',
      )
      return
    }

    const scratch = mkdtempSync(join(tmpdir(), 'sdk-dist-check-'))
    try {
      const proc = Bun.spawn(['bun', 'run', 'scripts/build-sdk.ts'], {
        cwd: ROOT,
        env: { ...process.env, SDK_BUILD_OUTDIR: scratch },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const code = await proc.exited
      if (code !== 0) {
        const err = await new Response(proc.stderr).text()
        throw new Error(`the build itself failed (exit ${code}) — fix that first:\n${err.slice(0, 2000)}`)
      }

      const fresh = readFileSync(join(scratch, 'index.js'))
      const shipped = readFileSync(committed)

      // Sizes first: a mismatch here is the common case and the message is
      // readable, where a byte-buffer diff would print megabytes of minified JS.
      expect({ builtBytes: fresh.length, shippedBytes: shipped.length })
        .toEqual({ builtBytes: fresh.length, shippedBytes: fresh.length })
      expect(Buffer.compare(fresh, shipped)).toBe(0)
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  }, 120_000)
})
