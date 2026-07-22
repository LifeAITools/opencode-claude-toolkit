/**
 * config-dir-lock.ts — cross-process lock on the Claude config dir
 * (`~/.claude`), using the SAME primitive the native `claude` CLI uses so the
 * proxy's active-org `.credentials.json` co-write is mutually-exclusive with
 * the native CLI's own OAuth refresh.
 *
 * The native CLI locks the config dir via `proper-lockfile.lock(claudeDir)`
 * (`claude-code-source/src/utils/auth.ts:1491`), which creates `<dir>.lock`.
 * Locking the SAME path here is what gives true mutual exclusion — a
 * different lock object (e.g. `sdk.ts`'s `.token-refresh-lock` mkdir lock)
 * protects nothing against the native CLI (architect-review H1).
 *
 * ELOCKED-retry discipline mirrors the reference: up to MAX_RETRIES=5 attempts,
 * `sleep(1000 + rand*1000)` between them. Returns `null` when the lock could
 * not be acquired (a peer/native-CLI is mid-refresh) — the caller then re-reads
 * disk and proceeds fail-soft rather than double-refreshing.
 */

import { mkdirSync } from 'fs'
import lockfile from 'proper-lockfile'

/** Native CLI parity: `checkAndRefreshOAuthTokenIfNeeded` retries ELOCKED up to 5×. */
const MAX_RETRIES = 5

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Acquire the config-dir lock. Resolves to a release function, or `null` if
 * another process holds it after all retries (caller should fail-soft).
 * Never throws for ELOCKED; unexpected errors also resolve to `null` so a
 * lock subsystem fault degrades to "behave as if unlocked" rather than
 * breaking a request path.
 */
export async function acquireConfigDirLock(
  configDir: string,
  maxRetries: number = MAX_RETRIES,
): Promise<(() => Promise<void>) | null> {
  try { mkdirSync(configDir, { recursive: true }) } catch { /* exists */ }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Default opts == the native CLI's call — same `<dir>.lock` path, so the
      // two processes truly exclude each other.
      const release = await lockfile.lock(configDir)
      return release
    } catch (err) {
      if ((err as { code?: string })?.code === 'ELOCKED') {
        if (attempt < maxRetries) {
          await sleep(1000 + Math.random() * 1000)
          continue
        }
        return null
      }
      // Unexpected (permissions, missing dir race) — degrade to unlocked.
      return null
    }
  }
  return null
}
