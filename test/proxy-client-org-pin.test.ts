/**
 * Per-session org/token pinning — e2e via ProxyClient.handleRequest().
 *
 * Spec:  docs/superpowers/specs/2026-06-02-per-session-org-token-pin-design.md
 * Plan:  docs/superpowers/plans/2026-06-02-per-session-org-token-pin.md
 *
 * Cross-org login must HOLD the old org+token per session (200, not 400);
 * same-org refresh adopts the fresh token; an explicit [%reload-ok%] / cli
 * reload rebinds; a cross-org pin whose old token expired forces a 401-stop.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'org-pin-'))
let seq = 0

/** Minimal SSE upstream that records the outgoing Authorization header. */
function recordingUpstream(sink: { auth: string[] }) {
  return {
    fetch: async (_url: string, init: { headers: Record<string, string> }) => {
      sink.auth.push(init.headers['authorization'] ?? init.headers['Authorization'] ?? '')
      return new Response(
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    },
  }
}

function mkClient(extra: Partial<ProxyClientOptions> = {}) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response('event: message_stop\ndata: {"type":"message_stop"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    ...extra,
  })
}

describe('Layer 1 — atomic account snapshot', () => {
  test('notifyCredentialsChanged invalidates BOTH credentials and org-id', () => {
    let creds = 0, org = 0
    const c = mkClient({
      credentialsProvider: { getAccessToken: async () => 't', invalidate() { creds++ } },
      orgIdResolver: { current: () => 'org-A', invalidate() { org++ } },
    })
    c.notifyCredentialsChanged('test')
    expect(creds).toBe(1)
    expect(org).toBe(1)
    c.stop()
  })
})
