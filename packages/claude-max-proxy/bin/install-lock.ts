/**
 * Install plumbing for the launcher: an exclusive cross-process lock, and the
 * rule for what a failed install actually means.
 *
 * Lives in its own file for one reason: a guard nobody can run in a test is a
 * guard nobody can prove. The launcher script executes on import, so anything
 * defined inside it is unreachable from a test — and this is precisely the code
 * whose whole job is what happens when two processes meet.
 */
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

/**
 * Run an installer under an exclusive lock, and only if it is still needed.
 *
 * `mkdir` is atomic on POSIX, so the directory IS the lock. A holder that died
 * without cleaning up is detected by its pid and its lock is taken over.
 *
 * The double check matters more than the lock: when two bootstraps race, the
 * loser waits, then finds the tool already installed by the winner and does
 * nothing — instead of starting a second global install into the same directory
 * the first one is still writing.
 */
export async function withInstallLock(
  name: string,
  stillNeeded: () => boolean,
  install: () => Promise<void>,
  // Test seam: where the lock directory lives. Production always uses the default.
  lockRoot?: string,
  // Test seam: how long to wait for a live holder before giving up.
  waitBudgetMs = 120_000,
): Promise<void> {
  const lockDir = lockRoot ?? join(homedir(), '.claude-local', 'locks')
  const lockPath = join(lockDir, `${name}.lock`)
  try { mkdirSync(lockDir, { recursive: true }) } catch { /* fall through to the unlocked path */ }

  const deadline = Date.now() + waitBudgetMs
  let held = false
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath)          // atomic: succeeds for exactly one process
      held = true
      break
    } catch {
      // Someone holds it. Alive, or dead and leaking?
      let holderPid = 0
      try { holderPid = parseInt(readFileSync(join(lockPath, 'pid'), 'utf8').trim(), 10) || 0 } catch { /* no pid file yet */ }
      let holderAlive = false
      if (holderPid > 0) {
        try { process.kill(holderPid, 0); holderAlive = true } catch { holderAlive = false }
      }
      if (!holderAlive) {
        try { unlinkSync(join(lockPath, 'pid')) } catch { /* may not exist */ }
        try { rmdirSync(lockPath) } catch { /* another waiter got there first */ }
        continue
      }
      await new Promise((r) => setTimeout(r, 500))
      if (!stillNeeded()) return   // the holder finished the job for us
    }
  }

  try {
    if (held) { try { writeFileSync(join(lockPath, 'pid'), String(process.pid)) } catch { /* best-effort */ } }
    // Re-check UNDER the lock: the winner of the race may have just installed it.
    if (!stillNeeded()) return
    await install()
  } finally {
    if (held) {
      try { unlinkSync(join(lockPath, 'pid')) } catch { /* already gone */ }
      try { rmdirSync(lockPath) } catch { /* already gone */ }
    }
  }
}

/** What a bootstrap should do after an install attempt. */
export type InstallOutcome = 'installed' | 'already-present' | 'fatal'

/**
 * Decide what a FAILED install means — and it does not always mean "stop".
 *
 * Measured 2026-08-20, reported by the lat-context owner from the founder's
 * screen: an install of the Claude CLI collided with another installer, failed
 * with ENOTEMPTY, and the bootstrap called `process.exit(1)`. The agent never
 * came up. What the founder saw in the panel was an empty shell — no error he
 * could act on, just a window in which nothing had happened — and the agent had
 * to be raised by hand.
 *
 * The CLI was on the machine the whole time. So the question a failed install
 * must ask is not "did npm succeed" but "is the tool there now": another
 * process may have installed it, or it may never have been missing. Only a tool
 * that is still absent afterwards is worth ending a bootstrap over.
 */
export function decideInstallOutcome(p: { installSucceeded: boolean; presentAfter: boolean }): InstallOutcome {
  if (p.installSucceeded && p.presentAfter) return 'installed'
  if (p.presentAfter) return 'already-present'   // install failed, tool is there anyway — carry on
  return 'fatal'                                  // genuinely absent: stopping is the honest answer
}
