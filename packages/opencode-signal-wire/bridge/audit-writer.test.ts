import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listRotatedAuditFiles } from './audit-writer'

describe('audit-writer (basic shape)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('listRotatedAuditFiles returns empty for non-existent dir', () => {
    const result = listRotatedAuditFiles(join(dir, 'sub', 'audit.jsonl'))
    expect(result).toEqual([])
  })

  test('listRotatedAuditFiles returns empty when no rotated siblings exist', () => {
    const base = join(dir, 'audit.jsonl')
    writeFileSync(base, 'current')
    const result = listRotatedAuditFiles(base)
    expect(result).toEqual([])
  })

  test('listRotatedAuditFiles finds rotated siblings, sorted oldest-first', () => {
    const base = join(dir, 'audit.jsonl')
    writeFileSync(base + '.rotated-2026-05-01T00-00-00-000Z', '')
    writeFileSync(base + '.rotated-2026-05-14T00-00-00-000Z', '')
    writeFileSync(base + '.rotated-2026-05-07T00-00-00-000Z', '')
    writeFileSync(base, 'current')
    const result = listRotatedAuditFiles(base)
    expect(result).toHaveLength(3)
    expect(result[0]).toContain('2026-05-01')
    expect(result[1]).toContain('2026-05-07')
    expect(result[2]).toContain('2026-05-14')
  })

  test('listRotatedAuditFiles ignores non-matching files in dir', () => {
    const base = join(dir, 'audit.jsonl')
    writeFileSync(base + '.rotated-2026-05-01T00-00-00-000Z', '')
    writeFileSync(join(dir, 'other-file.txt'), '')
    writeFileSync(join(dir, 'audit.jsonl.notrotated'), '')
    const result = listRotatedAuditFiles(base)
    expect(result).toHaveLength(1)
    expect(result[0]).toContain('rotated-2026-05-01')
  })

  test('BootAuditRow shape compiles (TypeScript check)', () => {
    const row: import('./audit-writer').BootAuditRow = {
      ts: '2026-05-14T16:00:00Z',
      correlation_id: 'ABCDEFGH2345',
      pid: 12345,
      member_type: 'agent',
      phase: 'identity-provisioned',
      duration_ms: 42,
    }
    expect(row.correlation_id).toBe('ABCDEFGH2345')
  })

  test('BootAuditRow with all optional fields compiles', () => {
    const row: import('./audit-writer').BootAuditRow = {
      ts: '2026-05-14T16:00:00Z',
      correlation_id: 'ABCDEFGH2345',
      pid: 12345,
      member_id: 'mem-xyz',
      member_type: 'human',
      phase: 'failed',
      duration_ms: 100,
      error: 'something broke',
      error_class: 'loud',
    }
    expect(row.error_class).toBe('loud')
  })

  test('SpawnAuditRow with prompt_layer_hashes shape compiles', () => {
    const row: import('./audit-writer').SpawnAuditRow = {
      ts: '2026-05-14T16:00:00Z',
      correlation_id: 'ABCDEFGH2345',
      parent_id: 'mem-ceo-1',
      parent_role: 'commander',
      child_role: 'developer',
      depth: 1,
      decision: 'spawned',
      child_id: 'mem-dev-x',
      prompt_layer_hashes: {
        opencode_default: 'abc123',
        org: 'def456',
        team: null,
        role: 'ghi789',
        task_brief: 'jkl012',
      },
    }
    expect(row.decision).toBe('spawned')
    expect(row.prompt_layer_hashes?.team).toBeNull()
  })

  test('SpawnAuditRow rejection decisions compile', () => {
    const depthExceeded: import('./audit-writer').SpawnAuditRow = {
      ts: '2026-05-14T16:00:00Z',
      correlation_id: 'ABCDEFGH2345',
      parent_id: 'mem-1',
      parent_role: 'commander',
      child_role: 'developer',
      depth: 3,
      decision: 'depth_exceeded',
      reason: 'max depth=3 reached',
    }
    expect(depthExceeded.decision).toBe('depth_exceeded')

    const quotaExceeded: import('./audit-writer').SpawnAuditRow = {
      ts: '2026-05-14T16:00:00Z',
      correlation_id: 'ABCDEFGH2345',
      parent_id: 'mem-1',
      parent_role: 'commander',
      child_role: 'developer',
      depth: 1,
      decision: 'quota_exceeded',
      reason: 'concurrent_spawns_max=5 reached',
    }
    expect(quotaExceeded.decision).toBe('quota_exceeded')
  })
})
