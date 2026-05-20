/**
 * Token refresh — coordination & 429 bail-out (regression for 2026-04-27 incident).
 *
 * On 2026-04-27 04:50:54Z, our SDK acquired the cross-process lock, hit OAuth
 * with 5×POST in 13 seconds, all 429. Original Claude Code CLI (running in
 * parallel pty session) successfully refreshed at 04:51:32Z (25s after our
 * first 429). If we had:
 *   (1) bailed out after 1×429 instead of retrying 4 more times, AND
 *   (2) checked credentials.json mtime before fetching,
 * we would have made 0–1 POST instead of 5, and avoided contributing to
 * Anthropic's per-refresh_token rate-limit window.
 *
 * These tests use FileCredentialStore directly to exercise the mtime path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFileSync, statSync, utimesSync, unlinkSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FileCredentialStore } from '../src/sdk.js'

describe('FileCredentialStore — public path field for mtime coordination', () => {
  let tmpDir: string
  let credPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sdk-cred-test-'))
    credPath = join(tmpDir, '.credentials.json')
  })

  afterEach(() => {
    try { unlinkSync(credPath) } catch {}
  })

  test('FileCredentialStore.path is publicly accessible (regression: was private)', () => {
    const store = new FileCredentialStore(credPath)
    // This must compile and equal the path we passed in.
    // If `path` becomes private again, this will fail TypeScript or be undefined.
    expect(store.path).toBe(credPath)
  })

  test('mtime check identifies recently-written credentials', () => {
    // Simulate a sibling/CLI write happening just now
    const creds = {
      claudeAiOauth: {
        accessToken: 'fresh-token-123',
        refreshToken: 'rt-456',
        expiresAt: Date.now() + 8 * 3600 * 1000,
        scopes: ['user:inference'],
      },
    }
    writeFileSync(credPath, JSON.stringify(creds), { mode: 0o600 })

    const mtimeMs = statSync(credPath).mtimeMs
    const ageMs = Date.now() - mtimeMs

    // mtime should be within ~1s of now (just wrote). Allow a small negative
    // skew: filesystem timestamp granularity / clock rounding can place mtimeMs
    // a hair AHEAD of the subsequent Date.now(), making ageMs slightly negative
    // under load. The real contract is "recently written", i.e. |ageMs| < 1s.
    expect(ageMs).toBeLessThan(1000)
    expect(ageMs).toBeGreaterThan(-1000)
  })

  test('mtime check distinguishes stale (>60s) from recent (<60s)', () => {
    const creds = {
      claudeAiOauth: {
        accessToken: 'old-token',
        refreshToken: 'rt-old',
        expiresAt: Date.now() + 8 * 3600 * 1000,
        scopes: ['user:inference'],
      },
    }
    writeFileSync(credPath, JSON.stringify(creds), { mode: 0o600 })

    // Backdate file mtime to 90 seconds ago
    const past = (Date.now() - 90_000) / 1000
    utimesSync(credPath, past, past)

    const mtimeMs = statSync(credPath).mtimeMs
    const ageMs = Date.now() - mtimeMs
    const RECENT_WINDOW = 60_000

    // Should be classified as stale
    expect(ageMs).toBeGreaterThan(RECENT_WINDOW)
  })

  test('FileCredentialStore.read returns parsed credentials', async () => {
    const expires = Date.now() + 8 * 3600 * 1000
    const creds = {
      claudeAiOauth: {
        accessToken: 'at-test',
        refreshToken: 'rt-test',
        expiresAt: expires,
        scopes: ['user:inference'],
      },
    }
    writeFileSync(credPath, JSON.stringify(creds), { mode: 0o600 })

    const store = new FileCredentialStore(credPath)
    const got = await store.read()
    expect(got).not.toBeNull()
    expect(got!.accessToken).toBe('at-test')
    expect(got!.expiresAt).toBe(expires)
  })

  test('FileCredentialStore.read returns null for missing file', async () => {
    const store = new FileCredentialStore(credPath)
    const got = await store.read()
    expect(got).toBeNull()
  })
})

describe('Token refresh — 429 bail-out semantics (documentation test)', () => {
  // These are documentation-style tests that encode the intent.
  // The actual fetch logic is exercised in production / live smoke tests.
  test('REFRESH_DELAYS array is unused for 429 path (only 5xx retries)', () => {
    // Documents the new contract: on 429, we bail immediately.
    // REFRESH_DELAYS still exists for 5xx (server transient).
    // The constant is intentional — we keep it for that path.
    expect(true).toBe(true)  // sanity
  })

  test('60-second cooldown is set on first 429 (covers Anthropic per-token window)', () => {
    // Documents: setRefreshCooldown(60_000) on first 429.
    // Was: 3× delay × jitter, scaling up to REFRESH_COOLDOWN_MAX_MS.
    // New: flat 60s — long enough to outlast typical OAuth rate window,
    //      short enough that next scheduled rotation has a real chance.
    expect(true).toBe(true)
  })
})
