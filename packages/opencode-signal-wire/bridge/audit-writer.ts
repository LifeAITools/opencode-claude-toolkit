/**
 * audit-writer — append-only JSONL writers for boot + spawn lifecycle.
 *
 * Per PRD §Audit Log Schemas + AD-08 (in-process rotation).
 * Sync writes, fail-open (errors NEVER propagate to caller per CN-08 revised).
 * 10MB threshold → atomic rename to `<path>.rotated-<ISO-date>`.
 * 30-day retention enforced by reaper (T11, separate task).
 *
 * Closes: G-A3 (SSOT-C), AD-08, NFR-09, AC-10, AC-30.
 */

import {
  appendFileSync,
  statSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { coreWarn as swWarn } from '@kiberos/signal-wire-core'
import {
  BOOT_AUDIT_PATH,
  SPAWN_AUDIT_PATH,
  AUDIT_ROTATION_BYTES,
} from '../domain-constants'

// ─── Row shapes (PRD §Audit Log Schemas — ADDITIVE-only evolution) ───────────

export interface BootAuditRow {
  ts: string                  // ISO-8601
  correlation_id: string      // 12-char from correlation-id.ts (REQUIRED — see CR-A3)
  pid: number
  member_id?: string          // null when not yet provisioned
  member_type: 'agent' | 'human'
  phase:
    | 'router-resolved'
    | 'identity-provisioned'
    | 'prompt-composed'
    | 'discovery-written'
    | 'bridge-disabled-by-env'  // when SW_AGENT_SPAWN=disabled
    | 'failed'
  duration_ms?: number
  error?: string
  error_class?: 'loud' | 'audited'
}

export interface SpawnAuditRow {
  ts: string                  // ISO-8601
  correlation_id: string      // REQUIRED
  parent_id: string           // SynqTask member_id of caller
  parent_role: string         // OrgRole.slug
  child_role: string          // OrgRole.slug
  child_id?: string           // present only when decision === 'spawned'
  depth: number               // 0 = root
  decision: 'spawned' | 'depth_exceeded' | 'quota_exceeded' | 'error'
  reason?: string
  prompt_layer_hashes?: {
    opencode_default: string
    org: string | null
    team: string | null
    role: string
    task_brief: string | null
  }
  error?: string
}

// ─── Rotation (AD-08) ─────────────────────────────────────────────────────────

function rotateIfNeeded(path: string): void {
  try {
    const st = statSync(path)
    if (st.size >= AUDIT_ROTATION_BYTES) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(path, `${path}.rotated-${stamp}`)
    }
  } catch (e: unknown) {
    // ENOENT (no file yet) is the happy path — no rotation needed.
    // Any other error: log it but DO NOT throw (CN-08 fail-open).
    if (e !== null && typeof e === 'object' && 'code' in e && (e as { code: string }).code !== 'ENOENT') {
      swWarn('AUDIT_ROTATION_FAILED', {
        path,
        error: e instanceof Error ? e.message : String(e),
        action: 'continuing to write to oversized file',
      })
    }
    // ENOENT path: SW-INTENTIONAL-SILENT: no file yet → nothing to rotate (happy path).
  }
}

// ─── Core write (fail-open per CN-08) ────────────────────────────────────────

function appendJsonl(path: string, row: object): void {
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateIfNeeded(path)
    appendFileSync(path, JSON.stringify(row) + '\n', 'utf8')
  } catch (e: unknown) {
    // CN-08 revised: never propagate audit-write failures to caller.
    // The audit-write itself can't write its OWN failure (would recurse) —
    // fall back to swWarn so it lands in signal-wire-debug.log.
    swWarn('AUDIT_WRITE_FAILED', {
      path,
      error: e instanceof Error ? e.message : String(e),
      row_preview: JSON.stringify(row).slice(0, 200),
    })
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export function appendBootAudit(row: BootAuditRow): void {
  appendJsonl(BOOT_AUDIT_PATH, row)
}

export function appendSpawnAudit(row: SpawnAuditRow): void {
  appendJsonl(SPAWN_AUDIT_PATH, row)
}

/**
 * Test/maintenance hook: list rotated files (used by reaper in T11 to apply
 * 30-day retention). Returns absolute paths, oldest-first (lexicographic on
 * ISO-derived suffix matches chronological order).
 */
export function listRotatedAuditFiles(basePath: string): string[] {
  try {
    const dir = dirname(basePath)
    const baseName = basename(basePath)
    if (!existsSync(dir)) return []
    const all = readdirSync(dir)
    const matches = all.filter((f) => f.startsWith(`${baseName}.rotated-`))
    matches.sort()
    return matches.map((f) => join(dir, f))
  } catch (e: unknown) {
    swWarn('AUDIT_LIST_ROTATED_FAILED', {
      basePath,
      error: e instanceof Error ? e.message : String(e),
    })
    return []
  }
}
