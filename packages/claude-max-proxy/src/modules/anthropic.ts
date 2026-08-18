/**
 * Anthropic module — POST /v1/messages passthrough with subscription enrichment.
 *
 * Native CC clients pass through unchanged. Third-party Anthropic SDK clients
 * get enrichment (betas, billing, metadata, cache markers) making their
 * requests indistinguishable from native CC.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { extractSessionIdFromBody } from '@life-ai-tools/claude-code-sdk'
import { enrichAnthropicRequest , clampEffortIfThinkingDisabled } from '../openai-translate.js'
import { captureBody } from '../body-capture.js'
import { resolvePidFromPort as resolvePidFromPeerPort } from '../session-tracker.js'

let ctx: ModuleContext

export function createAnthropicModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    {
      method: 'POST',
      path: '/v1/messages',
      handler: async (req, server) => {
        const peer = server.requestIP(req)
        const srcPort = peer?.port ?? null
        const sourcePid = srcPort ? resolvePidFromPeerPort(srcPort) : null

        const headers: Record<string, string> = {}
        req.headers.forEach((v, k) => { if (k.toLowerCase() !== 'x-api-key') headers[k] = v })

        const rawBody = await req.arrayBuffer()
        const rawBodyStr = new TextDecoder().decode(rawBody)

        // ── WHO IS ASKING — two doors, then honesty ──────────────────
        // The header is the front door. An Agent-SDK-spawned agent has no
        // header but still carries its session UUID inside `metadata.user_id`,
        // so the body is the second door — `extractSessionIdFromBody` was
        // written and tested for exactly this and then sat with no caller,
        // because the wiring only ever existed as a hand-edit in the DEPLOYED
        // copy and the first manifest deploy erased it (Rule #15).
        //
        // When BOTH doors are shut the request is genuinely unnamed — a
        // stateless one-shot call, not a lost agent (measured: of the anon
        // requests whose bodies were captured, not one carried a recoverable
        // id). It is forwarded, and `idSource: 'none'` tells the client to
        // serve it WITHOUT arming keepalive: an id minted per request can
        // never be matched again, so its cache slot would be warmed forever
        // for nobody.
        const headerSession = req.headers.get('x-claude-code-session-id')
        const bodySession = headerSession ? null : extractSessionIdFromBody(rawBodyStr)
        const resolvedSession = headerSession ?? bodySession
        const idSource: 'header' | 'body' | 'none' =
          headerSession ? 'header' : bodySession ? 'body' : 'none'
        const sessionId = resolvedSession ?? 'anon-' + Date.now().toString(36)

        const isNativeCC = headers['user-agent']?.includes('claude-cli/') || !!headers['x-claude-code-agent-id']
        let forwardBody: string | ArrayBuffer = rawBody
        let forwardHeaders = headers
        if (!isNativeCC) {
          const enriched = enrichAnthropicRequest(rawBodyStr, headers, sessionId)
          forwardBody = enriched.body
          forwardHeaders = enriched.headers
        } else {
          // 🔴 REQUEST-VALIDITY REPAIR — must reach NATIVE Claude Code too.
          // Enrichment above is subscription-compat and is deliberately skipped for the
          // native CLI, which forwards its body untouched. But the effort/thinking clamp is
          // not compat: the API REJECTS `output_config.effort: xhigh` when thinking is
          // disabled, and the client composes exactly that pair for its server-side tool
          // calls — so every web search from a native agent at xhigh returned 400 while the
          // clamp sat on the branch those agents never take. It shipped "verified" because
          // the verifying curl had no `claude-cli/` user-agent and took the enriched path.
          try {
            const parsed = JSON.parse(rawBodyStr) as Record<string, unknown>
            if (clampEffortIfThinkingDisabled(parsed)) forwardBody = JSON.stringify(parsed)
          } catch {
            // Not JSON (or malformed) — forward untouched; this repair must never be able
            // to break a request it does not understand.
          }
        }

        captureBody(rawBody, headers, { sessionId, sourcePid, srcPort })

        return ctx.proxyClient.handleRequest(forwardBody, forwardHeaders, {
          sessionId,
          sourcePid,
          idSource,
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
