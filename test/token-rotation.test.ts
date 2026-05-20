/**
 * Unit tests for TokenRotationManager state machine (PRP token-rotation-deferred-apply, T14).
 *
 * Covers all 8 detectRotation paths + tokenHint helper + applyPending + checkPending
 * routing + JWT extraction + org-id cache TTL + close() lifecycle + non-FileCredentialStore
 * compatibility (CN-10).
 *
 * Test fixture token hints (used to filter our entries from the shared
 * ~/.claude/token-rotation.log on cleanup) — DO NOT use real prefixes:
 *   AAAAAAAA  — bootstrap / oldHint
 *   BBBBBBBB  — first rotation target
 *   CCCCCCCC  — second rotation / synthetic third hint
 *   DDDDDDDD  — fourth-step / forced cases
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { TokenRotationManager } from '../src/token-rotation'
import type { TokenRotatedPayload } from '../src/token-rotation'
import { tokenHint } from '../src/token-utils'
import { FileCredentialStore, MemoryCredentialStore } from '../src/sdk'
import type { CredentialStore, StoredCredentials } from '../src/types'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────

/** Build a minimal JWT (`header.payload.sig`) carrying an organization_id. Pass null for missing field. */
function jwt(orgId: string | null): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify(orgId === null ? {} : { organization_id: orgId }),
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

/** Standard config factory — threshold tunable per-test. */
const mockConfig = (threshold = 150000) => () => ({
  tokenRotationContextThreshold: threshold,
  tokenRotationPollIntervalMs: 30000,
  orgIdCacheTtlMs: 300000,
  tokenRotationLogMaxBytes: 10485760,
  tokenRotationLogRetentionDays: 7,
})

interface StoreFixture {
  store: FileCredentialStore
  path: string
}

