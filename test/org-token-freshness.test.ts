/**
 * Per-org OAuth token freshness — the `withFreshOrgToken` choke-point.
 *
 * Regression tests for the architect-review findings of the per-org token
 * rotation gap (PRPs/per-org-tokens/evolutions/):
 *   C1 — active-org refresh co-writes `.credentials.json` (never strands the
 *        disk token), zero vault↔disk divergence.
 *   C2 — a zero-live-session org is kept alive by the daemon proactive sweep.
 *   H2 — a token that keeps coming back expired does NOT grant on every fire;
 *        the per-org min-interval floor caps the grant frequency.
 *   H3 — a revoked refresh_token → ONE forced attempt → per-org cooldown +
 *        ORG_TOKEN_NEEDS_RELOGIN, no per-slot hammering; an expired (not
 *        revoked) token → forced refresh recovers.
 *   single-flight — concurrent fires for one org → exactly one grant.
 */

import { describe, test, expect, setSystemTime, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { OrgVault } from '../src/org-vault.js'
import { OAuthRefreshError, type RefreshedTokens } from '../src/auth.js'
import { acquireConfigDirLock } from '../src/config-dir-lock.js'
import { FileCredentialsProvider } from '../src/proxy-adapters.js'

const MIN = 60_000
const HOUR = 60 * MIN

const clients: ProxyClient[] = []
const tmps: string[] = []
afterEach(() => {
  for (const c of clients.splice(0)) { try { c.stop() } catch {} }
  for (const d of tmps.splice(0)) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  setSystemTime()
})

function mkTmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmps.push(d)
  return d
}

/** Event collector emitter. */
function collector() {
  const events: Array<Record<string, unknown>> = []
  return { events, emitter: { emit: (e: Record<string, unknown>) => { events.push(e) } } }
}

/** A refresh-grant fake that counts calls and returns a scripted token. */
function fakeRefresher(script: (n: number, refreshToken: string) => RefreshedTokens) {
  const calls: string[] = []
  const fn = async (refreshToken: string): Promise<RefreshedTokens> => {
    calls.push(refreshToken)
    return script(calls.length, refreshToken)
  }
  ;(fn as unknown as { calls: string[] }).calls = calls
  return fn as typeof fn & { calls: string[] }
}

/** No-op cross-process lock (most tests don't exercise real proper-lockfile). */
const fakeLock = async () => async () => {}

function mkClient(extra: Partial<ProxyClientOptions>, tmp: string): ProxyClient {
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 3600, orgProactiveRefreshSec: 0 },
    credentialsProvider: { getAccessToken: async () => 'active-disk-token', invalidate() {} },
    prefixHistoryPath: join(tmp, 'ph.json'),
    kaSnapshotPath: join(tmp, 'ka.json'),
    rewriteBlockDumpDir: join(tmp, 'dumps'),
    proxyStartedAt: 0,
    acquireConfigLock: fakeLock,
    ...extra,
  })
  clients.push(c)
  return c
}

// ──────────────────────────────────────────────────────────────────────────
// C1 — active-org refresh co-writes .credentials.json (no stranding)
// ──────────────────────────────────────────────────────────────────────────

describe('C1 — active org co-writes .credentials.json (no vault↔disk divergence)', () => {
  test('active-org refresh writes the rotated token to disk AND mirrors the vault; profile preserved', async () => {
    const tmp = mkTmp('otf-c1-')
    const configDir = join(tmp, '.claude')
    mkdirSync(configDir, { recursive: true })
    const credPath = join(configDir, '.credentials.json')
    const now = Date.now()
    setSystemTime(now)

    // Disk holds a near-expiry active credential with a real subscription type.
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'ACT-old', refreshToken: 'ACT-rt-old',
        expiresAt: now + 10 * MIN, scopes: ['user:inference'],
        subscriptionType: 'max', rateLimitTier: 'default',
      },
      otherKey: 'keep-me',
    }))

    const refresher = fakeRefresher(() => ({
      accessToken: 'ACT-new', refreshToken: 'ACT-rt-new', expiresAt: now + 8 * HOUR,
      scopes: ['user:inference'],
    }))
    const vault = new OrgVault(join(tmp, 'vault.json'))
    const { events, emitter } = collector()

    const c = mkClient({
      credentialsProvider: new FileCredentialsProvider({ path: credPath }),
      orgIdResolver: { current: () => 'org-active', invalidate() {} },
      orgVault: vault,
      oauthRefresher: refresher,
      claudeConfigDir: configDir,
      credentialsPath: credPath,
      acquireConfigLock: acquireConfigDirLock,   // exercise the REAL config-dir lock
      eventEmitter: emitter,
    }, tmp)

    const token = await c._withFreshOrgToken('org-active')
    expect(token).toBe('ACT-new')
    expect(refresher.calls.length).toBe(1)

    // Disk got the rotated token — the native CLI + other consumers are NOT stranded.
    const disk = JSON.parse(readFileSync(credPath, 'utf8')).claudeAiOauth
    expect(disk.accessToken).toBe('ACT-new')
    expect(disk.refreshToken).toBe('ACT-rt-new')
    expect(disk.refreshToken).not.toBe('ACT-rt-old')
    // Preserve-on-null: the refresh grant didn't return a subscription — keep it.
    expect(disk.subscriptionType).toBe('max')
    expect(disk.rateLimitTier).toBe('default')
    // Other top-level keys survive the atomic rewrite.
    expect(JSON.parse(readFileSync(credPath, 'utf8')).otherKey).toBe('keep-me')

    // Vault mirror is COHERENT with disk (zero divergence — the C1 bug).
    const ve = vault.get('org-active')!
    expect(ve.accessToken).toBe(disk.accessToken)
    expect(ve.refreshToken).toBe(disk.refreshToken)

    expect(events.some(e => e.kind === 'ORG_TOKEN_REFRESHED' && e.active === true)).toBe(true)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// C2 — zero-live-session vault org kept alive by the proactive sweep
