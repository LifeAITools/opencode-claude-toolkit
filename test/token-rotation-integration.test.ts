/**
 * Integration tests for ClaudeCodeSDK + TokenRotationManager pipeline (PRP
 * token-rotation-deferred-apply, T15).
 *
 * Exercises the wire-up between sdk.ts (T9/T10 hooks) and token-rotation.ts
 * (T4-T8 state machine) end-to-end with realistic FileCredentialStore +
 * fs.watch + poll fallback. Validates:
 *
 *   AC-1.1 + REQ-01  small-context cross-org applies on next ensureAuth
 *   AC-1.3           large-context cross-org → DEFERRED (banner + pending)
 *   AC-1.4           large-context + turn-boundary apply clears pending
 *   AC-2.1 + REQ-01  idle pid invalidation via fs.watch ≤500ms
 *   AC-2.5           stress: pid awaiting 2s, rotation detected during sleep
 *   CN-05 + SM-02    Defect 1 regression preserved (cross-org disk pickup)
 *   NFR-03           multi-tenant — 3 SDKs sharing one credentials path
 *   REQ-09           forced-expiry path emits mode='forced'
 *   DB-05            pendingRotation NEVER persists across SDK restart
 *   CR-02            same-org rotation does NOT defer regardless of context
 *
 * Test fixture token hints (filtered from shared rotation log on cleanup):
 *   AAAAAAAA — bootstrap / oldHint
 *   BBBBBBBB — first rotation target
 *   CCCCCCCC — second rotation
 *   DDDDDDDD — fourth-step / forced cases
 *   EEEEEEEE — multi-tenant rotation hint
 *   FFFFFFFF — restart-no-persist hint
 *
 * NOTE: tests deliberately avoid live network paths — `refreshTokenWithTripleCheck`
 * is bypassed by either (a) using long-lived creds where refresh is unnecessary,
 * or (b) catching/swallowing the resulting error and asserting only on the
 * event emission that already fired before refresh ran.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { ClaudeCodeSDK, FileCredentialStore } from '../src/sdk'
import type { TokenRotatedPayload } from '../src/token-rotation'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

// ──────────────────────────────────────────────────────────────
// Helpers (mirror T14 patterns; FileCredentialStore-only since
// fs.watch and `.path` are required by the manager — CN-10).
// ──────────────────────────────────────────────────────────────

function jwt(orgId: string | null): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify(orgId === null ? {} : { organization_id: orgId }),
  ).toString('base64url')
  return `${header}.${payload}.sig`
}

function tokenWith(hint: string): string {
  if (hint.length !== 8) throw new Error('test hint must be 8 chars')
  return `sk-ant-oat01-${hint}_PADDED_TAIL_FOR_LENGTH`
}

interface StoreFixture {
  store: FileCredentialStore
  path: string
}

function makeStore(
  accessToken: string,
  refreshToken: string,
  expiresInMs = 3600_000,
): StoreFixture {
  const path = join(
    tmpdir(),
    `t15-creds-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  )
  mkdirSync(tmpdir(), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + expiresInMs },
    }),
  )
  return { store: new FileCredentialStore(path), path }
}

function rewrite(
  path: string,
  accessToken: string,
  refreshToken: string,
  expiresInMs = 3600_000,
): void {
  writeFileSync(
    path,
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, expiresAt: Date.now() + expiresInMs },
    }),
  )
  // Bump mtime explicitly — same-millisecond writes may not change mtime
  // on some filesystems. Mirrors test/sdk-mtime-token-rotation.test.ts.
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
}

function eventCollector() {
  const events: TokenRotatedPayload[] = []
  return {
    events,
    emit: (p: TokenRotatedPayload) => { events.push(p) },
  }
}

// Resource tracking for afterEach hygiene (poll-timer + fs.watch cleanup).
const sdks: ClaudeCodeSDK[] = []
const tmpPaths: string[] = []

function track(sdk: ClaudeCodeSDK): ClaudeCodeSDK {
  sdks.push(sdk)
  return sdk
}
function trackPath(path: string): string {
  tmpPaths.push(path)
  return path
}

afterEach(() => {
  // 1. Close every SDK constructed in this test.
  for (const s of sdks) {
    try { s.close() } catch { /* idempotent */ }
  }
  sdks.length = 0

  // 2. Remove tmp credential files.
  for (const p of tmpPaths) {
    try { rmSync(p) } catch { /* may already be gone */ }
  }
  tmpPaths.length = 0

  // 3. Filter our test-fixture entries out of the shared rotation log so
  //    we never delete real session data, but also don't pollute the log.
  const logPath = join(homedir(), '.claude', 'token-rotation.log')
  if (existsSync(logPath)) {
    try {
      const lines = readFileSync(logPath, 'utf8').split('\n')
      const filtered = lines.filter(
        l =>
          !l.includes('AAAAAAAA') &&
          !l.includes('BBBBBBBB') &&
          !l.includes('CCCCCCCC') &&
          !l.includes('DDDDDDDD') &&
          !l.includes('EEEEEEEE') &&
          !l.includes('FFFFFFFF'),
      )
      if (filtered.length !== lines.length) {
        writeFileSync(logPath, filtered.join('\n'))
      }
    } catch {
      /* best-effort cleanup */
    }
  }
})

