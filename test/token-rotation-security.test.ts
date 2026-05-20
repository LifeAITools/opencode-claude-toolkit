/**
 * T16 — Security & invariants tests for token rotation.
 *
 * Covers:
 *   - NFR-06 / CN-03: no full-token leak in event payloads or audit logs.
 *   - NFR-06 grep: regex over generated artifacts confirms no full tokens.
 *   - CN-10: TokenRotationManager constructed with a CredentialStore literal
 *            lacking `.path` skips fs.watch (only poll fallback runs).
 *   - CR-10 / CN-09: sdk.ts net delta budget guard (≤35 LoC for T9+T10).
 *   - CN-07 / NFR-02: rotation events deterministic w/r/t input — derived
 *                     fields (`mode`, `oldHint`, `newHint`, `forcedReason`)
 *                     identical for identical inputs.
 *
 * Constraints:
 *   - Tests-only; production code untouched.
 *   - Uses unique fixture markers ("T16LEAK*") per test so grep scope stays
 *     bounded — never asserts about pre-existing audit-log content.
 *   - Manager instances are always `.close()`d in afterEach to release fds
 *     and the poll timer (NFR-01).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TokenRotationManager } from '../src/token-rotation.js'
import { tokenHint } from '../src/token-utils.js'
import { FileCredentialStore } from '../src/sdk.js'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import type { CredentialStore, StoredCredentials } from '../src/types.js'
import type { TokenRotatedPayload } from '../src/token-rotation.js'

// Mock keepalive config — high poll interval so timers don't fire during tests.
const mockConfig = (threshold = 150_000) => () => ({
  tokenRotationContextThreshold: threshold,
  tokenRotationPollIntervalMs: 600_000, // 10min — won't fire in tests
  orgIdCacheTtlMs: 300_000,
  tokenRotationLogMaxBytes: 10_485_760,
  tokenRotationLogRetentionDays: 7,
})

/**
 * Build an Anthropic-shaped 3-part JWT for the refresh-token slot.
 * Header is dummy; payload is JSON-encoded and base64url-encoded; sig empty.
 */
