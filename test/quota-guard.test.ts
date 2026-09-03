/**
 * Quota guard — end-to-end integration test.
 *
 * Drives ProxyClient.handleRequest() with a mocked upstream that answers the
 * way Anthropic does near the ceiling: an `anthropic-organization-id` naming
 * the serving account and an `anthropic-ratelimit-unified-5h-utilisation`
 * reading. The guard is enabled by the shared fixture at 0.95.
 *
 * What these pin down — the behaviour the 2026-09-03 incident asked for:
 *   * a real turn is refused only once the ACCOUNT it would spend from is at
 *     or past the stop line, and only after a reading exists to judge;
 *   * the account is read PER ORG, so a full account never stops a session
 *     working on an empty one (that mistake already cost us once: 2026-06-24,
 *     one session emitting another org's utilisation under its own label);
 *   * both consent channels release the turn;
 *   * the refusal opens with the marker downstream watchers key on.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { grantConsent } from '../src/rewrite-consent.js'

const GRANT_PATH = '/tmp/__test_quota_guard_grants.json'
const TMP = mkdtempSync(join(tmpdir(), 'quota-guard-'))
let seq = 0

/** Upstream that answers like Anthropic near (or far from) the 5h ceiling. */
function quotaUpstream(util5h: number, org = 'org-full') {
  return {
    fetch: async () => new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'anthropic-organization-id': org,
          'anthropic-ratelimit-unified-5h-utilization': String(util5h),
          'anthropic-ratelimit-unified-5h-reset': String(Math.floor(Date.now() / 1000) + 1800),
          'anthropic-ratelimit-unified-status': util5h >= 0.9 ? 'allowed_warning' : 'allowed',
        },
      },
    ),
  }
}

function mkClient(util5h: number, org = 'org-full', extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 3600 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: quotaUpstream(util5h, org),
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => org },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
}

const body = (extra = '') => JSON.stringify({
  model: 'claude-opus-4-7',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + extra }],
})

/** Drive one turn so the client learns this account's utilisation. */
async function prime(c: ProxyClient, sessionId: string) {
  const r = await c.handleRequest(body('prime'), {}, { sessionId })
  // The reading is recorded while the response streams — drain it first.
  await r.text()
  return r
}

describe('quota guard (e2e via handleRequest, guard enabled by fixture at 0.95)', () => {
  test('the FIRST turn is never blocked — there is no reading to judge yet', async () => {
    const c = mkClient(0.99)
    const r = await c.handleRequest(body(), {}, { sessionId: 'qg-first' })
    expect(r.status).not.toBe(400)
    await c.stop()
  })

  test('a turn on an account at 0.97 is refused once the reading exists', async () => {
    const c = mkClient(0.97)
    await prime(c, 'qg-block')
    const r = await c.handleRequest(body('second'), {}, { sessionId: 'qg-block' })
    expect(r.status).toBe(400)
    const j: any = await r.json()
    expect(j.error.type).toBe('quota_guard')
    expect(j.error.util5h).toBeCloseTo(0.97, 5)
    expect(j.error.threshold).toBeCloseTo(0.95, 5)
    await c.stop()
  })

  test('the refusal opens with the marker downstream watchers key on', async () => {
    const c = mkClient(0.97)
    await prime(c, 'qg-marker')
    const r = await c.handleRequest(body('second'), {}, { sessionId: 'qg-marker' })
    const j: any = await r.json()
    // 🔴 CONTRACT: the CLI files an unknown-typed 400 as class `unknown`, so
    // this opening string is the only way a watcher can tell it is ours.
    expect(j.error.message.startsWith('Quota guard')).toBe(true)
    await c.stop()
  })

  test('the refusal names the account, the stop line and the way out', async () => {
    const c = mkClient(0.96)
    await prime(c, 'qg-fields')
    const r = await c.handleRequest(body('second'), {}, { sessionId: 'qg-fields' })
    const j: any = await r.json()
    expect(j.error.orgId).toBe('org-full')
    expect(j.error.resetAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(j.error.consent.marker).toBe('[quota-ok]')
    expect(j.error.consent.http).toContain('qg-fields')
    expect(j.error.consent.http).toContain('/admin/quota-ok')
    expect(j.error.message).toContain('cache stays warm')
    await c.stop()
  })

  test('an account BELOW the stop line is not touched', async () => {
    const c = mkClient(0.80)
    await prime(c, 'qg-low')
    const r = await c.handleRequest(body('second'), {}, { sessionId: 'qg-low' })
    expect(r.status).not.toBe(400)
    await c.stop()
  })

  test('the reading is PER ACCOUNT — a full account does not stop an empty one', async () => {
    // Two clients, two accounts, one shared process in production. The full
    // one must not speak for the empty one.
    const full = mkClient(0.99, 'org-full')
    await prime(full, 'qg-on-full')
    const blocked = await full.handleRequest(body('x'), {}, { sessionId: 'qg-on-full' })
    expect(blocked.status).toBe(400)

    const empty = mkClient(0.10, 'org-empty')
    await prime(empty, 'qg-on-empty')
    const allowed = await empty.handleRequest(body('x'), {}, { sessionId: 'qg-on-empty' })
    expect(allowed.status).not.toBe(400)
    await full.stop(); await empty.stop()
  })

  test('the in-message marker releases the turn', async () => {
    const c = mkClient(0.97)
    await prime(c, 'qg-consent-marker')
    const r = await c.handleRequest(body('[quota-ok] go on'), {}, { sessionId: 'qg-consent-marker' })
    expect(r.status).not.toBe(400)
    await c.stop()
  })

  test('an out-of-band grant releases the turn — the channel a sub-agent has', async () => {
    const c = mkClient(0.97)
    await prime(c, 'qg-consent-grant')
    grantConsent(GRANT_PATH, 'qg-consent-grant', 180)
    const r = await c.handleRequest(body('second'), {}, { sessionId: 'qg-consent-grant' })
    expect(r.status).not.toBe(400)
    await c.stop()
  })

  test('the grant is single-use — the next turn is refused again', async () => {
    const c = mkClient(0.97)
    await prime(c, 'qg-grant-once')
    grantConsent(GRANT_PATH, 'qg-grant-once', 180)
    const first = await c.handleRequest(body('a'), {}, { sessionId: 'qg-grant-once' })
    await first.text()
    const second = await c.handleRequest(body('b'), {}, { sessionId: 'qg-grant-once' })
    expect(second.status).toBe(400)
    await c.stop()
  })
})
