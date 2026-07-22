/**
 * Real-request active-org 401 backstop — the P0 DRIFT fix.
 *
 * The validation of Task 1 (validation-p0.md) found a drift: on the REAL
 * request path a stale active-org token that 401'd did ONLY
 * `credentials.invalidate()` (re-read the SAME stale disk token) — it did NOT
 * force a refresh. 401 is not a TRANSIENT_UPSTREAM_STATUS, so it isn't retried,
 * and `handleOrg401` was wired only into the KA `onAuthError` hook. This drove
 * `handleRequest`'s upstream-401 branch through `handleOrg401(servedOrg,
 * sentToken)` so a stale-token 401 now force-refreshes and self-heals, while a
 * genuine revoke still classifies via the per-org cooldown (one attempt, no
 * endpoint hammering).
 *
 * These tests drive the ACTUAL `handleRequest` path (not the choke-point seam)
 * with a mocked upstream that 401s the stale token and 200s the fresh one.
 */

import { describe, test, expect, setSystemTime, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { OrgVault } from '../src/org-vault.js'
import { OAuthRefreshError, type RefreshedTokens } from '../src/auth.js'
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

function collector() {
  const events: Array<Record<string, unknown>> = []
  return { events, emitter: { emit: (e: Record<string, unknown>) => { events.push(e) } } }
}

function fakeRefresher(script: (n: number) => RefreshedTokens) {
  const calls: number[] = []
  const fn = async (): Promise<RefreshedTokens> => { calls.push(1); return script(calls.length) }
  ;(fn as unknown as { calls: number[] }).calls = calls
  return fn as typeof fn & { calls: number[] }
}

const fakeLock = async () => async () => {}

const FILLER = 'lorem ipsum dolor sit amet '.repeat(40)
const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'system prompt ' + FILLER, cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

function okResponse() {
  return new Response(
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )
}
function err401() {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'OAuth access token has expired' } }),
    { status: 401, headers: { 'content-type': 'application/json' } },
  )
}

function writeCreds(path: string, accessToken: string, refreshToken: string, expiresAt: number) {
  writeFileSync(path, JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken, expiresAt, scopes: ['user:inference'], subscriptionType: 'max' },
  }))
}

function mkActiveClient(
  tmp: string,
  extra: Partial<ProxyClientOptions>,
): { c: ProxyClient; configDir: string; credPath: string } {
  const configDir = join(tmp, '.claude')
  mkdirSync(configDir, { recursive: true })
  const credPath = join(configDir, '.credentials.json')
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 3600, orgProactiveRefreshSec: 0 },
    credentialsProvider: new FileCredentialsProvider({ path: credPath }),
    orgIdResolver: { current: () => 'org-active', invalidate() {} },
    orgVault: new OrgVault(join(tmp, 'vault.json')),
    claudeConfigDir: configDir,
    credentialsPath: credPath,
    acquireConfigLock: fakeLock,
    prefixHistoryPath: join(tmp, 'ph.json'),
    kaSnapshotPath: join(tmp, 'ka.json'),
    rewriteBlockDumpDir: join(tmp, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
  clients.push(c)
  return { c, configDir, credPath }
}

describe('real-request active-org 401 backstop (P0 drift)', () => {
  test('stale active-org token 401 → handleOrg401 force-refreshes (not just invalidate) → recovery', async () => {
    const tmp = mkTmp('otf-401s-')
    const now = Date.now()
    setSystemTime(now)

    // Refresh grant returns a fresh token.
    const refresher = fakeRefresher(() => ({
      accessToken: 'ACT-fresh', refreshToken: 'ACT-rt2', expiresAt: now + 8 * HOUR, scopes: ['user:inference'],
    }))
    // Upstream rejects the stale token (401), accepts the fresh one (200).
    const upstreamFetcher = {
      fetch: async (_url: string, init: { headers: Record<string, string> }) => {
        return init.headers['Authorization'] === 'Bearer ACT-fresh' ? okResponse() : err401()
      },
    }

    const { c, credPath } = mkActiveClient(tmp, { oauthRefresher: refresher, upstreamFetcher })
    // Disk holds a still-unexpired (30 min) BUT server-rejected token: this
    // isolates the FORCE path — a non-expired token would be skipped by the
    // proactive expiry gate, so only force-on-401 can refresh it.
    writeCreds(credPath, 'ACT-stale', 'ACT-rt', now + 30 * MIN)

    // First request sends the stale token → upstream 401 → the backstop must
    // FORCE a refresh (grant) and co-write disk — not merely invalidate.
    const r1 = await c.handleRequest(reqBody(), {}, { sessionId: 's-401' })
    expect(r1.status).toBe(401)
    expect(refresher.calls.length).toBe(1)                       // a real grant fired (drift closed)
    const disk = JSON.parse(readFileSync(credPath, 'utf8')).claudeAiOauth
    expect(disk.accessToken).toBe('ACT-fresh')                  // refreshActiveOrg co-wrote disk
    expect(disk.subscriptionType).toBe('max')                   // profile preserved

    // Second request now re-reads the fresh disk token → self-heals (200).
    const r2 = await c.handleRequest(reqBody(), {}, { sessionId: 's-401' })
    expect(r2.status).toBe(200)
  })

  test('revoked refresh_token → ONE grant attempt across sessions → cooldown + relogin-once, no hammering', async () => {
    const tmp = mkTmp('otf-401r-')
    const now = Date.now()
    setSystemTime(now)

    const refresher = fakeRefresher(() => { throw new OAuthRefreshError(400, '{"error":"invalid_grant"}') })
    const upstreamFetcher = { fetch: async () => err401() }   // grant fails → token stays stale → always 401
    const { events, emitter } = collector()

    const { c, credPath } = mkActiveClient(tmp, {
      oauthRefresher: refresher, upstreamFetcher, eventEmitter: emitter,
    })
    writeCreds(credPath, 'ACT-stale', 'ACT-rt', now + 30 * MIN)

    // Five distinct sessions all served by the active org each 401 — the REARM
    // analogue on the real path. The per-org cooldown must cap this at ONE grant
    // attempt total, and emit ORG_TOKEN_NEEDS_RELOGIN exactly once.
    for (let i = 0; i < 5; i++) {
      const r = await c.handleRequest(reqBody(), {}, { sessionId: `rev-${i}` })
      expect(r.status).toBe(401)
    }

    expect(refresher.calls.length).toBe(1)                       // exactly one endpoint hit (no hammering)
    const cd = c._orgCooldown('org-active')!
    expect(cd.needsRelogin).toBe(true)
    expect(cd.until).toBeGreaterThan(now)
    expect(events.filter(e => e.kind === 'ORG_TOKEN_NEEDS_RELOGIN').length).toBe(1)
  })
})
