/**
 * deploy-drift — detect live src files hand-edited since the last deploy.
 *
 * WHY (Rule #15): the live install was historically hand-edited in place and
 * drifted from source — once silently dropping the stats-emitter startup and
 * killing the quota pipeline for 27h. deploy-from-source.sh writes a sha256
 * MANIFEST of every deployed src file; on boot the proxy re-hashes them and
 * loudly flags any mismatch — so a hand-edit can never again go unnoticed.
 *
 * Pure-ish (reads fs, never throws). No source repo needed at runtime — it only
 * compares the install tree against its own deploy manifest.
 */

import { readFileSync, existsSync } from 'fs'
import { createHash } from 'crypto'
import { join, dirname } from 'path'

/**
 * Where the deploy manifest actually lives, for a process that may be running
 * EITHER from source (TS, `import.meta.dir` = <install>/src) OR as a compiled
 * binary (<install>/bin/claude-max-proxy, where `import.meta.dir` is a virtual
 * path inside the bundle and resolves to nothing on disk).
 *
 * 🔴 This is the same trap the version string already fell into and worked
 * around with a build-time define — and the drift check fell into it too, in
 * silence. Measured 2026-08-18: every start since the binary runtime landed
 * emitted "no deploy manifest — deployed by hand?", including starts made BY
 * deploy-from-source.sh, which had just written that very manifest. So the one
 * check whose job is to say what is running had been blind for its whole life,
 * and it announced that blindness in a reassuring voice — which is why nothing
 * spoke up the day a hand-built binary really did diverge from the manifest.
 *
 * Order matters: the binary's own location is the strongest evidence of which
 * install this process IS, so it is consulted first.
 */
export function resolveInstallDir(fallbackDir: string): string {
  const candidates: string[] = []
  const envDir = process.env.CLAUDE_MAX_PROXY_INSTALL_DIR
  if (envDir) candidates.push(envDir)
  const exec = process.execPath
  if (exec) {
    candidates.push(dirname(dirname(exec)))   // <install>/bin/<binary>
    candidates.push(dirname(exec))            // <install>/<binary>
  }
  candidates.push(fallbackDir)                // running from source: <install>/src/..
  for (const dir of candidates) {
    if (dir && existsSync(join(dir, '.deploy-manifest.json'))) return dir
  }
  return fallbackDir
}

export interface DeployDriftResult {
  /** No manifest found — deployed by hand / pre-manifest. */
  manifestMissing: boolean
  deployedAt?: string
  sourceCommit?: string
  /** Relative paths whose current hash != manifest (hand-edited since deploy). */
  drifted: string[]
}

/** Compare every file in <installDir>/.deploy-manifest.json against its current
 *  on-disk hash. Empty `drifted` = live tree matches what was deployed. */
export function checkDeployDrift(installDir: string): DeployDriftResult {
  const manifestPath = join(installDir, '.deploy-manifest.json')
  if (!existsSync(manifestPath)) return { manifestMissing: true, drifted: [] }
  let manifest: { deployedAt?: string; sourceCommit?: string; files?: Record<string, string> }
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) }
  catch { return { manifestMissing: true, drifted: [] } }

  const drifted: string[] = []
  for (const [rel, expected] of Object.entries(manifest.files ?? {})) {
    const abs = join(installDir, rel)
    try {
      const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
      if (actual !== expected) drifted.push(rel)
    } catch { drifted.push(`${rel} (missing)`) }
  }
  return {
    manifestMissing: false,
    deployedAt: manifest.deployedAt,
    sourceCommit: manifest.sourceCommit,
    drifted,
  }
}
