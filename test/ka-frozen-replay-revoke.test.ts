/**
 * Regression: re-login-revoke of a FROZEN (org-switch-pending) idle session.
 *
 * Incident (2026-07-23, proxy 1.0.18, session ab787846 pinned to org 02b4bfd1):
 * a native-CLI RE-LOGIN to the held org revoked its OAuth token server-side and
 * wrote a fresh one. Sessions that were HELD cross-org (orgSwitchPending) and
 * then went IDLE kept replaying the FROZEN snapshot token in their keepalive.
 * When the re-login revoked it, every KA fire + every retry 401'd on the SAME
 * dead frozen token — `usePendingAuth` stayed true, so getToken() /
 * withFreshOrgToken were never consulted — until `auth_retry_exhausted` →
 * disarm → the warm cache aged past TTL and died (`CACHE_REWRITE_BLOCKED
 * avoidable:ttl-expiry`). An idle held session issues no real request, so its
 * `orgSwitchPending` flag never cleared: it could never self-heal. Meanwhile a
 * VALID token existed the whole time (594 successful requests on that org in the
 * window) — the frozen sessions simply never adopted it.
 *
 * Fix A (engine): a KA 401 on a frozen lineage THAWS the freeze
 * (`thawOrgSwitchPendingOnAuth`) so the retry chain + subsequent fires rebuild
 * auth from getToken() → the served org's CURRENT valid token.
 *
 * Fix B (proxy): `notifyCredentialsChanged` PROACTIVELY thaws frozen sessions
 * served by the changed org, so recovery does not wait for a 401 that (for an
 * idle session) may never resolve — collapsing thousands of reactive per-session
 * recoveries into one push.
 */

import { describe, test, expect, setSystemTime, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const RL: RateLimitInfo = {
  status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0,
}
const sys = (ttl = '1h') => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
})

// ─── Fix A — engine-level frozen-replay fall-through ───────────────────────

describe('KeepaliveEngine — frozen-replay revoke recovers instead of dying', () => {
  test('idle FROZEN session, frozen token REVOKED → thaws, adopts fresh token on retry, NEVER disarms', async () => {
    const t0 = Date.now()
    setSystemTime(t0)

    // The org's CURRENT valid token (what withFreshOrgToken would resolve for
    // the held org). getToken() returns it; the FROZEN snapshot token is 'OLD'.
    const FRESH = 'FRESH-valid'
    const authSeen: string[] = []
    let disarmReason: string | null = null

    const e = new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed: (i) => { disarmReason = i.reason } },
      getToken: async () => FRESH,
      // Force-on-401 backstop: no-op here (the vault already holds FRESH); the
      // recovery must come from the thaw → getToken() path, not the backstop.
      onAuthError: async () => {},
      doFetch: async function* (_body, headers): AsyncGenerator<StreamEvent> {
        const auth = headers.Authorization
        authSeen.push(auth)
        if (auth === 'Bearer OLD') {
          // The re-login REVOKED the frozen snapshot token.
          throw Object.assign(new Error('OAuth access token has been revoked'), { status: 401 })
        }
        yield { type: 'message_stop', usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0 }, stopReason: 'end_turn' } as StreamEvent
      },
      getRateLimitInfo: () => RL,
    })
    ;(e as any).retryDelaysMs = [20]   // fast retry so the test doesn't wait

    // Arm on the OLD (held) token and FREEZE the lineage (the cross-org HOLD).
    const lk = e.notifyRealRequestStart('claude-opus-4-7', sys(), { Authorization: 'Bearer OLD' })
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 5, cacheReadInputTokens: 0 } as any, lk)
    e.markOrgSwitchPending(lk)
    expect(e._orgSwitchPending.has(lk)).toBe(true)

    // Idle long enough to fire; clocks aged so the retry's "real request since?" guard passes.
    e._setCacheWrittenAt(t0 - 1_000)
    ;(e as any).lastActivityAt = t0 - 200_000
    ;(e as any).lastRealActivityAt = t0 - 200_000
    { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = t0 - 200_000 }
    ;(e as any).jitterMs = 0

    await e._tick()                                 // fire #1 replays 'Bearer OLD' → 401 (revoked)
    await new Promise((r) => setTimeout(r, 120))    // let the thawed retry fire
    const registrySize = e._registry.size           // capture BEFORE stop()
    e.stop()
    setSystemTime()

    expect(authSeen[0]).toBe('Bearer OLD')                     // first fire used the frozen token
    expect(authSeen).toContain(`Bearer ${FRESH}`)              // retry ADOPTED the fresh token
    expect(e._orgSwitchPending.has(lk)).toBe(false)            // freeze THAWED on the 401
    expect(disarmReason).toBeNull()                            // NEVER disarmed → cache survives
    expect(registrySize).toBeGreaterThan(0)                    // still armed (warm snapshot kept)
  })

  test('pre-fix failure mode is closed: a persistently-revoked frozen token no longer loops forever on the frozen token', async () => {
    const t0 = Date.now()
    setSystemTime(t0)
    const authSeen: string[] = []
    const e = new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100 },
      getToken: async () => 'CURRENT',                 // even the current token is (for this test) also revoked
      onAuthError: async () => {},
      doFetch: async function* (_b, headers): AsyncGenerator<StreamEvent> {
        authSeen.push(headers.Authorization)
        throw Object.assign(new Error('revoked'), { status: 401 })
        // eslint-disable-next-line no-unreachable
        yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 1 }, stopReason: 'end_turn' } as StreamEvent
      },
      getRateLimitInfo: () => RL,
    })
    ;(e as any).retryDelaysMs = [10]
    const lk = e.notifyRealRequestStart('claude-opus-4-7', sys(), { Authorization: 'Bearer OLD' })
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 5, cacheReadInputTokens: 0 } as any, lk)
    e.markOrgSwitchPending(lk)
    e._setCacheWrittenAt(t0 - 1_000)
    ;(e as any).lastActivityAt = t0 - 200_000
    ;(e as any).lastRealActivityAt = t0 - 200_000
    { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = t0 - 200_000 }
    ;(e as any).jitterMs = 0

    await e._tick()
    await new Promise((r) => setTimeout(r, 80))
    e.stop()
    setSystemTime()

    // The freeze is dropped on the very first 401 — so the retry no longer
    // replays the frozen token; it rebuilds from getToken() ('CURRENT'). Even a
    // still-revoked org then surfaces via the normal auth path (getToken token),
    // never an unbounded loop on the DEAD FROZEN token.
    expect(e._orgSwitchPending.has(lk)).toBe(false)
    expect(authSeen[0]).toBe('Bearer OLD')
    expect(authSeen.slice(1).every(a => a === 'Bearer CURRENT')).toBe(true)  // retries use getToken, not the frozen token
  })
})