// Convenience accessor — `tokenRotation` field is private on the SDK
// (definite-assignment-asserted per T9 gotcha); tests reach in via cast.
function rot(sdk: ClaudeCodeSDK) {
  return (sdk as any).tokenRotation as {
    hasPending(): boolean
    setEventEmitter(fn: (p: TokenRotatedPayload) => void): void
    applyPending(
      reason: 'turn-boundary' | 'context-drop' | 'forced-expired',
      forcedReason?: 'old-token-expired' | 'old-refresh-failed' | 'old-api-rejected',
    ): Promise<void>
    close(): void
  }
}

// `ensureAuth` is private on the SDK; reach in via cast for integration paths.
async function ensureAuth(sdk: ClaudeCodeSDK): Promise<void> {
  return (sdk as any).ensureAuth()
}

// ──────────────────────────────────────────────────────────────
// AC-1.1 + REQ-01: small-context cross-org applies immediately
// ──────────────────────────────────────────────────────────────

describe('AC-1.1 / REQ-01 — small-context cross-org applies on next ensureAuth', () => {
  test('hasPending stays false; manager emits mode=applied', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 1000, // well below 150K threshold
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    // Bootstrap: lastSeenHint = AAAAAAAA, orgIdCache = org-A. No event.
    await ensureAuth(sdk)
    expect(collector.events.length).toBe(0)

    // External `claude /login` to a DIFFERENT org.
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))

    // Next ensureAuth: detectRotation('ensureAuth') sees the diff, decides
    // small-context → mode='applied' (immediate, no defer).
    await ensureAuth(sdk)

    expect(rot(sdk).hasPending()).toBe(false)
    const applied = collector.events.find(e => e.mode === 'applied')
    expect(applied).toBeDefined()
    expect(applied!.appliedAt).toBe('immediate')
    expect(applied!.oldOrgId).toBe('org-A')
    expect(applied!.newOrgId).toBe('org-B')
  })
})

// ──────────────────────────────────────────────────────────────
// AC-1.3: large-context cross-org → DEFERRED (banner + pending)
// ──────────────────────────────────────────────────────────────

describe('AC-1.3 — large-context cross-org defers (banner + pending)', () => {
  test('hasPending=true after rotation; mode=deferred forcedReason=null', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 200_000, // above 150K threshold
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    await ensureAuth(sdk) // bootstrap (silent)
    expect(collector.events.length).toBe(0)

    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))
    await ensureAuth(sdk)

    expect(rot(sdk).hasPending()).toBe(true)
    const deferred = collector.events.find(e => e.mode === 'deferred')
    expect(deferred).toBeDefined()
    expect(deferred!.forcedReason).toBeNull()
    expect(deferred!.appliedAt).toBeNull()
    expect(deferred!.oldOrgId).toBe('org-A')
    expect(deferred!.newOrgId).toBe('org-B')
    expect(deferred!.contextTokens).toBe(200_000)
  })
})