/** Build a fresh FileCredentialStore on disk with given access + refresh tokens. */
function makeStore(accessToken: string, refreshToken: string): StoreFixture {
  const path = join(
    tmpdir(),
    `token-rotation-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3600000 },
    }),
  )
  return { store: new FileCredentialStore(path), path }
}

/** Rewrite a store's file with new tokens AND bump mtime so hasChanged() picks it up. */
function rewrite(path: string, accessToken: string, refreshToken: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + 3600000 },
    }),
  )
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
}

/** Build a properly-padded fake access token whose tokenHint() returns the given 8-char marker. */
function tokenWith(hint: string): string {
  if (hint.length !== 8) throw new Error('test hint must be 8 chars')
  return `sk-ant-oat01-${hint}_PADDED_TAIL_FOR_LENGTH`
}

/** Track every event the manager emits via setEventEmitter. */
function eventCollector() {
  const events: TokenRotatedPayload[] = []
  return {
    events,
    emit: (p: TokenRotatedPayload) => {
      events.push(p)
    },
  }
}

// Track managers so we can guarantee close() in afterEach (poll-timer / fs.watch hygiene).
const managers: TokenRotationManager[] = []
const tmpPaths: string[] = []

function track(mgr: TokenRotationManager): TokenRotationManager {
  managers.push(mgr)
  return mgr
}
function trackPath(path: string): string {
  tmpPaths.push(path)
  return path
}

afterEach(() => {
  // 1. close() every manager constructed this test.
  for (const m of managers) {
    try {
      m.close()
    } catch {
      /* idempotent */
    }
  }
  managers.length = 0

  // 2. rm tmp credential files.
  for (const p of tmpPaths) {
    try {
      rmSync(p)
    } catch {
      /* may already be gone */
    }
  }
  tmpPaths.length = 0

  // 3. Filter our test-fixture entries out of the shared rotation log so we
  //    never delete real session data, but also don't pollute the log.
  const logPath = join(homedir(), '.claude', 'token-rotation.log')
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, 'utf8').split('\n')
      const filtered = lines.filter(
        l =>
          !l.includes('AAAAAAAA') &&
          !l.includes('BBBBBBBB') &&
          !l.includes('CCCCCCCC') &&
          !l.includes('DDDDDDDD'),
      )
      if (filtered.length !== lines.length) {
        writeFileSync(logPath, filtered.join('\n'))
      }
    } catch {
      /* best-effort cleanup */
    }
  }
})

// ──────────────────────────────────────────────────────────────
// Group 1: tokenHint() helper
// ──────────────────────────────────────────────────────────────

describe('tokenHint()', () => {
  test('returns "" for null/undefined/empty', () => {
    expect(tokenHint(null)).toBe('')
    expect(tokenHint(undefined)).toBe('')
    expect(tokenHint('')).toBe('')
  })

  test('returns "" for short string (<21 chars)', () => {
    expect(tokenHint('sk-ant')).toBe('')
    expect(tokenHint('sk-ant-oat01-AAAA')).toBe('')   // 17 chars
    expect(tokenHint('sk-ant-oat01-AAAAAAA')).toBe('') // 20 chars
  })

  test('returns 8 chars after sk-ant-oat01- prefix for normal tokens', () => {
    expect(tokenHint('sk-ant-oat01-AAAAAAAA0000')).toBe('AAAAAAAA')
    expect(tokenHint(tokenWith('BBBBBBBB'))).toBe('BBBBBBBB')
  })
})

// ──────────────────────────────────────────────────────────────
// Group 2: same-hint no-op (idempotency)
// ──────────────────────────────────────────────────────────────

describe('detectRotation — same-hint idempotency', () => {
  test('first checkPending bootstraps; second with same file emits 0 events', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    expect(collector.events.length).toBe(0) // bootstrap is silent

    await mgr.checkPending()
    expect(collector.events.length).toBe(0) // same hint → step-4 short-circuit
  })

  test('three consecutive checkPending calls with no rewrite still 0 events', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    await mgr.checkPending()
    await mgr.checkPending()
    expect(collector.events.length).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────
// Group 3: bootstrap + same-org silent + cross-org applied
// ──────────────────────────────────────────────────────────────

describe('detectRotation — bootstrap / same-org / cross-org-applied', () => {
  test('bootstrap (first detect): no events, lastSeenHint set internally', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    expect(collector.events.length).toBe(0)
    expect((mgr as any).lastSeenHint).toBe('AAAAAAAA')
    // orgIdCache seeded during bootstrap (T6 critical path)
    expect((mgr as any).orgIdCache).not.toBeNull()
    expect((mgr as any).orgIdCache.orgId).toBe('org-1')
  })

  test('same-org rotation: mode="same-org", no pending', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap

    // Different access token, same org in refresh JWT
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-1'))
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('same-org')
    expect(collector.events[0]!.oldHint).toBe('AAAAAAAA')
    expect(collector.events[0]!.newHint).toBe('BBBBBBBB')
    expect(collector.events[0]!.appliedAt).toBe('immediate')
    expect(mgr.hasPending()).toBe(false)
  })

  test('cross-org SMALL context (ctx<threshold): mode="applied", no pending', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig(150000))) // ctx=1000 < 150k
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap

    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2')) // cross-org
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('applied')
    expect(collector.events[0]!.appliedAt).toBe('immediate')
    expect(collector.events[0]!.oldOrgId).toBe('org-1')
    expect(collector.events[0]!.newOrgId).toBe('org-2')
    expect(mgr.hasPending()).toBe(false)
  })

  test('cross-org with NULL contextTokensProvider: mode="applied" (CR-09 fallback)', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    // No provider at all — undefined → null path.
    const mgr = track(new TokenRotationManager(store, undefined, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap

    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('applied') // CR-09: null ctx → apply
    expect(collector.events[0]!.contextTokens).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────
// Group 4: cross-org large → deferred + revert
// ──────────────────────────────────────────────────────────────

describe('detectRotation — cross-org large (deferred) + revert', () => {
  test('cross-org LARGE context (ctx>=threshold): mode="deferred", pending set', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap

    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    const result = await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('deferred')
    expect(collector.events[0]!.appliedAt).toBeNull()
    expect(mgr.hasPending()).toBe(true)
    expect(result.action).toBe('continue-with-old')
  })

  test('detect again with same hint while pending: 0 new events (step-6 idempotency)', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // first detect → deferred, 1 event
    expect(collector.events.length).toBe(1)

    // Re-poll with same file content — should hit step-6 (pending.newHint match)
    await mgr.checkPending()
    await mgr.checkPending()
    expect(collector.events.length).toBe(1) // still 1
    expect(mgr.hasPending()).toBe(true)
  })

  test('revert to oldHint clears pending (step-7 cancellation)', async () => {
    // Use synthetic state injection because in production the deferred path
    // leaves lastSeenHint=oldHint, which means step-4 short-circuits any
    // revert. Step-7 is reachable when lastSeenHint has advanced past
    // pending.oldHint (e.g. through manual state manipulation, or a future
    // refactor that updates lastSeenHint during deferral).
    const { store, path } = makeStore(tokenWith('CCCCCCCC'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    // Manually arm the synthetic pending state.
    ;(mgr as any).lastSeenHint = 'CCCCCCCC'
    ;(mgr as any).pendingRotation = {
      oldHint: 'AAAAAAAA',
      newHint: 'BBBBBBBB',
      oldOrgId: 'org-1',
      newOrgId: 'org-2',
      detectedAt: Date.now(),
    }
    expect(mgr.hasPending()).toBe(true)

    // Now rewrite the file so its hint == pendingRotation.oldHint (revert).
    rewrite(path, tokenWith('AAAAAAAA'), jwt('org-1'))

    // Direct private call — step-4 won't short-circuit because
    // lastSeenHint(CCCCCCCC) != freshHint(AAAAAAAA).
    await (mgr as any).detectRotation('test')

    expect(mgr.hasPending()).toBe(false)
    // Cancellation does NOT emit a TokenRotatedPayload event — only an
    // audit-log marker. No new events expected.
    expect(collector.events.length).toBe(0)
  })
})

// ──────────────────────────────────────────────────────────────
// Group 5: applyPending state machine
// ──────────────────────────────────────────────────────────────

describe('applyPending()', () => {
  test('with no pending → silent no-op (0 events)', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))
    mgr.setEventEmitter(collector.emit)

    await mgr.applyPending('turn-boundary')
    await mgr.applyPending('context-drop')
    expect(collector.events.length).toBe(0)
  })

  test('applyPending("turn-boundary") → mode="applied", appliedAt="turn-boundary"', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // → deferred

    expect(mgr.hasPending()).toBe(true)
    collector.events.length = 0 // reset to inspect apply

    await mgr.applyPending('turn-boundary')
    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('applied')
    expect(collector.events[0]!.appliedAt).toBe('turn-boundary')
    expect(collector.events[0]!.forcedReason).toBeNull()
    expect(mgr.hasPending()).toBe(false)
  })

  test('applyPending("context-drop") → mode="applied", appliedAt="context-drop"', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // → deferred
    collector.events.length = 0

    await mgr.applyPending('context-drop')
    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.appliedAt).toBe('context-drop')
    expect(collector.events[0]!.mode).toBe('applied')
  })

  test('applyPending("forced-expired", "old-token-expired") → mode="forced", forcedReason set', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // → deferred
    collector.events.length = 0

    await mgr.applyPending('forced-expired', 'old-token-expired')
    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('forced')
    expect(collector.events[0]!.appliedAt).toBe('forced-expired')
    expect(collector.events[0]!.forcedReason).toBe('old-token-expired')
  })

  test('applyPending("forced-expired") WITHOUT forcedReason throws', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))

    await expect(mgr.applyPending('forced-expired')).rejects.toThrow(/forcedReason required/)
  })
})

// ──────────────────────────────────────────────────────────────
// Group 6: checkPending() routing
// ──────────────────────────────────────────────────────────────

describe('checkPending() routing', () => {
  test('no pending → returns { action: "no-pending" }', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const mgr = track(new TokenRotationManager(store, () => 1000, mockConfig()))

    const result = await mgr.checkPending()
    expect(result.action).toBe('no-pending')
  })

  test('pending + ctx<threshold → "apply-now" AND clears pending', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    let ctx = 200000
    const mgr = track(new TokenRotationManager(store, () => ctx, mockConfig(150000)))

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // → deferred, ctx still 200000
    expect(mgr.hasPending()).toBe(true)

    // Drop ctx and re-check
    ctx = 1000
    const result = await mgr.checkPending()
    expect(result.action).toBe('apply-now')
    if (result.action === 'apply-now') {
      expect(result.mode).toBe('applied')
    }
    expect(mgr.hasPending()).toBe(false)
  })

  test('pending + ctx>=threshold → "continue-with-old" AND keeps pending', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const mgr = track(new TokenRotationManager(store, () => 200000, mockConfig(150000)))

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    const r1 = await mgr.checkPending() // → deferred
    expect(r1.action).toBe('continue-with-old')
    if (r1.action === 'continue-with-old') {
      expect(r1.pending.oldHint).toBe('AAAAAAAA')
      expect(r1.pending.newHint).toBe('BBBBBBBB')
    }
    expect(mgr.hasPending()).toBe(true)

    // Re-poll with no change — pending preserved
    const r2 = await mgr.checkPending()
    expect(r2.action).toBe('continue-with-old')
    expect(mgr.hasPending()).toBe(true)
  })

  test('pending + ctx=null (provider undefined) → "apply-now" (CR-09)', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    // Variable provider: defined for first deferral, then "removed" semantically
    // by switching to a returns-null function.
    let provider: (() => number | null) | undefined = () => 200000
    const mgr = track(
      new TokenRotationManager(store, () => (provider ? provider() : null), mockConfig(150000)),
    )

    await mgr.checkPending() // bootstrap
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // → deferred
    expect(mgr.hasPending()).toBe(true)

    // Now flip provider to null path
    provider = undefined
    const result = await mgr.checkPending()
    expect(result.action).toBe('apply-now')
    expect(mgr.hasPending()).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────
// Group 7: JWT extract + org-id cache
// ──────────────────────────────────────────────────────────────

describe('extractOrgId + org-id cache', () => {
  function newMgrForJwt(): TokenRotationManager {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-x'))
    trackPath(path)
    return track(new TokenRotationManager(store, () => 1000, mockConfig()))
  }

  test('valid JWT with organization_id → returns the id', () => {
    const mgr = newMgrForJwt()
    expect((mgr as any).extractOrgId(jwt('org-abc-123'))).toBe('org-abc-123')
  })

  test('malformed JWT (random string) → null (fail-safe)', () => {
    const mgr = newMgrForJwt()
    expect((mgr as any).extractOrgId('not-a-jwt-at-all')).toBeNull()
    expect((mgr as any).extractOrgId('a.b')).toBeNull() // 2 parts
    expect((mgr as any).extractOrgId('a.b.c.d')).toBeNull() // 4 parts
    expect((mgr as any).extractOrgId('a.!!!notbase64!!!.c')).toBeNull()
  })

  test('JWT without organization_id field → null', () => {
    const mgr = newMgrForJwt()
    expect((mgr as any).extractOrgId(jwt(null))).toBeNull()
    expect((mgr as any).extractOrgId(null)).toBeNull()
    expect((mgr as any).extractOrgId(undefined)).toBeNull()
  })

  test('org-id cache: returns cached value within TTL despite store mutation', async () => {
    // Synthetic store: refreshToken can be flipped between reads.
    let refresh = jwt('org-A')
    const syntheticStore: CredentialStore = {
      async read(): Promise<StoredCredentials | null> {
        return {
          accessToken: tokenWith('AAAAAAAA'),
          refreshToken: refresh,
          expiresAt: Date.now() + 3600000,
        }
      },
      async write() {
        /* unused */
      },
    }
    const mgr = track(new TokenRotationManager(syntheticStore, () => 1000, mockConfig()))

    // First call: cache MISS, reads org-A, caches.
    const first = await (mgr as any).getCachedOrgId()
    expect(first).toBe('org-A')

    // Mutate underlying store (would change return value if not cached).
    refresh = jwt('org-B-NEW')

    // Second call: cache HIT (well within 5min TTL) → still org-A.
    const second = await (mgr as any).getCachedOrgId()
    expect(second).toBe('org-A')
  })
})

// ──────────────────────────────────────────────────────────────
// Group 8: contextTokensProvider contract
// ──────────────────────────────────────────────────────────────

describe('contextTokensProvider contract', () => {
  test('undefined provider → null → CR-09 apply path', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = track(new TokenRotationManager(store, undefined, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('applied') // never deferred when ctx unknown
  })

  test('provider throws → caught, treated as null, rotation still applies', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const throwing = (() => {
      throw new Error('synthetic provider failure')
    }) as unknown as () => number | null
    const mgr = track(new TokenRotationManager(store, throwing, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    expect(collector.events[0]!.mode).toBe('applied')
    expect(collector.events[0]!.contextTokens).toBeNull()
  })

  test('provider returns Promise → coerced to null (sync contract)', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const promiseProvider = (() => Promise.resolve(200000)) as unknown as () => number | null
    const mgr = track(new TokenRotationManager(store, promiseProvider, mockConfig(150000)))
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending()
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending()

    expect(collector.events.length).toBe(1)
    // Promise is typeof 'object', not 'number' → coerced to null → applied path.
    expect(collector.events[0]!.mode).toBe('applied')
    expect(collector.events[0]!.contextTokens).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────
// Group 9: close() cleanup
// ──────────────────────────────────────────────────────────────

describe('close() lifecycle', () => {
  test('close() clears watcher + pollTimer; subsequent detect no-ops', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const collector = eventCollector()
    const mgr = new TokenRotationManager(store, () => 1000, mockConfig())
    mgr.setEventEmitter(collector.emit)

    await mgr.checkPending() // bootstrap
    mgr.close()

    expect((mgr as any).watcher).toBeNull()
    expect((mgr as any).pollTimer).toBeNull()
    expect((mgr as any).closed).toBe(true)

    // After close, even a real rotation on disk shouldn't emit.
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-2'))
    await mgr.checkPending() // detectRotation early-exits via `closed` guard
    expect(collector.events.length).toBe(0)
  })

  test('close() is idempotent (calling twice doesn\'t throw)', () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-1'))
    trackPath(path)
    const mgr = new TokenRotationManager(store, () => 1000, mockConfig())
    mgr.close()
    expect(() => mgr.close()).not.toThrow()
    expect(() => mgr.close()).not.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────
// Group 10: MemoryCredentialStore (no .path) compatibility (CN-10)
// ──────────────────────────────────────────────────────────────

describe('MemoryCredentialStore (no .path) — CN-10', () => {
  test('constructor doesn\'t throw, watcher null, methods callable', async () => {
    const memStore = new MemoryCredentialStore({
      accessToken: tokenWith('AAAAAAAA'),
      refreshToken: jwt('org-1'),
      expiresAt: Date.now() + 3600000,
    })

    let mgr: TokenRotationManager | null = null
    expect(() => {
      mgr = new TokenRotationManager(memStore, () => 1000, mockConfig())
    }).not.toThrow()

    track(mgr!)

    // Watcher should be null (no .path on MemoryCredentialStore).
    expect((mgr! as any).watcher).toBeNull()
    // Poll timer should still be running (covers in-memory stores too).
    expect((mgr! as any).pollTimer).not.toBeNull()

    // All public methods callable without throwing.
    const result = await mgr!.checkPending()
    expect(result).toBeDefined()
    expect(mgr!.hasPending()).toBe(false)
    await mgr!.applyPending('turn-boundary') // no-op silent
    mgr!.close()
  })
})
