/**
 * The predicted cost has to come from the comparison, not from the body size.
 *
 * 🔴 WHAT THIS REPLACES. Every class shared one line — `bodyBytes / 4` — on the
 * assumption that a diverged prefix re-caches everything. For the commonest
 * class that was wrong by a factor of sixty-six: measured 2026-09-03 over a day
 * of fleet traffic, 567 `expected:tools-changed` predictions promised 137M
 * tokens and 2M were written; 12 came true. A live pair: promised 988 629,
 * wrote 807, read 967 105 back.
 *
 * They were all the same event — a tool schema fetched on demand and APPENDED.
 * The founder put the principle plainly (2026-09-03): the marker should fire on
 * what the comparison found, not on a guess. The comparison was always factual;
 * the price was the guess.
 *
 * So: growth is priced as growth. Removal, redefinition, a dead cache and a
 * move to another account keep the whole-body figure, because there the whole
 * body really is at risk.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'pred-cost-'))
let seq = 0

function mkClient(events: any[]) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 3600 },
    credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-x' },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => events.push(e) },
  } as never)
}

const HISTORY = 'x'.repeat(400_000)   // a large conversation — the thing that used to set the price
const tool = (name: string, size = 200) => ({ name, description: 'd'.repeat(size), input_schema: { type: 'object' } })

// The consent marker rides in every turn: the fixture's cache guard blocks a
// first write this large, and a blocked turn never records prefix history — so
// without it the second turn looks like another cold start and the case under
// test never arises.
const bodyWith = (tools: any[]) => JSON.stringify({
  model: 'claude-opus-5',
  system: [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools,
  messages: [{ role: 'user', content: HISTORY + ' [cache-rewrite-ok]' }],
})

async function turn(c: ProxyClient, sid: string, tools: any[]) {
  const r = await c.handleRequest(bodyWith(tools), {}, { sessionId: sid })
  await r.text()
}
const prediction = (events: any[]) => [...events].reverse().find(e => e.kind === 'PREDICTED_CACHE_MISS')

describe('a predicted price that was measured, not assumed', () => {
  test('a tool APPENDED costs the weight of that tool, not the weight of the conversation', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    await turn(c, 's1', [tool('a'), tool('b')])
    ev.length = 0
    await turn(c, 's1', [tool('a'), tool('b'), tool('c')])
    const p = prediction(ev)
    expect(p.rewriteClass).toBe('expected:tools-changed')
    // One ~200-byte schema — hundreds of tokens, not the ~100k the 400KB
    // conversation would have produced under the old line.
    expect(p.predictedTokens).toBeLessThan(2_000)
    expect(p.predictedTokens).toBeGreaterThan(0)
    await c.stop()
  })

  test('the old behaviour is what this replaces — the body would have priced it ~100k', async () => {
    // Guards the test above against passing for the wrong reason: if the body
    // were small, "less than 2000" would prove nothing.
    expect(Math.round(bodyWith([tool('a')]).length / 4)).toBeGreaterThan(100_000)
  })

  test('a tool REMOVED keeps the whole-body figure — that prefix really diverged', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    await turn(c, 's2', [tool('a'), tool('b'), tool('c')])
    ev.length = 0
    await turn(c, 's2', [tool('a'), tool('b')])
    const p = prediction(ev)
    expect(p.rewriteClass).toBe('expected:tools-changed')
    expect(p.predictedTokens).toBeGreaterThan(50_000)
    await c.stop()
  })

  test('a tool REPLACED keeps the whole-body figure — a swap is not growth', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    await turn(c, 's3', [tool('a'), tool('b')])
    ev.length = 0
    await turn(c, 's3', [tool('a'), tool('c')])   // b out, c in
    const p = prediction(ev)
    expect(p.rewriteClass).toBe('expected:tools-changed')
    expect(p.predictedTokens).toBeGreaterThan(50_000)
    await c.stop()
  })

  test('two appended tools cost twice one — the figure tracks what arrived', async () => {
    const evA: any[] = []
    const a = mkClient(evA)
    await turn(a, 's5', [tool('a')])
    evA.length = 0
    await turn(a, 's5', [tool('a'), tool('b', 1000)])
    const one = prediction(evA).predictedTokens

    const evB: any[] = []
    const b = mkClient(evB)
    await turn(b, 's6', [tool('a')])
    evB.length = 0
    await turn(b, 's6', [tool('a'), tool('b', 1000), tool('c', 1000)])
    const two = prediction(evB).predictedTokens

    // Not an exact ×2 (names and JSON scaffolding differ), but it must MOVE
    // with the payload — the old figure was identical in both cases, because
    // it only ever looked at the conversation.
    expect(two).toBeGreaterThan(one * 1.5)
    await a.stop(); await b.stop()
  })

  /**
   * 🔴 A CASE THIS DOES NOT COVER, NAMED SO THE NEXT READER DOES NOT ASSUME IT DOES.
   * A tool REDEFINED under the SAME NAME produces no prediction at all: the
   * lineage key is built from tool NAMES, so the request looks unchanged and
   * the predictor stays silent. `toolsetGrowth` refuses to call that growth,
   * but nothing ever asks it. Whether that silence is right is a separate
   * question from this file's subject, and it is not answered here.
   */
})
