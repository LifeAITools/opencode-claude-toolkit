/**
 * org-role-metadata — typed reader for OrgRole.metadata JSON blob.
 *
 * SynqTask stores OrgRole.metadata as untyped JSON; bridge code reads
 * specific fields with default fallbacks. This module is the SINGLE
 * point where the wire format is narrowed to a typed interface. Adding
 * a new metadata field requires updating BOTH this interface AND the
 * SynqTask seed-org-roles.ts semantics doc in the same PR.
 *
 * Per PRD §TypeScript Contract for OrgRole.metadata, §AD-13.
 * Closes: G-A1 (SSOT-A), AD-13 (metadata_schema_version forward-compat).
 */

import { SPAWN_DEPTH_MAX, CONCURRENT_SPAWNS_MAX } from './domain-constants'
import { coreWarn as swWarn } from '@kiberos/signal-wire-core'

/** The current bridge-side schema version. Bump when adding fields. */
export const BRIDGE_METADATA_SCHEMA_VERSION = 1

export interface OrgRoleBridgeMetadata {
  /** Per-role override for SPAWN_DEPTH_MAX (default DC-01 = 3). */
  spawn_depth_max?: number
  /** Per-role override for CONCURRENT_SPAWNS_MAX (default DC-02 = 5). */
  concurrent_spawns_max?: number
  /** True → supervisor auto-spawns this role on next tick if no instance running. */
  auto_run?: boolean
  /** Optional pointer to SynqTask team prompt for layer 3 composition. */
  team_prompt_id?: string
  /** Forward-compat: future bridge versions check this; unknown → WARN + safe defaults. */
  metadata_schema_version?: number
}

/**
 * Narrow untyped JSON blob → typed OrgRoleBridgeMetadata.
 *
 * - Field-level safety: every field is OPTIONAL; missing → undefined
 * - Type-mismatch (e.g. spawn_depth_max="5") → undefined + WARN
 * - metadata_schema_version > current → WARN (AD-13)
 * - Returns NEVER null (always usable object; consumers apply DC-01/02 defaults)
 */
export function readOrgRoleMetadata(raw: unknown): OrgRoleBridgeMetadata {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const obj = raw as Record<string, unknown>
  const out: OrgRoleBridgeMetadata = {}

  // spawn_depth_max
  if (obj.spawn_depth_max !== undefined) {
    if (typeof obj.spawn_depth_max === 'number' && Number.isFinite(obj.spawn_depth_max) && obj.spawn_depth_max >= 0) {
      out.spawn_depth_max = obj.spawn_depth_max
    } else {
      swWarn('ORG_ROLE_METADATA_BAD_FIELD', {
        field: 'spawn_depth_max',
        received: typeof obj.spawn_depth_max,
        falling_back_to: SPAWN_DEPTH_MAX,
      })
    }
  }

  // concurrent_spawns_max
  if (obj.concurrent_spawns_max !== undefined) {
    if (typeof obj.concurrent_spawns_max === 'number' && Number.isFinite(obj.concurrent_spawns_max) && obj.concurrent_spawns_max >= 0) {
      out.concurrent_spawns_max = obj.concurrent_spawns_max
    } else {
      swWarn('ORG_ROLE_METADATA_BAD_FIELD', {
        field: 'concurrent_spawns_max',
        received: typeof obj.concurrent_spawns_max,
        falling_back_to: CONCURRENT_SPAWNS_MAX,
      })
    }
  }

  // auto_run
  if (typeof obj.auto_run === 'boolean') {
    out.auto_run = obj.auto_run
  } else if (obj.auto_run !== undefined) {
    swWarn('ORG_ROLE_METADATA_BAD_FIELD', { field: 'auto_run', received: typeof obj.auto_run })
  }

  // team_prompt_id
  if (typeof obj.team_prompt_id === 'string' && obj.team_prompt_id.length > 0) {
    out.team_prompt_id = obj.team_prompt_id
  } else if (obj.team_prompt_id !== undefined) {
    swWarn('ORG_ROLE_METADATA_BAD_FIELD', { field: 'team_prompt_id', received: typeof obj.team_prompt_id })
  }

  // metadata_schema_version — AD-13 forward-compat
  if (typeof obj.metadata_schema_version === 'number' && Number.isFinite(obj.metadata_schema_version)) {
    out.metadata_schema_version = obj.metadata_schema_version
    if (obj.metadata_schema_version > BRIDGE_METADATA_SCHEMA_VERSION) {
      swWarn('ORG_ROLE_METADATA_VERSION_TOO_NEW', {
        received: obj.metadata_schema_version,
        bridge_supports: BRIDGE_METADATA_SCHEMA_VERSION,
        action: 'using safe defaults for unknown fields',
      })
    }
  }

  return out
}
