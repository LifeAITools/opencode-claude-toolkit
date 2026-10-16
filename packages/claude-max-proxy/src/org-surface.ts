/**
 * org-surface — merge the complete organization roster into the proxy's
 * org surface, so every door that shows "the orgs" answers the same question
 * the same way (S1/D1).
 *
 * BEFORE: `proxyClient.orgSurface()` (the SDK) lists the vault orgs with
 * identity + token expiry — but NO quota windows, and no status. The quota
 * file's `accounts` holds windows only for orgs that just served traffic, so a
 * cold org vanished entirely: the layer saw 1 of 4 orgs.
 *
 * AFTER: the quota file also carries `orgs` — the COMPLETE roster (every vault
 * org, cold ones included, with token state + windows-or-unknown). This helper
 * overlays that roster onto the live vault surface, keyed by orgId. The vault
 * stays authoritative for identity/expiry (it is read live in-process); the
 * quota file supplies the measured windows and the derived status.
 *
 * Fail-soft by design: no file, unreadable file, or an older file with no
 * `orgs` section → the surface is returned unchanged. A quota-pipeline hiccup
 * must never blank out the org list.
 */

import { readFileSync } from 'fs'
import { QUOTA_STATUS_JSON } from './quota-paths.js'

/** The orgs array shape orgSurface returns (identity + token state). */
export interface OrgSurfaceOrg {
  orgId: string
  orgName?: string
  accountEmail?: string
  expiresAt: number | null
  hasRefreshToken: boolean
  capturedAt?: number
  lastVerifiedAt?: number
  [k: string]: unknown
}

export interface OrgSurface {
  orgs: OrgSurfaceOrg[]
  sessions: Array<{ sessionId: string; pinnedOrg: string | null; servedOrg: string | null }>
}

/** Read the quota file's complete roster, indexed by orgId. Empty on any error. */
function readRoster(): Map<string, Record<string, unknown>> {
  try {
    const raw = JSON.parse(readFileSync(QUOTA_STATUS_JSON, 'utf8')) as {
      orgs?: Array<Record<string, unknown>>
    }
    return indexRoster(raw.orgs)
  } catch {
    return new Map()
  }
}

/** Index a roster array by orgId. Exported (pure) so a test drives the merge
 *  with a fabricated roster instead of this machine's real quota file. */
export function indexRoster(
  orgs: Array<Record<string, unknown>> | undefined,
): Map<string, Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>()
  for (const o of orgs ?? []) {
    if (o && typeof o.orgId === 'string') byId.set(o.orgId, o)
  }
  return byId
}

/**
 * Overlay the quota roster onto a live org surface. Each vault org gains the
 * window/status fields where the roster knows them (`windowsKnown`, `status`,
 * `util5h`, `util7d`, `reset5hAt`, `reset7dAt`, `level`); orgs the roster does
 * not know keep their vault fields only. An org present in the roster but not
 * in the live vault is appended, so nothing the layer knows is lost.
 *
 * `roster` is an injectable seam (defaults to the live quota file) so the merge
 * is unit-testable without touching disk.
 */
export function enrichOrgSurface<T extends OrgSurface>(
  surface: T,
  roster: Map<string, Record<string, unknown>> = readRoster(),
): T {
  if (roster.size === 0) return surface
  const seen = new Set<string>()
  const orgs: OrgSurfaceOrg[] = surface.orgs.map((o) => {
    seen.add(o.orgId)
    const row = roster.get(o.orgId)
    return row ? { ...o, ...row } : o
  })
  for (const [orgId, row] of roster) {
    if (seen.has(orgId)) continue
    orgs.push(row as OrgSurfaceOrg)
  }
  return { ...surface, orgs }
}