// ──────────────────────────────────────────────────────────────
// AC-1.4: large-context + turn-boundary apply clears pending
// ──────────────────────────────────────────────────────────────

describe('AC-1.4 — turn-boundary apply clears pending', () => {
  test('applyPending(turn-boundary) emits mode=applied appliedAt=turn-boundary', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 200_000,
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    await ensureAuth(sdk)
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))
    await ensureAuth(sdk)

    expect(rot(sdk).hasPending()).toBe(true)
    const beforeCount = collector.events.length

    // Simulate turn-boundary hook firing (T13 chat.message handler).
    await rot(sdk).applyPending('turn-boundary')

    expect(rot(sdk).hasPending()).toBe(false)
    const newEvents = collector.events.slice(beforeCount)
    expect(newEvents.length).toBeGreaterThanOrEqual(1)
    const applied = newEvents.find(e => e.mode === 'applied')
    expect(applied).toBeDefined()
    expect(applied!.appliedAt).toBe('turn-boundary')
    expect(applied!.oldHint).toBe('AAAAAAAA')
    expect(applied!.newHint).toBe('BBBBBBBB')
  })
})

// ──────────────────────────────────────────────────────────────
// AC-2.1 + REQ-01: idle pid invalidation via fs.watch (≤500ms)
// ──────────────────────────────────────────────────────────────

describe('AC-2.1 / REQ-01 — fs.watch detects rotation in idle pid', () => {
  test('without ensureAuth, rewrite triggers detect within 600ms', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 1000,
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    // Bootstrap so the manager has a baseline lastSeenHint.
    await ensureAuth(sdk)
    expect(collector.events.length).toBe(0)

    // Rewrite WITHOUT calling ensureAuth — only fs.watch can detect this.
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))

    // Wait for fs.watch + queueMicrotask + async detectRotation to land.
    await new Promise(r => setTimeout(r, 600))

    expect(collector.events.length).toBeGreaterThanOrEqual(1)
    const ev = collector.events[0]!
    expect(ev.oldHint).toBe('AAAAAAAA')
    expect(ev.newHint).toBe('BBBBBBBB')
  })
})

// ──────────────────────────────────────────────────────────────
// AC-2.5: stress — pid awaiting 2s, rotation detected during sleep
// ──────────────────────────────────────────────────────────────

describe('AC-2.5 — rotation detected during pid sleep (no API call)', () => {
  test('event arrives during 2s sleep, not after subsequent ensureAuth', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 1000,
    }))
    const eventTimestamps: number[] = []
    rot(sdk).setEventEmitter((p) => {
      eventTimestamps.push(Date.now())
      void p
    })

    await ensureAuth(sdk) // bootstrap

    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))
    const sleepStart = Date.now()
    await new Promise(r => setTimeout(r, 2000))
    const sleepEnd = Date.now()

    expect(eventTimestamps.length).toBeGreaterThanOrEqual(1)
    // First event must have arrived DURING the sleep window, not after.
    const firstEvent = eventTimestamps[0]!
    expect(firstEvent).toBeGreaterThanOrEqual(sleepStart)
    expect(firstEvent).toBeLessThanOrEqual(sleepEnd + 50) // tolerance
  }, 5000) // bun test default is 5s; explicit for clarity
})

// ──────────────────────────────────────────────────────────────
// CN-05 + SM-02: Defect 1 regression — cross-org disk pickup
// ──────────────────────────────────────────────────────────────

describe('CN-05 / SM-02 — Defect 1 regression (cross-org disk pickup)', () => {
  test('SDK does not pin OLD token after external rewrite + ensureAuth', async () => {
    // Mirrors the pid 3964910 scenario from commit f01e22d: a long-running
    // pid keeps using the OLD token because the in-memory cache never
    // invalidated. With the rotation manager wired in, detectRotation
    // (called via checkPending) consumes the disk change and updates
    // lastSeenHint; for SMALL context the path is mode='applied', so
    // the manager has fully advanced state.
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 1000,
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    await ensureAuth(sdk)
    expect((rot(sdk) as any).lastSeenHint).toBe('AAAAAAAA')

    // External `claude /login` to a different org.
    rewrite(path, tokenWith('BBBBBBBB'), jwt('org-B'))
    await ensureAuth(sdk)

    // Manager state advanced: lastSeenHint is NEW; no stale pending.
    expect((rot(sdk) as any).lastSeenHint).toBe('BBBBBBBB')
    expect(rot(sdk).hasPending()).toBe(false)
    // Event was emitted with the OLD→NEW transition recorded.
    const applied = collector.events.find(e => e.mode === 'applied')
    expect(applied).toBeDefined()
    expect(applied!.oldHint).toBe('AAAAAAAA')
    expect(applied!.newHint).toBe('BBBBBBBB')
  })
})

