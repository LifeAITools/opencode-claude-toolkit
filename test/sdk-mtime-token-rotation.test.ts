/**
 * Regression test for Defect 1 (token rotation visibility) — completed fix.
 *
 * Bug: long-lived processes pinned to OLD-org token even when user did
 *      `claude /login` to switch orgs. Symptom verified 2026-04-30T19:43Z:
 *      pid 3964910 used `sk-ant-oat01-e2QfoE17R...` for 11+ minutes after
 *      credentials.json was rewritten with new token, burning OLD-org
 *      quota at util5h=1.0 critical.
 *
 * Root cause: `ensureAuth()` fast path returned the in-memory token
 *      immediately if not expired, never checking disk mtime. The mtime
 *      check existed only in `_doEnsureAuth()` which ran on token expiry.
 *
 * Fix: pre-fast-path `credentialStore.hasChanged()` mtime check that
 *      drops the in-memory token and forces re-load when credentials.json
 *      is modified mid-session.
 *
 * This test exercises the FileCredentialStore mtime detection path
 * (the only store that implements hasChanged today).
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, statSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileCredentialStore } from '../src/sdk.js'

describe('FileCredentialStore mtime-based change detection', () => {
  let dir: string
  let credPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-mtime-'))
    credPath = join(dir, '.credentials.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('hasChanged returns false on stable file', async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-OLD-token',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 3600_000,
      },
    }))
    const store = new FileCredentialStore(credPath)
    // Initial read seeds lastMtimeMs
    await store.read()
    // Without modification, hasChanged should be false
    expect(await store.hasChanged()).toBe(false)
    expect(await store.hasChanged()).toBe(false)
  })

  test('hasChanged returns true once after disk overwrite', async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-OLD-token',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 3600_000,
      },
    }))
    const store = new FileCredentialStore(credPath)
    const oldCreds = await store.read()
    expect(oldCreds?.accessToken).toBe('sk-ant-oat01-OLD-token')

    // Simulate `claude /login` — external rewrite. Bump mtime explicitly
    // because writes within the same millisecond may not change mtime.
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-NEW-token',
        refreshToken: 'rt-new',
        expiresAt: Date.now() + 3600_000,
      },
    }))
    const future = new Date(Date.now() + 5000)
    utimesSync(credPath, future, future)

    // First call returns true (mtime changed)
    expect(await store.hasChanged()).toBe(true)
    // Second call returns false (we already saw this mtime)
    expect(await store.hasChanged()).toBe(false)

    // Re-read picks up new token
    const newCreds = await store.read()
    expect(newCreds?.accessToken).toBe('sk-ant-oat01-NEW-token')
  })

  test('hasChanged returns false if file goes missing', async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-token',
        refreshToken: 'rt',
        expiresAt: Date.now() + 3600_000,
      },
    }))
    const store = new FileCredentialStore(credPath)
    await store.read()
    rmSync(credPath)
    // Missing file → mtime=0, will be different from lastMtimeMs;
    // returns true once, then stays false.
    const first = await store.hasChanged()
    const second = await store.hasChanged()
    expect(first).toBe(true)
    expect(second).toBe(false)
  })

  test('repeated rotations each detected', async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: 'v1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    }))
    const store = new FileCredentialStore(credPath)
    await store.read()

    for (let i = 2; i <= 5; i++) {
      writeFileSync(credPath, JSON.stringify({
        claudeAiOauth: { accessToken: `v${i}`, refreshToken: `r${i}`, expiresAt: Date.now() + 3600_000 },
      }))
      const future = new Date(Date.now() + i * 1000)
      utimesSync(credPath, future, future)

      expect(await store.hasChanged()).toBe(true)
      expect(await store.hasChanged()).toBe(false)
      expect((await store.read())?.accessToken).toBe(`v${i}`)
    }
  })
})
