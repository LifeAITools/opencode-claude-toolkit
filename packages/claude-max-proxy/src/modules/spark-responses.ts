/**
 * Spark-responses module — POST /spark/v1/messages (Anthropic in, Responses out).
 *
 * Mirrors modules/openai-compat.ts, opposite direction: accepts Anthropic
 * Messages requests, translates to OpenAI Responses, forwards DIRECTLY to the
 * zen/go gateway (NOT through ProxyClient — different upstream, different
 * auth, different quota bucket), translates the answer back.
 *
 * Model gate: only ^muse-spark- (Responses dialect, verified live). Anything
 * else is 400 — the shared subscription key must not bill other buckets
 * through a translator that does not speak their dialect.
 *
 * Key: SPARK_API_KEY via established order (process env → file env).
 * Absent key is 503 with a named reason — a declared capability that cannot
 * work fails loud, never degrades silent.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { createHash } from 'crypto'
import { resolvePidFromPort as resolvePidFromPeerPort } from '../session-tracker.js'
import {
  translateToResponsesBody,
  bufferResponsesToMessages,
  transformResponsesSSEToAnthropic,
  sparkErrorResponse,
  sparkCorsPreflight,
  handleSparkModelsRequest,
  isSparkModel,
  type MessagesRequest,
} from '../spark-translate.js'

let ctx: ModuleContext

function upstreamUrl(): string {
  return ctx.config.sparkUpstreamUrl.replace(/\/$/, '') + '/responses'
}

function apiKey(): string | null {
  return ctx.config.sparkApiKey
}

function userAgent(): string {
  return ctx.config.sparkUserAgent
}

export function createSparkResponsesModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    {
      method: 'OPTIONS',
      path: '/spark/v1/messages',
      handler: async () => sparkCorsPreflight(),
    },
    {
      method: 'GET',
      path: '/spark/v1/models',
      handler: async () => handleSparkModelsRequest(ctx.version),
    },
    {
      method: 'POST',
      path: '/spark/v1/messages',
      handler: async (req, server) => {
        const t0 = Date.now()

        let body: MessagesRequest
        try { body = await req.json() as MessagesRequest }
        catch { return sparkErrorResponse(400, 'Invalid JSON body', 'invalid_request_error') }

        if (!body.model) return sparkErrorResponse(400, 'model is required', 'invalid_request_error')
        if (!isSparkModel(body.model)) {
          return sparkErrorResponse(400,
            `model '${body.model}' is not served here — this door speaks Responses (muse-spark-*) only`,
            'invalid_request_error')
        }
        if (!body.messages?.length) return sparkErrorResponse(400, 'messages is required', 'invalid_request_error')

        const key = apiKey()
        if (!key) {
          ctx.emit({ level: 'error', kind: EVENT.SPARK_ERROR, msg: 'SPARK_API_KEY absent — refusing loudly, not degrading' })
          return sparkErrorResponse(503, 'SPARK_API_KEY is not configured', 'api_error')
        }

        // Session: passthrough caller's conversation id (routing + prompt cache
        // on the gateway side), else stable derivative like openai-compat.
        let sessionId = req.headers.get('x-opencode-session') ?? ''
        if (!sessionId) {
          const authHeader = req.headers.get('authorization') ?? ''
          if (authHeader.startsWith('Bearer ') && authHeader.length > 20) {
            sessionId = 'spark-' + createHash('sha256').update(authHeader).digest('hex').slice(0, 8)
          }
        }
        if (!sessionId) {
          const peer = server.requestIP(req)
          sessionId = 'spark-' + (peer?.address ?? 'unknown')
        }

        const peer = server.requestIP(req)
        const srcPort = peer?.port ?? null
        const sourcePid = srcPort ? resolvePidFromPeerPort(srcPort) : null

        const wantStream = body.stream === true

        let translation
        try {
          translation = translateToResponsesBody(body)
        } catch (err: any) {
          return sparkErrorResponse(400, `Translation error: ${err?.message}`, 'invalid_request_error')
        }

        ctx.emit({
          level: 'info', kind: EVENT.SPARK_REQUEST, sessionId,
          model: body.model, stream: wantStream,
          hasTools: !!(body.tools?.length),
          bumpedMaxTokens: translation.bumpedMaxTokens,
          maxOutputTokens: translation.body.max_output_tokens,
          sourcePid,
        })

        let upstream: Response
        try {
          upstream = await fetch(upstreamUrl(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': `Bearer ${key}`,
              'user-agent': userAgent(),
              'x-opencode-session': sessionId,
            },
            body: JSON.stringify(translation.body),
            signal: req.signal,
          })
        } catch (err: any) {
          const msg = err?.name === 'AbortError' ? 'client aborted' : `gateway unreachable: ${err?.message}`
          ctx.emit({ level: 'error', kind: EVENT.SPARK_ERROR, sessionId, msg: msg.slice(0, 200) })
          return sparkErrorResponse(502, msg, 'api_error')
        }

        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '')
          let errMessage = `Upstream error (${upstream.status})`
          try {
            const parsed = JSON.parse(errText)
            errMessage = parsed.error?.message ?? errMessage
          } catch { /* use raw */ }
          ctx.emit({
            level: 'error', kind: EVENT.SPARK_ERROR, sessionId,
            status: upstream.status, msg: errMessage.slice(0, 200),
          })
          const retryAfter = upstream.headers.get('retry-after')
          const resp = sparkErrorResponse(upstream.status, errMessage, 'api_error')
          if (retryAfter) resp.headers.set('retry-after', retryAfter)
          return resp
        }

        const messageId = `msg_spark_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

        if (!wantStream) {
          try {
            const { message, droppedReasoning } = await bufferResponsesToMessages(upstream)
            // Keep the upstream id (msg_spark_<res.id>) — it traces the call
            // on both sides; a local random id would orphan it.
            ctx.emit({
              level: 'info', kind: EVENT.SPARK_COMPLETE, sessionId,
              model: body.model, stream: false, durationMs: Date.now() - t0,
              inTokens: message.usage.input_tokens, outTokens: message.usage.output_tokens,
              droppedReasoning,
            })
            return new Response(JSON.stringify(message), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          } catch (err: any) {
            ctx.emit({ level: 'error', kind: EVENT.SPARK_ERROR, sessionId, msg: `reverse-translate: ${err?.message}`.slice(0, 200) })
            return sparkErrorResponse(502, `Reverse translation error: ${err?.message}`, 'api_error')
          }
        }

        return transformResponsesSSEToAnthropic(upstream, {
          messageId, model: body.model,
          onComplete: (usage, durationMs) => {
            ctx.emit({
              level: 'info', kind: EVENT.SPARK_COMPLETE, sessionId,
              model: body.model, stream: true, durationMs,
              inTokens: usage.input_tokens, outTokens: usage.output_tokens,
            })
          },
        })
      },
    },
  ]

  return {
    name: 'spark-responses',
    routes,
    init(c) { ctx = c },
  }
}
