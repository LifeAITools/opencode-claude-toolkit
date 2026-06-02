/**
 * proxy-adapters — FileCredentialsProvider unit tests.
 *
 * Focus: currentExpiresAt() — the per-session pin needs the cached token's
 * expiry to decide whether a held cross-org token is still alive.
 */

import { describe, test, expect } from 'bun:test'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileCredentialsProvider } from '../src/proxy-adapters.js'

function tmpCreds(expiresAt: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'))
  const p = join(dir, '.credentials.json')
  writeFileSync(p, JSON.stringify({
    claudeAiOauth: { accessToken: 'tok', expiresAt, refreshToken: 'r', scopes: [] },
  }))
  return p
}

describe('FileCredentialsProvider.currentExpiresAt', () => {
  test('returns the stored expiry after a token read', async () => {
    const exp = Date.now() + 3_600_000
    const p = tmpCreds(exp)
    const cp = new FileCredentialsProvider({ path: p })
    await cp.getAccessToken()
    expect(cp.currentExpiresAt()).toBe(exp)
    rmSync(p, { force: true })
  })

  test('returns null when no token is cached yet', () => {
    const cp = new FileCredentialsProvider({ path: '/no/such/.credentials.json' })
    expect(cp.currentExpiresAt()).toBeNull()
  })

  test('returns null after invalidate()', async () => {
    const p = tmpCreds(Date.now() + 3_600_000)
    const cp = new FileCredentialsProvider({ path: p })
    await cp.getAccessToken()
    cp.invalidate()
    expect(cp.currentExpiresAt()).toBeNull()
    rmSync(p, { force: true })
  })
})