// ──────────────────────────────────────────────────────────────
// NFR-03: multi-tenant — 3 SDK instances sharing one credentials path
// ──────────────────────────────────────────────────────────────

describe('NFR-03 — multi-tenant: 3 SDKs sharing one credentials file', () => {
  test('each SDK independently captures rotation events', async () => {
    const { path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)

    // Three SDKs, each with its own FileCredentialStore but same path.
    const collectors = [eventCollector(), eventCollector(), eventCollector()]
    const sdkInstances = [0, 1, 2].map(() => {
      const s = new FileCredentialStore(path)
      return track(new ClaudeCodeSDK({
        credentialStore: s,
        contextTokensProvider: () => 200_000, // large → defer on rotation
      }))
    })

    sdkInstances.forEach((s, i) => rot(s).setEventEmitter(collectors[i]!.emit))

    // Bootstrap all three.
    for (const s of sdkInstances) await ensureAuth(s)

    // External cross-org rewrite.
    rewrite(path, tokenWith('EEEEEEEE'), jwt('org-B'))

    // Wait for all three watchers to fire.
    await new Promise(r => setTimeout(r, 800))

    // All three see at least one event independently.
    for (const c of collectors) {
      expect(c.events.length).toBeGreaterThanOrEqual(1)
      const ev = c.events[0]!
      expect(ev.oldHint).toBe('AAAAAAAA')
      expect(ev.newHint).toBe('EEEEEEEE')
    }

    // Each instance has its own pending state — toggle one and confirm
    // the others are unaffected.
    expect(sdkInstances.every(s => rot(s).hasPending())).toBe(true)
    await rot(sdkInstances[0]!).applyPending('turn-boundary')
    expect(rot(sdkInstances[0]!).hasPending()).toBe(false)
    expect(rot(sdkInstances[1]!).hasPending()).toBe(true)
    expect(rot(sdkInstances[2]!).hasPending()).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────
// REQ-09: forced-expiry — old-token-expired
// ──────────────────────────────────────────────────────────────

describe('REQ-09 — forced-expiry path emits mode=forced', () => {
  test('expired old token + pending → applyPending(forced-expired) fires', async () => {
    // Bootstrap with a long-lived OLD token so the first ensureAuth() doesn't
    // immediately try to refresh. Trigger pending via cross-org rewrite (also
    // long-lived NEW so refresh would succeed reading disk if it reached
    // that branch), THEN simulate the OLD-in-memory token expiring by
    // mutating `expiresAt` directly. This is the "deferred state lasted
    // long enough that the OLD token expired before turn boundary" scenario.
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'), 3600_000)
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 200_000, // large → defer
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    await ensureAuth(sdk) // bootstrap with valid OLD token; no refresh triggered

    // External rotation → cross-org with LONG-lived NEW token. Manager will
    // detect via fs.watch, classify as deferred (ctx=200K ≥ threshold).
    rewrite(path, tokenWith('DDDDDDDD'), jwt('org-D'), 3600_000)
    await new Promise(r => setTimeout(r, 600))

    expect(rot(sdk).hasPending()).toBe(true)
    const beforeCount = collector.events.length

    // Simulate the OLD in-memory token having expired by directly mutating
    // SDK state. (Alternative: real wall-clock wait — too slow for CI.)
    // EXPIRY_BUFFER_MS = 300_000, so any expiresAt < Date.now()+300_000 is
    // "expired" per isTokenExpired().
    ;(sdk as any).expiresAt = Date.now() - 1000

    // ensureAuth() now: checkPending → continue-with-old (ctx=200K ≥ threshold).
    // Fast path: accessToken set + isTokenExpired() → fall through.
    // _doEnsureAuth: hasChanged=false (already consumed), accessToken set,
    // hasPending()=true && isTokenExpired()=true → applyPending('forced-expired',
    // 'old-token-expired') ✓ — emits the event we're testing for. THEN
    // refreshTokenWithTripleCheck reads the long-lived NEW creds from disk
    // and returns without API call (DDDDDDDD has 1h remaining).
    try {
      await ensureAuth(sdk)
    } catch {
      // refresh may still fail if disk read returns null mid-write; we only
      // care that the forced event fired BEFORE the refresh attempt.
    }

    const newEvents = collector.events.slice(beforeCount)
    const forced = newEvents.find(e => e.mode === 'forced')
    expect(forced).toBeDefined()
    expect(forced!.forcedReason).toBe('old-token-expired')
    expect(forced!.appliedAt).toBe('forced-expired')
    expect(rot(sdk).hasPending()).toBe(false)
  })
})

// ──────────────────────────────────────────────────────────────
// DB-05: pendingRotation does NOT persist across SDK restart
// ──────────────────────────────────────────────────────────────

describe('DB-05 — pendingRotation never persists across SDK restart', () => {
  test('SDK2 fresh instance has hasPending=false even though SDK1 was deferred', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)

    // SDK1: trigger deferred state.
    const sdk1 = new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 200_000,
    })
    const collector1 = eventCollector()
    rot(sdk1).setEventEmitter(collector1.emit)

    await ensureAuth(sdk1)
    rewrite(path, tokenWith('FFFFFFFF'), jwt('org-F'))
    await ensureAuth(sdk1)

    expect(rot(sdk1).hasPending()).toBe(true)

    // Simulate full process restart: close SDK1, construct SDK2 against
    // the SAME credentials file. SDK2 has fresh in-memory state — there
    // is no on-disk record of pendingRotation by design (DB-05).
    sdk1.close()

    const store2 = new FileCredentialStore(path)
    const sdk2 = track(new ClaudeCodeSDK({
      credentialStore: store2,
      contextTokensProvider: () => 200_000,
    }))
    const collector2 = eventCollector()
    rot(sdk2).setEventEmitter(collector2.emit)

    // SDK2's first ensureAuth bootstraps lastSeenHint to whatever's on
    // disk NOW (the post-rotation FFFFFFFF token). No rotation visible
    // from SDK2's perspective — it never saw the OLD token in memory.
    await ensureAuth(sdk2)

    expect(rot(sdk2).hasPending()).toBe(false)
    expect((rot(sdk2) as any).lastSeenHint).toBe('FFFFFFFF')
    expect(collector2.events.length).toBe(0) // bootstrap is silent
  })
})