// ─── Fix B — proxy-level proactive reconcile on credentials-change ─────────

const TMP = mkdtempSync(join(tmpdir(), 'frozen-revoke-'))
const clients: ProxyClient[] = []
let seq = 0
afterEach(() => { for (const c of clients.splice(0)) { try { c.stop() } catch {} } })

function recordingUpstream(sink: { auth: string[] }) {
  return {
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      sink.auth.push(init.headers['authorization'] ?? init.headers['Authorization'] ?? '')
      return new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } })
    },
  }
}
function mutableAccount(init: { orgId: string | null; token: string; expiresAt: number | null }) {
  const state = { ...init }
  return {
    state,
    credentialsProvider: { getAccessToken: async () => state.token, invalidate() {}, currentExpiresAt: () => state.expiresAt },
    orgIdResolver: { current: () => state.orgId, invalidate() {} },
  }
}
function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 3600, orgProactiveRefreshSec: 0 },
    credentialsProvider: { getAccessToken: async () => 'fake', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
  clients.push(c)
  return c
}
const FILLER = 'x'.repeat(6000)
const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

describe('ProxyClient — credentials-change proactively thaws frozen sessions on the changed org', () => {
  test('a re-login to the held org unfreezes its held session BEFORE any 401 (one proactive push)', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })

    // 1) Bind session to org-A/tok-A.
    await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })
    // 2) User logs into org-B → the session HOLDS org-A and its lineage FREEZES.
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'
    await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })
    expect(auth.at(-1)).toBe('Bearer tok-A')                   // held
    expect(c._sessionFrozenLineages('s-hold')).toBeGreaterThan(0)  // frozen

    // 3) RE-LOGIN back to org-A with a fresh token (revokes the old one). org-A
    //    is active again → the held session's served org matches the changed org.
    m.state.orgId = 'org-A'; m.state.token = 'tok-A2'
    c._reconcileFrozenSessionsForChangedOrg()

    // Proactively thawed — no 401 needed. The next KA fire rebuilds from
    // getToken() (org-A's CURRENT token), never the revoked frozen one.
    expect(c._sessionFrozenLineages('s-hold')).toBe(0)
  })

  test('a session frozen on a DIFFERENT org than the one that changed is NOT thawed (no premature migration)', async () => {
    const auth: string[] = []
    const m = mutableAccount({ orgId: 'org-A', token: 'tok-A', expiresAt: Date.now() + 3_600_000 })
    const c = mkClient({ credentialsProvider: m.credentialsProvider, orgIdResolver: m.orgIdResolver, upstreamFetcher: recordingUpstream({ auth }) })
    await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })   // pin org-A
    m.state.orgId = 'org-B'; m.state.token = 'tok-B'                // switch to org-B → hold org-A, freeze
    await c.handleRequest(reqBody(), {}, { sessionId: 's-hold' })
    expect(c._sessionFrozenLineages('s-hold')).toBeGreaterThan(0)

    // A credentials change while the active org is still org-B (NOT org-A).
    // The held session is served by org-A ∉ {org-B} → left frozen (its hold on
    // A is intentional; only Fix-A's 401 fall-through would thaw it if A's token
    // actually died).
    c._reconcileFrozenSessionsForChangedOrg()
    expect(c._sessionFrozenLineages('s-hold')).toBeGreaterThan(0)   // untouched
  })
})
