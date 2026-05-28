/**
 * deploy-drift — unit tests. This is a safety mechanism (it's what would have
 * caught the silent server.ts hand-edit that killed the quota pipeline), so its
 * happy AND drift paths are tested.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { checkDeployDrift } from '../src/deploy-drift.js'

let dir: string
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function writeManifest(files: Record<string, string>) {
  writeFileSync(join(dir, '.deploy-manifest.json'), JSON.stringify({
    deployedAt: '2026-05-28T10:00:00Z', sourceCommit: 'abc1234',
    files: Object.fromEntries(Object.entries(files).map(([rel, content]) => [rel, sha(content)])),
  }))
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'drift-'))
  mkdirSync(join(dir, 'src'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('checkDeployDrift', () => {
  test('clean: live files match manifest → no drift', () => {
    writeFileSync(join(dir, 'src', 'server.ts'), 'A')
    writeFileSync(join(dir, 'src', 'config.ts'), 'B')
    writeManifest({ 'src/server.ts': 'A', 'src/config.ts': 'B' })
    const r = checkDeployDrift(dir)
    expect(r.manifestMissing).toBe(false)
    expect(r.drifted).toEqual([])
    expect(r.sourceCommit).toBe('abc1234')
  })

  test('hand-edited file → reported as drifted', () => {
    writeFileSync(join(dir, 'src', 'server.ts'), 'A-EDITED') // differs from manifest 'A'
    writeFileSync(join(dir, 'src', 'config.ts'), 'B')
    writeManifest({ 'src/server.ts': 'A', 'src/config.ts': 'B' })
    const r = checkDeployDrift(dir)
    expect(r.drifted).toEqual(['src/server.ts'])
  })

  test('deleted file → reported as missing', () => {
    writeFileSync(join(dir, 'src', 'config.ts'), 'B')
    writeManifest({ 'src/server.ts': 'A', 'src/config.ts': 'B' }) // server.ts never written
    const r = checkDeployDrift(dir)
    expect(r.drifted).toContain('src/server.ts (missing)')
  })

  test('no manifest → manifestMissing (hand-deployed)', () => {
    const r = checkDeployDrift(dir)
    expect(r.manifestMissing).toBe(true)
    expect(r.drifted).toEqual([])
  })
})