// ──────────────────────────────────────────────────────────────────────────

describe('C2 — proactive sweep keeps a zero-live-session org alive', () => {
  test('an idle vault org with no sessions and no KA fires is refreshed by the sweep', async () => {
    const tmp = mkTmp('otf-c2-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    // A vault org whose token is near expiry — like relish (-42h): zero sessions.
    vault.upsert({
      orgId: 'org-idle', orgName: 'idle', accessToken: 'idle-old', refreshToken: 'idle-rt-old',
      expiresAt: now + 5 * MIN, capturedAt: now - 49 * MIN,   // 54-min lifetime, due
    })

    const refresher = fakeRefresher(() => ({
      accessToken: 'idle-new', refreshToken: 'idle-rt-new', expiresAt: now + 8 * HOUR,
    }))

    const c = mkClient({
      // No active org at all — nothing but the idle vault org exists.
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: refresher,
    }, tmp)

    // NO session was ever created, NO KA fired — only the daemon sweep runs.
    await c._runOrgProactiveSweep()

    expect(refresher.calls.length).toBe(1)
    const ve = vault.get('org-idle')!
    expect(ve.accessToken).toBe('idle-new')
    expect(ve.refreshToken).toBe('idle-rt-new')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// H2 — min-interval floor caps grant frequency (no per-fire storm)
// ──────────────────────────────────────────────────────────────────────────

describe('H2 — short/expired token does not grant on every fire', () => {
  test('a token that keeps returning expired grants once per min-interval floor, not per fire', async () => {
    const tmp = mkTmp('otf-h2-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    vault.upsert({
      orgId: 'org-short', accessToken: 'sh-0', refreshToken: 'sh-rt-0',
      expiresAt: now - MIN, capturedAt: now - 55 * MIN,   // already EXPIRED → always "due"
    })

    // Anthropic keeps returning a still-expired short token (rate-limited case):
    // the fraction gate can't help (expired → due), so ONLY the min-interval
    // floor prevents a grant on every fire.
    let n = 0
    const refresher = fakeRefresher(() => {
      n++
      return { accessToken: `sh-${n}`, refreshToken: `sh-rt-${n}`, expiresAt: Date.now() - MIN }
    })

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: refresher,
    }, tmp)

    // 20 rapid fires at the SAME wall-clock instant → the floor allows only ONE grant.
    for (let i = 0; i < 20; i++) await c._withFreshOrgToken('org-short')
    expect(refresher.calls.length).toBe(1)

    // Advance past the 5-min floor → the next fire is allowed to grant again.
    setSystemTime(now + 5 * MIN + 1000)
    await c._withFreshOrgToken('org-short')
    expect(refresher.calls.length).toBe(2)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// H3 — force-on-401: revoke bound + cooldown, expiry recovers
// ──────────────────────────────────────────────────────────────────────────

describe('H3 — force-on-401 revoke classification + per-org cooldown', () => {
  test('revoked refresh_token → ONE attempt → cooldown + ORG_TOKEN_NEEDS_RELOGIN, no per-slot hammering', async () => {
    const tmp = mkTmp('otf-h3r-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    vault.upsert({
      orgId: 'org-rev', accessToken: 'rev-0', refreshToken: 'rev-rt-0',
      expiresAt: now - MIN, capturedAt: now - HOUR,   // expired
    })

    const refresher = fakeRefresher(() => {
      throw new OAuthRefreshError(400, '{"error":"invalid_grant"}')
    })
    const { events, emitter } = collector()

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: refresher, eventEmitter: emitter,
    }, tmp)

    // Simulate the REARM ladder re-forcing across several slots with the SAME
    // failed token — the cooldown must stop after ONE real grant attempt.
    for (let slot = 0; slot < 5; slot++) await c._forceOrg401('org-rev', 'rev-0')

    expect(refresher.calls.length).toBe(1)                        // exactly one endpoint hit
    const cd = c._orgCooldown('org-rev')!
    expect(cd.needsRelogin).toBe(true)
    expect(cd.until).toBeGreaterThan(now)
    const relogin = events.filter(e => e.kind === 'ORG_TOKEN_NEEDS_RELOGIN')
    expect(relogin.length).toBe(1)                         // emitted once, not per slot
  })

  test('expired (not revoked) token → forced refresh recovers', async () => {
    const tmp = mkTmp('otf-h3e-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    vault.upsert({
      orgId: 'org-exp', accessToken: 'exp-0', refreshToken: 'exp-rt-0',
      expiresAt: now - MIN, capturedAt: now - HOUR,
    })
    const refresher = fakeRefresher(() => ({
      accessToken: 'exp-1', refreshToken: 'exp-rt-1', expiresAt: now + 8 * HOUR,
    }))

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: refresher,
    }, tmp)

    await c._forceOrg401('org-exp', 'exp-0')
    expect(refresher.calls.length).toBe(1)
    expect(vault.get('org-exp')!.accessToken).toBe('exp-1')
    expect(c._orgCooldown('org-exp')).toBeUndefined()      // success clears cooldown
  })

  test('force-on-401 with a peer-rotated token adopts it WITHOUT a grant', async () => {
    const tmp = mkTmp('otf-h3p-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    // Vault already holds a DIFFERENT (peer-refreshed) token than the failed one.
    vault.upsert({
      orgId: 'org-peer', accessToken: 'peer-new', refreshToken: 'peer-rt',
      expiresAt: now + 8 * HOUR, capturedAt: now,
    })
    const refresher = fakeRefresher(() => ({ accessToken: 'x', refreshToken: 'y', expiresAt: now + HOUR }))

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: refresher,
    }, tmp)

    await c._forceOrg401('org-peer', 'peer-OLD-failed')
    expect(refresher.calls.length).toBe(0)                        // adopted the peer token, no grant
  })
})

