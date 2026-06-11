/**
 * getAccessToken — credentials-file coherence.
 *
 * A cached token must die the moment the credentials file changes on disk —
 * `claude login` to ANOTHER org rotates the file via atomic rename, and a
 * cache keyed only on token expiry kept serving the previous org's token for
 * hours (2026-06-11 incident: fs.watch had died after the first rename-over,
 * stale f9420373 token served while disk held b3219c9b → 37 ORG_SERVED_MISMATCH
 * alerts + the wrong org's 5h quota window burned to 429). Per-request mtime
 * coherence is the correctness layer; the daemon's fs.watch is just latency.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, writeFileSync, renameSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getAccessToken, invalidateTokenCache } from '../src/upstream.js'
import type { ProxyConfig } from '../src/config.js'

const TMP = mkdtempSync(join(tmpdir(), 'tok-cache-'))
const credsPath = join(TMP, '.credentials.json')
const cfg = { credentialsPath: credsPath } as ProxyConfig

/** Rotate the credentials file exactly the way `claude login` does: write a
 *  temp file, atomic rename over the target. mtime pinned explicitly so two
 *  rotations within the same millisecond still differ. */
function rotateCreds(token: string, mtimeSec: number, expiresInMs = 8 * 3600_000) {
  const tmp = credsPath + '.tmp'
  writeFileSync(tmp, JSON.stringify({
    claudeAiOauth: { accessToken: token, expiresAt: Date.now() + expiresInMs },
  }))
  renameSync(tmp, credsPath)
  utimesSync(credsPath, mtimeSec, mtimeSec)
}

describe('getAccessToken — credentials-file coherence', () => {
  beforeEach(() => invalidateTokenCache())

  test('serves the cached token while the file is unchanged', async () => {
    rotateCreds('token-org-A', 1_700_000_000)
    expect(await getAccessToken(cfg)).toBe('token-org-A')
    expect(await getAccessToken(cfg)).toBe('token-org-A')
  })

  test('atomic rename-over (cross-org login) is picked up on the NEXT call — no invalidate, no watcher', async () => {
    rotateCreds('token-org-A', 1_700_000_000)
    expect(await getAccessToken(cfg)).toBe('token-org-A')

    // Cross-org login rotates the file. Nobody calls invalidateTokenCache():
    // the dead-fs.watch scenario. The cache MUST notice via mtime.
    rotateCreds('token-org-B', 1_700_000_010)
    expect(await getAccessToken(cfg)).toBe('token-org-B')
  })

  test('same-content refresh with a new mtime re-reads without error', async () => {
    rotateCreds('token-org-A', 1_700_000_000)
    expect(await getAccessToken(cfg)).toBe('token-org-A')
    rotateCreds('token-org-A', 1_700_000_020)
    expect(await getAccessToken(cfg)).toBe('token-org-A')
  })
})
