/**
 * org-identity — unit tests.
 *
 * Covers the pure config reader (`readOrgIdFromConfig`) and the TTL-cached
 * default resolver (`FileOrgIdResolver`). The org-id this produces is the
 * stable identity the rewrite guard compares to catch a cross-org cache
 * replay — so "never throws" and "TTL actually caches" are load-bearing.
 */

import { describe, test, expect } from 'bun:test'
import { writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readOrgIdFromConfig, FileOrgIdResolver } from '../src/org-identity.js'

function tmpConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'org-id-'))
  const path = join(dir, '.claude.json')
  writeFileSync(path, contents)
  return path
}

describe('readOrgIdFromConfig', () => {
  test('extracts oauthAccount.organizationUuid', () => {
    const p = tmpConfig(JSON.stringify({
      oauthAccount: { organizationUuid: 'org-abc', accountUuid: 'acc-1' },
    }))
    expect(readOrgIdFromConfig(p)).toBe('org-abc')
    rmSync(p, { force: true })
  })

  test('missing file → null (unknown org, never throws)', () => {
    expect(readOrgIdFromConfig('/no/such/path/.claude.json')).toBeNull()
  })

  test('malformed JSON → null', () => {
    const p = tmpConfig('{not json')
    expect(readOrgIdFromConfig(p)).toBeNull()
    rmSync(p, { force: true })
  })

  test('no oauthAccount → null', () => {
    const p = tmpConfig(JSON.stringify({ theme: 'dark' }))
    expect(readOrgIdFromConfig(p)).toBeNull()
    rmSync(p, { force: true })
  })

  test('organizationUuid present but not a string → null', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: 123 } }))
    expect(readOrgIdFromConfig(p)).toBeNull()
    rmSync(p, { force: true })
  })

  test('empty-string organizationUuid → null', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: '' } }))
    expect(readOrgIdFromConfig(p)).toBeNull()
    rmSync(p, { force: true })
  })
})

describe('FileOrgIdResolver', () => {
  test('reads the org-id from its config path', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: 'org-A' } }))
    const r = new FileOrgIdResolver(p, 60_000)
    expect(r.current()).toBe('org-A')
    rmSync(p, { force: true })
  })

  test('TTL caches the read — a same-window file change is NOT seen', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: 'org-A' } }))
    const r = new FileOrgIdResolver(p, 60_000)            // 60s TTL
    expect(r.current()).toBe('org-A')
    writeFileSync(p, JSON.stringify({ oauthAccount: { organizationUuid: 'org-B' } }))
    expect(r.current()).toBe('org-A')                     // still cached
    rmSync(p, { force: true })
  })

  test('TTL=0 → every call re-reads (picks up an org switch immediately)', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: 'org-A' } }))
    const r = new FileOrgIdResolver(p, 0)                 // no caching
    expect(r.current()).toBe('org-A')
    writeFileSync(p, JSON.stringify({ oauthAccount: { organizationUuid: 'org-B' } }))
    expect(r.current()).toBe('org-B')
    rmSync(p, { force: true })
  })

  test('missing config → null, never throws', () => {
    const r = new FileOrgIdResolver('/no/such/.claude.json', 60_000)
    expect(() => r.current()).not.toThrow()
    expect(r.current()).toBeNull()
  })

  test('invalidate() forces a re-read before the TTL elapses', () => {
    const p = tmpConfig(JSON.stringify({ oauthAccount: { organizationUuid: 'org-A' } }))
    const r = new FileOrgIdResolver(p, 300_000)           // 5-min TTL
    expect(r.current()).toBe('org-A')
    writeFileSync(p, JSON.stringify({ oauthAccount: { organizationUuid: 'org-B' } }))
    expect(r.current()).toBe('org-A')                     // still cached (TTL not elapsed)
    r.invalidate()
    expect(r.current()).toBe('org-B')                     // re-read after invalidate
    rmSync(p, { force: true })
  })
})
