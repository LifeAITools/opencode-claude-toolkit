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
import { captureBody } from '../body-capture.js'
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

export interface SparkDeps {
  config: {
    sparkApiKey: string | null
    sparkUpstreamUrl: string
    sparkUserAgent: string
    sparkReasoningEffort: 'minimal' | 'low' | 'medium' | 'high'
  }
  emit: (event: Record<string, unknown>) => void
}

function upstreamUrl(deps: SparkDeps): string {
  return deps.config.sparkUpstreamUrl.replace(/\/$/, '') + '/responses'
}

function apiKey(deps: SparkDeps): string | null {
  return deps.config.sparkApiKey
}

function userAgent(deps: SparkDeps): string {
  return deps.config.sparkUserAgent
}

export interface SparkWire {
  sessionId: string
  sourcePid: number | null
  srcPort: number | null
  signal?: AbortSignal | null
}

/**
 * Общее ядро двери: перевод → шлюз → обратный перевод. Пользуются оба маршрута:
 * POST /spark/v1/messages напрямую и POST /v1/messages с model=muse-spark-*
 * (роут из anthropic-модуля — у CLI один baseURL, помодельной адресации нет).
 * Проверки модели и сообщений — здесь, в одном месте.
 */
export async function serveSparkRequest(body: MessagesRequest, wire: SparkWire, deps: SparkDeps): Promise<Response> {
  const t0 = Date.now()
  const { sessionId, sourcePid, srcPort } = wire
  const emit = deps.emit

  if (!body.model) return sparkErrorResponse(400, 'model is required', 'invalid_request_error')
  if (!isSparkModel(body.model)) {
    return sparkErrorResponse(400,
      `model '${body.model}' is not served here — this door speaks Responses (muse-spark-*) only`,
      'invalid_request_error')
  }
  if (!body.messages?.length) return sparkErrorResponse(400, 'messages is required', 'invalid_request_error')

  const key = apiKey(deps)
  if (!key) {
    emit({ level: 'error', kind: EVENT.SPARK_ERROR, msg: 'SPARK_API_KEY absent — refusing loudly, not degrading' })
    return sparkErrorResponse(503, 'SPARK_API_KEY is not configured', 'api_error')
  }

  const wantStream = body.stream === true

  let translation
  try {
    translation = translateToResponsesBody(body, { reasoningEffort: deps.config.sparkReasoningEffort })
  } catch (err: any) {
    return sparkErrorResponse(400, `Translation error: ${err?.message}`, 'invalid_request_error')
  }

        emit({
          level: 'info', kind: EVENT.SPARK_REQUEST, sessionId,
          model: body.model, stream: wantStream,
          hasTools: !!(body.tools?.length),
          bumpedMaxTokens: translation.bumpedMaxTokens,
          maxOutputTokens: translation.body.max_output_tokens,
          sourcePid,
        })

        let upstream: Response
        // Самописец исходящего тела (чья просьба tixi 06.10): ЧТО ушло на шлюз —
        // единственный способ различить «блоки не доехали» и «модель stalls».
        // Пишется перевод, не вход: ключ в заголовках режется самописцем
        // (authorization → <redacted>), тело едет как есть, включая байты картинок
        // (диск ограничен существующим cap самописца). Общий kill-switch — тот же.
        const upstreamHeaders: Record<string, string> = {
          'content-type': 'application/json',
          'authorization': `Bearer ${key}`,
          'user-agent': userAgent(deps),
          'x-opencode-session': sessionId,
        }
        try {
          const raw = Buffer.from(JSON.stringify(translation.body))
          const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
          captureBody(bytes, upstreamHeaders, { sessionId, sourcePid, srcPort })
        } catch { /* самописец не роняет ход */ }
        try {
          upstream = await fetch(upstreamUrl(deps), {
            method: 'POST',
            headers: upstreamHeaders,
            body: JSON.stringify(translation.body),
            signal: wire.signal ?? undefined,
          })
        } catch (err: any) {
          const msg = err?.name === 'AbortError' ? 'client aborted' : `gateway unreachable: ${err?.message}`
          emit({ level: 'error', kind: EVENT.SPARK_ERROR, sessionId, msg: msg.slice(0, 200) })
          return sparkErrorResponse(502, msg, 'api_error')
        }

        if (!upstream.ok) {
          const errText = await upstream.text().catch(() => '')
          let errMessage = `Upstream error (${upstream.status})`
          try {
            const parsed = JSON.parse(errText)
            errMessage = parsed.error?.message ?? errMessage
          } catch { /* use raw */ }
          emit({
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
            const { message, droppedReasoning, cachedTokens } = await bufferResponsesToMessages(upstream)
            // Keep the upstream id (msg_spark_<res.id>) — it traces the call
            // on both sides; a local random id would orphan it.
            emit({
              level: 'info', kind: EVENT.SPARK_COMPLETE, sessionId,
              model: body.model, stream: false, durationMs: Date.now() - t0,
              inTokens: message.usage.input_tokens, outTokens: message.usage.output_tokens,
              droppedReasoning, cachedTokens,
            })
            return new Response(JSON.stringify(message), {
              status: 200, headers: { 'content-type': 'application/json' },
            })
          } catch (err: any) {
            emit({ level: 'error', kind: EVENT.SPARK_ERROR, sessionId, msg: `reverse-translate: ${err?.message}`.slice(0, 200) })
            return sparkErrorResponse(502, `Reverse translation error: ${err?.message}`, 'api_error')
          }
        }

        return transformResponsesSSEToAnthropic(upstream, {
          messageId, model: body.model,
          onComplete: (usage, durationMs) => {
            emit({
              level: 'info', kind: EVENT.SPARK_COMPLETE, sessionId,
              model: body.model, stream: true, durationMs,
              inTokens: usage.input_tokens, outTokens: usage.output_tokens,
              cachedTokens: usage.cached_tokens,
            })
          },
        })
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
        let body: MessagesRequest
        try { body = await req.json() as MessagesRequest }
        catch { return sparkErrorResponse(400, 'Invalid JSON body', 'invalid_request_error') }

        // Session: passthrough caller's conversation id (routing + prompt cache
        // on the gateway side), else stable derivative like openai-compat.
        let sessionId = req.headers.get('x-opencode-session') ?? ''
        if (!sessionId) {
          const authHeader = req.headers.get('authorization') ?? ''
          if (authHeader.startsWith('Bearer ') && authHeader.length > 20) {
            sessionId = 'spark-' + createHash('sha256').update(authHeader).digest('hex').slice(0, 8)
          }
        }
        const peer = server.requestIP(req)
        if (!sessionId) {
          sessionId = 'spark-' + (peer?.address ?? 'unknown')
        }
        const srcPort = peer?.port ?? null
        return serveSparkRequest(body, {
          sessionId,
          sourcePid: srcPort ? resolvePidFromPeerPort(srcPort) : null,
          srcPort,
          signal: req.signal,
        }, ctx)
      },
    },
  ]

  return {
    name: 'spark-responses',
    routes,
    init(c) { ctx = c },
  }
}
