/**
 * Anthropic module — POST /v1/messages passthrough with subscription enrichment.
 *
 * Native CC clients pass through unchanged. Third-party Anthropic SDK clients
 * get enrichment (betas, billing, metadata, cache markers) making their
 * requests indistinguishable from native CC.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { enrichAnthropicRequest } from '../openai-translate.js'
import { captureBody } from '../body-capture.js'
import { resolvePidFromPort as resolvePidFromPeerPort } from '../session-tracker.js'

let ctx: ModuleContext

export function createAnthropicModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    {
      method: 'POST',
      path: '/v1/messages',
      handler: async (req, server) => {
        const sessionId = req.headers.get('x-claude-code-session-id') ?? 'anon-' + Date.now().toString(36)

        const peer = server.requestIP(req)
        const srcPort = peer?.port ?? null
        const sourcePid = srcPort ? resolvePidFromPeerPort(srcPort) : null

        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => { if (k.toLowerCase() !== 'x-api-key') headers[k] = v })

        const rawBody = await req.arrayBuffer()
        const rawBodyStr = new TextDecoder().decode(rawBody)

        const isNativeCC = headers['user-agent']?.includes('claude-cli/') || !!headers['x-claude-code-agent-id']
        let forwardBody: string | ArrayBuffer = rawBody
        let forwardHeaders = headers
        if (!isNativeCC) {
          const enriched = enrichAnthropicRequest(rawBodyStr, headers, sessionId)
          forwardBody = enriched.body
          forwardHeaders = enriched.headers
        }

        captureBody(rawBody, headers, { sessionId, sourcePid, srcPort })

        return ctx.proxyClient.handleRequest(forwardBody, forwardHeaders, {
          sessionId,
          sourcePid,
          signal: req.signal,
          // Native Claude Code = interactive human (can see a 400 + re-send with
          // marker). Any other Anthropic-API consumer is programmatic → the
          // rewrite guard's interactive-only mode lets it through.
          interactive: isNativeCC,
        })
      },
    },
  ]

  return {
    name: 'anthropic',
    routes,
    init(c) { ctx = c },
  }
}