// ──────────────────────────────────────────────────────────────────────────
// single-flight — concurrent fires → one grant
// ──────────────────────────────────────────────────────────────────────────

describe('single-flight — concurrent fires for one org → one grant', () => {
  test('two concurrent withFreshOrgToken calls coalesce to a single refresh grant', async () => {
    const tmp = mkTmp('otf-sf-')
    const now = Date.now()
    setSystemTime(now)

    const vault = new OrgVault(join(tmp, 'vault.json'))
    vault.upsert({
      orgId: 'org-sf', accessToken: 'sf-0', refreshToken: 'sf-rt-0',
      expiresAt: now - MIN, capturedAt: now - HOUR,   // expired → due
    })
    const refresher = fakeRefresher(() => ({ accessToken: 'sf-1', refreshToken: 'sf-rt-1', expiresAt: now + 8 * HOUR }))
    // add latency so both callers overlap
    const slow = async (rt: string) => { await new Promise(r => setTimeout(r, 15)); return refresher(rt) }
    Object.defineProperty(slow, 'count', { get: () => refresher.calls.length })

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault, oauthRefresher: slow,
    }, tmp)

    const [a, b] = await Promise.all([
      c._withFreshOrgToken('org-sf'),
      c._withFreshOrgToken('org-sf'),
    ])
    expect(refresher.calls.length).toBe(1)                        // coalesced to ONE grant
    expect(a).toBe('sf-1')
    expect(b).toBe('sf-1')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// T4.3 — session-pin GC: retire long-dead pins, keep fresh, never drop orgs
// ──────────────────────────────────────────────────────────────────────────

describe('T4.3 — session-pin GC', () => {
  test('retires a pin unseen > N days with no live session; keeps a recently-seen pin; orgs untouched', () => {
    const tmp = mkTmp('otf-gc-')
    const now = Date.now()
    const DAY = 24 * HOUR

    const vault = new OrgVault(join(tmp, 'vault.json'))
    vault.upsert({ orgId: 'org-A', accessToken: 'a', refreshToken: 'ra', expiresAt: now + HOUR, capturedAt: now })
    vault.upsert({ orgId: 'org-B', accessToken: 'b', refreshToken: 'rb', expiresAt: now + HOUR, capturedAt: now })
    // A stale pin: last seen 10 days ago (watermark recorded at that clock).
    setSystemTime(now - 10 * DAY)
    vault.setPin('dead-sess', 'org-A')
    // A fresh pin: seen just now.
    setSystemTime(now)
    vault.setPin('live-sess', 'org-B')

    const c = mkClient({
      orgIdResolver: { current: () => null, invalidate() {} },
      orgVault: vault,
    }, tmp)
    // No sessions are live in the store → age alone decides retirement.

    c._gcSessionPins(now)

    expect(vault.getPin('dead-sess')).toBeNull()                 // unseen > 7d, not live → retired
    expect(vault.getPin('live-sess')).toEqual({ orgId: 'org-B' })// seen < 7d → kept
    // GC NEVER drops an org credential.
    expect(vault.get('org-A')).toBeTruthy()
    expect(vault.get('org-B')).toBeTruthy()
    expect(vault.list().length).toBe(2)
  })
})
