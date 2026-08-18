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
import { checkDeployDrift, resolveInstallDir } from '../src/deploy-drift.js'

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

/**
 * resolveInstallDir — 2026-08-18.
 *
 * The drift check had been blind for its entire life under the binary runtime:
 * it looked for the manifest next to `import.meta.dir`, which inside a compiled
 * binary is a virtual path with nothing on disk. Every start emitted "no deploy
 * manifest — deployed by hand?" — including starts made BY deploy-from-source.sh
 * moments after it wrote that manifest. The check that exists to say what is
 * running was answering from a directory that does not exist, in a calm voice.
 */
describe('resolveInstallDir: find the manifest from wherever the process runs', () => {
  test('a binary at <install>/bin/<name> resolves to <install>', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-bin-'))
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, '.deploy-manifest.json'), JSON.stringify({ files: {} }))
    const realExec = process.execPath
    Object.defineProperty(process, 'execPath', { value: join(dir, 'bin', 'claude-max-proxy'), configurable: true })
    try {
      expect(resolveInstallDir('/nonexistent/fallback')).toBe(dir)
    } finally {
      Object.defineProperty(process, 'execPath', { value: realExec, configurable: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('running from source falls back to the caller-supplied dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-src-'))
    writeFileSync(join(dir, '.deploy-manifest.json'), JSON.stringify({ files: {} }))
    expect(resolveInstallDir(dir)).toBe(dir)
    rmSync(dir, { recursive: true, force: true })
  })

  test('an explicit override wins over the binary location', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drift-env-'))
    writeFileSync(join(dir, '.deploy-manifest.json'), JSON.stringify({ files: {} }))
    process.env.CLAUDE_MAX_PROXY_INSTALL_DIR = dir
    try {
      expect(resolveInstallDir('/nonexistent/fallback')).toBe(dir)
    } finally {
      delete process.env.CLAUDE_MAX_PROXY_INSTALL_DIR
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('no manifest anywhere → the fallback is returned, not an invented path', () => {
    expect(resolveInstallDir('/nonexistent/fallback')).toBe('/nonexistent/fallback')
  })
})