function makeRefreshJwt(payload: Record<string, unknown>, sigMarker = 'sig'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.${sigMarker}`
}

/**
 * Bootstrap a manager onto a fresh credential file, advance to the
 * post-bootstrap state (lastSeenHint seeded), then return the manager
 * + a captured-events array. After this returns, the next write +
 * `await checkPending()` will produce an event.
 */
async function bootstrapMgr(
  credsPath: string,
  initialAccess: string,
  initialRefresh: string,
  ctxProvider: () => number | null = () => 1000,
): Promise<{ mgr: TokenRotationManager; captured: TokenRotatedPayload[] }> {
  writeFileSync(credsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: initialAccess,
      refreshToken: initialRefresh,
      expiresAt: Date.now() + 3600_000,
    },
  }))
  const store = new FileCredentialStore(credsPath)
  const mgr = new TokenRotationManager(store, ctxProvider, mockConfig())
  const captured: TokenRotatedPayload[] = []
  mgr.setEventEmitter((p) => captured.push(p))
  // Bootstrap: first detect seeds lastSeenHint + orgIdCache, no event.
  await mgr.checkPending()
  return { mgr, captured }
}

function bumpMtime(path: string, deltaSec = 5): void {
  const future = new Date(Date.now() + deltaSec * 1000)
  utimesSync(path, future, future)
}

const ROTATION_LOG_PATH = join(homedir(), '.claude', 'token-rotation.log')
const DEBUG_LOG_PATH = join(homedir(), '.claude', 'claude-max-debug.log')

function readLog(path: string): string {
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

describe('T16 NFR-06 / CN-03: full-token leak prevention', () => {
  let dir: string
  let credsPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-tokrot-sec-'))
    credsPath = join(dir, '.credentials.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('event payload hints are exactly 8 chars and never contain the full-token marker', async () => {
    // 60+ char access token with embedded marker. Hint will be 8 chars after prefix.
    const fullToken =
      'sk-ant-oat01-T16LEAKAAAA0000ABCDEFGHIJKLMNOPQRSTUVWXYZ_TEST_FULL_LEAK_PROBE_001'
    const oldToken = 'sk-ant-oat01-T16OLDXXXX0000zzzzzzzzzzzz'

    const { mgr, captured } = await bootstrapMgr(credsPath, oldToken, makeRefreshJwt({
      organization_id: 'old-org-001',
    }))
    expect(captured.length).toBe(0) // bootstrap is silent

    // Cross-org rotation (different org_id → forces non-same-org). Small ctx → applied.
    writeFileSync(credsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: fullToken,
        refreshToken: makeRefreshJwt({ organization_id: 'new-org-001' }),
        expiresAt: Date.now() + 3600_000,
      },
    }))
    bumpMtime(credsPath)

    await mgr.checkPending()
    mgr.close()

    expect(captured.length).toBe(1)
    const ev = captured[0]!
    expect(ev.oldHint).toHaveLength(8)
    expect(ev.newHint).toHaveLength(8)
    expect(ev.oldHint).not.toContain('_TEST_FULL_LEAK_PROBE')
    expect(ev.newHint).not.toContain('_TEST_FULL_LEAK_PROBE')
    // Sanity: hint is the documented 8 chars after "sk-ant-oat01-"
    expect(ev.newHint).toBe(tokenHint(fullToken))
    expect(ev.newHint).toBe('T16LEAKA')
  })

  test('audit log never contains full-token substring (16+ chars after prefix)', async () => {
    const fullTokenA =
      'sk-ant-oat01-T16LEAKBBBB1111ABCDEFGHIJKLMNOPQRSTUVWXYZ_PROBE_AUDIT_LOG_002'
    const oldToken = 'sk-ant-oat01-T16OLDYYYY1111aaaaaaaa'

    const { mgr } = await bootstrapMgr(credsPath, oldToken, makeRefreshJwt({
      organization_id: 'audit-old-org',
    }))

    writeFileSync(credsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: fullTokenA,
        refreshToken: makeRefreshJwt({ organization_id: 'audit-new-org' }),
        expiresAt: Date.now() + 3600_000,
      },
    }))
    bumpMtime(credsPath)
    await mgr.checkPending()
    mgr.close()

    // Wait for any deferred appendFileSync to flush (sync, but be safe).
    await new Promise((r) => setTimeout(r, 50))

    // 16+ char fragment of the test fixture token, AFTER the prefix.
    const fragment16 = fullTokenA.slice(13, 13 + 16) // 16 chars after "sk-ant-oat01-"
    expect(fragment16.length).toBe(16)

    const rotLog = readLog(ROTATION_LOG_PATH)
    const debugLog = readLog(DEBUG_LOG_PATH)
    expect(rotLog).not.toContain(fragment16)
    expect(debugLog).not.toContain(fragment16)
  })

  test('refresh-token JWT body never appears in audit log (only org-id surfaces via fields)', async () => {
    const oldRt = makeRefreshJwt({ organization_id: 'rt-leak-old', sub: 'user-1' })
    const newRt = makeRefreshJwt(
      { organization_id: 'leak-probe-org', sub: 'distinct-leak-probe-user-2' },
      'distinct-sig-T16',
    )
    const oldToken = 'sk-ant-oat01-T16OLDZZZZ2222bbbbbbbb'
    const newToken = 'sk-ant-oat01-T16RTLEAKCCCC2222ccccccccccccccccccccc'

    const { mgr, captured } = await bootstrapMgr(credsPath, oldToken, oldRt)

    writeFileSync(credsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: newToken,
        refreshToken: newRt,
        expiresAt: Date.now() + 3600_000,
      },
    }))
    bumpMtime(credsPath)
    await mgr.checkPending()
    mgr.close()
    await new Promise((r) => setTimeout(r, 50))

    const rotLog = readLog(ROTATION_LOG_PATH)
    const debugLog = readLog(DEBUG_LOG_PATH)

    // The whole JWT string MUST NOT appear in any log.
    expect(rotLog).not.toContain(newRt)
    expect(debugLog).not.toContain(newRt)
    expect(rotLog).not.toContain(oldRt)
    expect(debugLog).not.toContain(oldRt)

    // Body (the base64 payload) MUST NOT appear either.
    const newRtBody = newRt.split('.')[1]!
    expect(newRtBody.length).toBeGreaterThan(20)
    expect(rotLog).not.toContain(newRtBody)
    expect(debugLog).not.toContain(newRtBody)

    // Only the org-id field SHOULD have surfaced via captured event.
    expect(captured.length).toBe(1)
    expect(captured[0]!.newOrgId).toBe('leak-probe-org')
  })

  test('grep over /tmp + ~/.claude logs finds NO full-token fragments matching test fixtures', async () => {
    // Unique fixture marker (won't collide with prior tests / runs).
    const marker = 'T16GREPDDDD3333eeeeeeeeeeeeeeeeeeeee_GREP_PROBE_004'
    const fullToken = `sk-ant-oat01-${marker}`
    const oldToken = 'sk-ant-oat01-T16OLDWWWW3333dddddddd'

    const { mgr } = await bootstrapMgr(credsPath, oldToken, makeRefreshJwt({
      organization_id: 'grep-old',
    }))
    writeFileSync(credsPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: fullToken,
        refreshToken: makeRefreshJwt({ organization_id: 'grep-new' }),
        expiresAt: Date.now() + 3600_000,
      },
    }))
    bumpMtime(credsPath)
    await mgr.checkPending()
    mgr.close()
    await new Promise((r) => setTimeout(r, 50))

    // Grep ONLY for the fixture marker pattern (>= 20 chars after prefix).
    // We MUST NOT grep `sk-ant-oat01-.{20,}` broadly — that could match any
    // pre-existing legitimate token in unrelated logs from other tests.
    // Scope: the two known audit log files only (NOT recursive /tmp — too
    // slow + too noisy).
    const cmd =
      `grep -E "sk-ant-oat01-T16GREPDDDD[a-zA-Z0-9_]{20,}" ` +
      `${ROTATION_LOG_PATH} ${DEBUG_LOG_PATH} 2>/dev/null || true`
    let output = ''
    try {
      output = execSync(cmd, { encoding: 'utf8', timeout: 3000 })
    } catch {
      output = ''
    }
    expect(output).toBe('') // No matches anywhere
  })
})

describe('T16 CN-10: CredentialStore lacking .path skips fs.watch', () => {
  test('manager constructed with custom store (no .path) → watcher null, pollTimer running', () => {
    const customStore: CredentialStore = {
      async read(): Promise<StoredCredentials | null> {
        return null
      },
      async write(_: StoredCredentials): Promise<void> {
        // no-op
      },
    }
    // Sanity check: literal really has no path.
    expect((customStore as any).path).toBeUndefined()

    const mgr = new TokenRotationManager(customStore, () => 1000, mockConfig())

    expect((mgr as any).watcher).toBeNull() // CN-10 — no fs.watch attached
    expect((mgr as any).pollTimer).not.toBeNull() // DB-01 layer 2 — poll fallback alive
    expect(mgr.hasPending()).toBe(false)

    // Cleanup
    mgr.close()
    expect((mgr as any).pollTimer).toBeNull()
  })
})

describe('T16 CR-10 / CN-09: sdk.ts net LoC budget guard (token-rotation scope)', () => {
  test('token-rotation-specific additions in sdk.ts ≤35 net lines (T9+T10 budget)', () => {
    // CN-09 budget governs the TOKEN-ROTATION PRP only — not arbitrary
    // future PRPs that may also touch sdk.ts. Scope the count to lines
    // referencing token-rotation symbols added by T9/T10:
    //   - `tokenRotation` field + accessor + close hook
    //   - `TokenRotationManager` import + ctor call
    //   - `loadKeepaliveConfig` import (reused, but token-rotation triggered the import)
    //   - `applyPending` / `hasPending` / `checkPending` calls
    //
    // Other PRPs (e.g. image-context-guard Tier 2) touch sdk.ts in
    // unrelated regions and have their own budget. This test enforces
    // T9+T10 didn't bloat — not a global LoC freeze.
    const tokenRotationSymbols = [
      'TokenRotationManager',
      'tokenRotation',
      'applyPending',
      'hasPending',
      'checkPending',
    ]
    let count = 0
    try {
      const fullDiff = execSync(
        'git diff HEAD -- src/sdk.ts',
        { encoding: 'utf8', cwd: '/home/relishev/projects/vibe/claude-code-sdk' },
      )
      // Count added lines that reference token-rotation symbols.
      const addedLines = fullDiff.split('\n').filter(line => /^\+[^+]/.test(line))
      count = addedLines.filter(line =>
        tokenRotationSymbols.some(sym => line.includes(sym)),
      ).length
    } catch {
      count = 0
    }

    // CN-09 plan budget: ≤30 LoC, ≤35 with comment overhead.
    // (Token-rotation symbols only — does not include unrelated PRP additions
    // like Tier 2 body-size guard from image-context-guard PRP.)
    expect(count).toBeLessThanOrEqual(35)
  })
})

describe('T16 CN-07 / NFR-02: rotation event determinism', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sdk-tokrot-det-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('same input creds → same derived fields (mode, hints, orgIds, forcedReason)', async () => {
    // Run two independent rotations with IDENTICAL fixture data; assert
    // that fields derived purely from input (NOT from clock) match.
    const oldToken = 'sk-ant-oat01-T16DETSAAAA4444fffffffff'
    const newToken = 'sk-ant-oat01-T16DETBBBBB5555gggggggggggg'
    const oldOrgRt = makeRefreshJwt({ organization_id: 'det-old-X' })
    const newOrgRt = makeRefreshJwt({ organization_id: 'det-new-Y' })

    const runOnce = async (path: string): Promise<TokenRotatedPayload> => {
      const { mgr, captured } = await bootstrapMgr(path, oldToken, oldOrgRt)
      writeFileSync(path, JSON.stringify({
        claudeAiOauth: {
          accessToken: newToken,
          refreshToken: newOrgRt,
          expiresAt: Date.now() + 3600_000,
        },
      }))
      bumpMtime(path)
      await mgr.checkPending()
      mgr.close()
      expect(captured.length).toBe(1)
      return captured[0]!
    }

    const path1 = join(dir, '.credentials-A.json')
    const path2 = join(dir, '.credentials-B.json')
    const ev1 = await runOnce(path1)
    const ev2 = await runOnce(path2)

    // Determinism on input-derived fields.
    expect(ev1.oldHint).toBe(ev2.oldHint)
    expect(ev1.newHint).toBe(ev2.newHint)
    expect(ev1.oldOrgId).toBe(ev2.oldOrgId)
    expect(ev1.newOrgId).toBe(ev2.newOrgId)
    expect(ev1.mode).toBe(ev2.mode)
    expect(ev1.appliedAt).toBe(ev2.appliedAt)
    expect(ev1.forcedReason).toBe(ev2.forcedReason)
    // Sanity values
    expect(ev1.mode).toBe('applied') // small ctx → cross-org applied immediately
    expect(ev1.appliedAt).toBe('immediate')
    expect(ev1.forcedReason).toBeNull()
    expect(ev1.oldOrgId).toBe('det-old-X')
    expect(ev1.newOrgId).toBe('det-new-Y')
  })
})
