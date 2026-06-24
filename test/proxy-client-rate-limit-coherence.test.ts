/**
 * proxy-client — REAL_REQUEST_COMPLETE rate-limit is per-request, not the shared
 * this.lastRateLimit field (cross-org quota contamination, 2026-06-24).
 *
 * REAL_REQUEST_COMPLETE fires from parseSSEAndNotify AFTER the response body has
 * streamed (up to ~60s). It used to read the instance-shared this.lastRateLimit,
 * which every request overwrites at header-parse time. With two orgs served
 * concurrently through the one proxy, a request that finished streaming emitted
 * whatever org's utilisation was parsed MOST RECENTLY — so a b3219c9b request
 * emitted f9420373's 7d=0.99 under org=b3219c9b. The per-org quota pipeline then
 * showed a healthy session the exhausted org's number (false-critical) and an
 * exhausted session the healthy number (false-OK), feeding BOTH the badge and the
 * agent's quota gate.
 *
 * Fix: capture the rate-limit in handleRequest's request scope and pass it to
 * parseSSEAndNotify, so each completion emits ITS OWN response's utilisation.
 *
 * This test forces the race: request A's body stream is gated open while request
 * B completes and overwrites this.lastRateLimit; A must still emit its own value.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'rl-coherence-'))
let seq = 0

const FILLER = 'lorem ipsum dolor sit amet '.repeat(40)
const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'system prompt ' + FILLER, cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

const SSE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

/** SSE response carrying a specific 7d-utilisation + serving-org header. */
function resp(util7d: string, org: string, stream: ReadableStream<Uint8Array>) {
  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-7d-utilization': util7d,
      'anthropic-ratelimit-unified-5h-utilization': util7d,
      'anthropic-organization-id': org,
    },
  })
}
function immediateStream() {
  return new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(SSE_STOP)); c.close() },
  })
}
/** A stream that only emits (and closes) once `gate` resolves. */
function gatedStream(gate: Promise<void>) {
  return new ReadableStream<Uint8Array>({
    async start(c) {
      await gate
      c.enqueue(new TextEncoder().encode(SSE_STOP))
      c.close()
    },
  })
}

function mkClient(fetcher: ProxyClientOptions['upstreamFetcher'], events: any[]) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: fetcher,
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => events.push(e) },
  })
}

describe('proxy-client — per-request rate-limit coherence', () => {
  test('a completion emits ITS OWN response rate-limit, not a concurrent overwrite', async () => {
    const events: any[] = []
    let releaseA!: () => void
    const aGate = new Promise<void>((r) => { releaseA = r })

    let n = 0
    const c = mkClient({
      fetch: async () => {
        n += 1
        // 1st call (session A): healthy org, util7d=0.50, body gated open.
        // 2nd call (session B): exhausted org, util7d=0.99, body completes now.
        return n === 1
          ? resp('0.50', 'orgA', gatedStream(aGate))
          : resp('0.99', 'orgB', immediateStream())
      },
    }, events)

    // A starts; its parseSSEAndNotify blocks on the gated body (mid-stream).
    const rA = await c.handleRequest(reqBody(), {}, { sessionId: 'sesA' })
    // Drain A's client-facing tee so backpressure never stalls the parse side.
    void rA.body?.cancel().catch(() => {})

    // B runs to completion → parses util7d=0.99 into the shared this.lastRateLimit.
    const rB = await c.handleRequest(reqBody(), {}, { sessionId: 'sesB' })
    void rB.body?.cancel().catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    expect((c as any).lastRateLimit.utilization7d).toBe(0.99) // shared field now B's

    // Now let A finish streaming → it emits REAL_REQUEST_COMPLETE.
    releaseA()
    for (let i = 0; i < 50; i++) {
      if (events.some((e) => e.kind === 'REAL_REQUEST_COMPLETE' && e.sessionId === 'sesA')) break
      await new Promise((r) => setTimeout(r, 10))
    }

    const aDone = events.find((e) => e.kind === 'REAL_REQUEST_COMPLETE' && e.sessionId === 'sesA')
    const bDone = events.find((e) => e.kind === 'REAL_REQUEST_COMPLETE' && e.sessionId === 'sesB')
    expect(aDone).toBeDefined()
    expect(bDone).toBeDefined()
    // The fix: A emits its OWN 0.50 even though the shared field holds B's 0.99.
    expect(aDone.rateLimit.util7d).toBe(0.50)
    expect(bDone.rateLimit.util7d).toBe(0.99)
    c.stop()
  })
})
