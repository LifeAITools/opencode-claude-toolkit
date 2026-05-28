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
import { join } from 'path'

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
