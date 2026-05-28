/**
 * OpenAI-compat module — POST /v1/chat/completions, GET /v1/models, CORS.
 *
 * Translates OpenAI Chat Completions API to Anthropic format, routes through
 * ProxyClient (full KA/guard/session stack), translates response back.
 * GPT model names mapped to Claude equivalents.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { createHash } from 'crypto'
import { resolvePidFromPort as resolvePidFromPeerPort } from '../session-tracker.js'
import {
  type OAIChatRequest,
  translateToAnthropicBody,
  transformAnthropicSSEToOpenAI,
  bufferToNonStreaming,
  handleModelsRequest,
  openaiErrorResponse,
  corsPreflightResponse,
  enrichAnthropicRequest,
  type TransformOpts,
} from '../openai-translate.js'

let ctx: ModuleContext

export function createOpenAICompatModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    // CORS preflight
    {
      method: 'OPTIONS',
      path: '/v1/chat/completions',
      handler: async () => corsPreflightResponse(),
    },
    {
      method: 'OPTIONS',
      path: '/v1/models',
      handler: async () => corsPreflightResponse(),
    },

    // Model list
    {
      method: 'GET',
      path: '/v1/models',
      handler: async () => handleModelsRequest(),
    },

    // Chat completions
    {
      method: 'POST',
      path: '/v1/chat/completions',
      handler: async (req, server) => {
        const t0 = Date.now()

        let body: OAIChatRequest
        try { body = await req.json() as OAIChatRequest }
        catch { return openaiErrorResponse(400, 'Invalid JSON body', 'invalid_request_error') }

        if (!body.model) return openaiErrorResponse(400, 'model is required', 'invalid_request_error')
        if (!body.messages?.length) return openaiErrorResponse(400, 'messages is required', 'invalid_request_error')
        if (body.n && body.n > 1) return openaiErrorResponse(400, 'n > 1 is not supported', 'invalid_request_error')

        // Auth check
        if (ctx.config.openaiCompatAuthToken) {
          const authHeader = req.headers.get('authorization') ?? ''
          const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
          if (token !== ctx.config.openaiCompatAuthToken) {
            return openaiErrorResponse(401, 'Invalid API key', 'authentication_error', 'invalid_api_key')
          }
        }

        // Session ID resolution
        let sessionId = req.headers.get('x-claude-code-session-id') ?? ''
        if (!sessionId) {
          const authHeader = req.headers.get('authorization') ?? ''
          if (authHeader.startsWith('Bearer ') && authHeader.length > 20) {
            sessionId = 'openai-' + createHash('sha256').update(authHeader).digest('hex').slice(0, 8)
          }
        }
        if (!sessionId) {
          const peer = server.requestIP(req)
          sessionId = 'openai-' + (peer?.address ?? 'unknown')
        }

        const peer = server.requestIP(req)
        const srcPort = peer?.port ?? null
        const sourcePid = srcPort ? resolvePidFromPeerPort(srcPort) : null

        ctx.emit({
          level: 'info', kind: EVENT.OPENAI_COMPAT_REQUEST, sessionId,
          model: body.model, stream: body.stream !== false,
          hasTools: !!body.tools?.length, hasResponseFormat: !!body.response_format,
        })

        // Translate OpenAI → Anthropic
        let translation
        try { translation = translateToAnthropicBody(body) }
        catch (err: any) { return openaiErrorResponse(400, `Translation error: ${err?.message}`, 'invalid_request_error') }

        // Enrich with subscription betas/billing/cache
        const enriched = enrichAnthropicRequest(translation.body, {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
        }, sessionId)

        // Forward to ProxyClient
        const upstreamResponse = await ctx.proxyClient.handleRequest(
          enriched.body, enriched.headers, { sessionId, sourcePid, signal: req.signal },
        )

        // Error handling
        if (!upstreamResponse.ok && !upstreamResponse.body?.locked) {
          const errText = await upstreamResponse.text().catch(() => '')
          let errMessage = `Upstream error (${upstreamResponse.status})`
          let errType = 'api_error'
          try {
            const parsed = JSON.parse(errText)
            errMessage = parsed.error?.message ?? errMessage
            errType = parsed.error?.type ?? errType
          } catch { /* use raw */ }
          ctx.emit({
            level: 'error', kind: EVENT.OPENAI_COMPAT_ERROR, sessionId,
            status: upstreamResponse.status, msg: errMessage.slice(0, 200),
          })
          return openaiErrorResponse(upstreamResponse.status, errMessage, errType)
        }

        const transformOpts: TransformOpts = {
          completionId: 'chatcmpl-' + crypto.randomUUID().replace(/-/g, '').slice(0, 24),
          model: translation.model,
          created: Math.floor(Date.now() / 1000),
          systemFingerprint: `claude-max-proxy-${ctx.version}`,
          isJsonSchema: translation.isJsonSchema,
          schemaToolName: translation.schemaToolName,
          includeUsage: body.stream_options?.include_usage ?? false,
          thinkingMode: ctx.config.openaiCompatThinking,
        }

        ctx.emit({
          level: 'info', kind: EVENT.OPENAI_COMPAT_COMPLETE, sessionId,
          model: translation.model, stream: body.stream !== false, durationMs: Date.now() - t0,
        })

        if (body.stream === false) return bufferToNonStreaming(upstreamResponse, transformOpts)
        return transformAnthropicSSEToOpenAI(upstreamResponse, transformOpts)
      },
    },
  ]

  return {
    name: 'openai-compat',
    routes,
    init(c) { ctx = c },
  }
}
