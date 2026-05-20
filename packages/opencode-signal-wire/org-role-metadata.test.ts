import { describe, test, expect } from 'bun:test'
import { readOrgRoleMetadata, BRIDGE_METADATA_SCHEMA_VERSION } from './org-role-metadata'

describe('readOrgRoleMetadata', () => {
  test('empty object → empty result', () => {
    expect(readOrgRoleMetadata({})).toEqual({})
  })

  test('null/undefined/array → empty result (no throw)', () => {
    expect(readOrgRoleMetadata(null)).toEqual({})
    expect(readOrgRoleMetadata(undefined)).toEqual({})
    expect(readOrgRoleMetadata([1, 2, 3])).toEqual({})
    expect(readOrgRoleMetadata('not an object')).toEqual({})
  })

  test('valid spawn_depth_max → preserved', () => {
    expect(readOrgRoleMetadata({ spawn_depth_max: 5 })).toEqual({ spawn_depth_max: 5 })
  })

  test('invalid spawn_depth_max type → omitted (safe default applies downstream)', () => {
    expect(readOrgRoleMetadata({ spawn_depth_max: '5' as unknown as number })).toEqual({})
  })

  test('all valid fields → all preserved', () => {
    const result = readOrgRoleMetadata({
      spawn_depth_max: 5,
      concurrent_spawns_max: 10,
      auto_run: true,
      team_prompt_id: 'team-eng-platform',
      metadata_schema_version: 1,
    })
    expect(result).toEqual({
      spawn_depth_max: 5,
      concurrent_spawns_max: 10,
      auto_run: true,
      team_prompt_id: 'team-eng-platform',
      metadata_schema_version: 1,
    })
  })

  test('schema_version too new → field preserved but downstream should treat unknown fields as defaults (WARN logged)', () => {
    const result = readOrgRoleMetadata({ metadata_schema_version: 999 })
    expect(result.metadata_schema_version).toBe(999)
  })

  test('negative spawn_depth_max → omitted', () => {
    expect(readOrgRoleMetadata({ spawn_depth_max: -1 })).toEqual({})
  })

  test('mixed valid + invalid → only valid retained', () => {
    const result = readOrgRoleMetadata({
      spawn_depth_max: 4,
      concurrent_spawns_max: 'bad' as unknown as number,
      auto_run: true,
    })
    expect(result).toEqual({ spawn_depth_max: 4, auto_run: true })
  })

  test('BRIDGE_METADATA_SCHEMA_VERSION is exported as positive integer', () => {
    expect(BRIDGE_METADATA_SCHEMA_VERSION).toBeGreaterThanOrEqual(1)
    expect(Number.isInteger(BRIDGE_METADATA_SCHEMA_VERSION)).toBe(true)
  })
})