// ──────────────────────────────────────────────────────────────
// CR-02: same-org rotation does NOT defer regardless of context
// ──────────────────────────────────────────────────────────────

describe('CR-02 — same-org rotation never defers', () => {
  test('large context + same-org → mode=same-org, no pending', async () => {
    const { store, path } = makeStore(tokenWith('AAAAAAAA'), jwt('org-A'))
    trackPath(path)
    const sdk = track(new ClaudeCodeSDK({
      credentialStore: store,
      contextTokensProvider: () => 200_000, // large, would defer if cross-org
    }))
    const collector = eventCollector()
    rot(sdk).setEventEmitter(collector.emit)

    await ensureAuth(sdk) // bootstrap
    expect(collector.events.length).toBe(0)

    // Rotate to a NEW access token but the SAME org-A in refresh JWT.
    rewrite(path, tokenWith('CCCCCCCC'), jwt('org-A'))
    await ensureAuth(sdk)

    const sameOrg = collector.events.find(e => e.mode === 'same-org')
    expect(sameOrg).toBeDefined()
    expect(sameOrg!.appliedAt).toBe('immediate')
    expect(sameOrg!.oldOrgId).toBe('org-A')
    expect(sameOrg!.newOrgId).toBe('org-A')
    expect(rot(sdk).hasPending()).toBe(false)
  })
})
