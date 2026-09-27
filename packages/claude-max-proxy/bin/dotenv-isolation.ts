/**
 * The launcher must never read the .env of the directory it is started in.
 *
 * Bun auto-loads `.env*` from cwd into process.env, and the launcher runs in
 * the agent's PROJECT directory — so every secret of that project (a service's
 * own ANTHROPIC_API_KEY, *_URL, NODE_ENV) was handed to the spawned `claude`
 * and to a proxy the launcher boots. Measured 2026-09-27: kiberos-app's
 * `ANTHROPIC_API_KEY=proxy-managed` made Claude Code stop on its interactive
 * "use this API key?" screen for 45 min; promptera-api's .env carries a real
 * sk-ant key, which would have switched that agent to API billing.
 *
 * The shebang passes `--no-env-file`. A caller running `bun claude-max`
 * bypasses the shebang, so the launcher re-execs itself with the flag and the
 * environment it was actually given — on Linux that is /proc/self/environ,
 * which Bun's .env loading does not touch.
 */

import { readFileSync } from 'fs'

export const NO_ENV_FILE_FLAG = '--no-env-file'

/** Parse a NUL-separated environ block (as in /proc/<pid>/environ). */
export function parseEnvironBlock(block: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const entry of block.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

/**
 * Re-exec the current script under `--no-env-file` when it was started
 * without it. Returns only when no re-exec is needed or possible; in the
 * latter case it says so on stderr instead of leaking silently.
 */
export function ensureNoDotenv(): void {
  if (process.execArgv.includes(NO_ENV_FILE_FLAG)) return
  let original: Record<string, string>
  try {
    original = parseEnvironBlock(readFileSync('/proc/self/environ', 'utf8'))
  } catch {
    console.error(`[claude-max] started without ${NO_ENV_FILE_FLAG} and cannot recover the original environment on this OS — variables from ${process.cwd()}/.env may reach claude. Run claude-max directly, not via \`bun claude-max\`.`)
    return
  }
  const exec = (process as unknown as { execve?: (file: string, args: string[], env: Record<string, string>) => never }).execve
  if (typeof exec !== 'function') return
  exec(process.execPath, [process.execPath, NO_ENV_FILE_FLAG, ...process.execArgv, ...process.argv.slice(1)], original)
}
