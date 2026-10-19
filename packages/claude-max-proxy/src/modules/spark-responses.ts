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
import { resolveSessionIdentity, readCallerSession } from '../session-identity.js'
import { loadRegistry, pickOrg, GoOrgError } from '../go-registry.js'
import { withGoCredential } from '../go-credentials.js'
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
    sparkOrgId: string | null
    goRegistryPath: string | null
    goTokensPath: string | null
  }
  emit: (event: Record<string, unknown>) => void
}

/** Чем дверь пойдёт к поставщику: пропуск, обязательные заголовки и адрес двери — ОДНИМ выбором. */
export interface SparkTarget {
  /** Значение для `Authorization: Bearer`. Не логировать. */
  secret: string
  /** Заголовки организации (user-agent + `x-opencode-org-id` у консольных орг). */
  headers: Record<string, string>
  /** База БЕЗ хвостового слэша; `/responses` дописывается на вызове. */
  upstreamBase: string
  /** Имя организации из реестра — для журнала; null на застывшем запасе. */
  orgName: string | null
}

/**
 * Организация + пропуск + дверь — ОДНИМ решением, из ЖИВОГО реестра (шов двери `/go`).
 *
 * 🔴 ПОЧЕМУ НЕ ИЗ ОКРУЖЕНИЯ (случай 19.10.2026, tixi-cold). Застывшие `SPARK_API_KEY` +
 * `SPARK_ORG_ID` держали копию пропуска И организации: утром 401 `api_key_expired` по сроку,
 * днём 429 по квоте — оба лечит ОДИН шов. Реестр читается на КАЖДОМ вызове, поэтому переживает
 * и ротацию пропуска (`go_refresher`), и выбор организации — как `/go` (`go-door.ts:57`).
 *
 * Организация берётся из ЗАГОЛОВКА запроса (орг рождения агента), иначе — заданная `active`
 * в реестре. 🔴 `pickOrg` квоту НЕ проверяет (`go-registry.ts:67`): «живая» приходит только
 * заголовком, а `active` может быть исчерпана — поэтому отсутствие заголовка пишется в журнал.
 *
 * Дверь (`base_url`) — ЧАСТЬ выбора организации, а не константа: у консольных орг она
 * `/inference/go/openai/v1`, у ключевой — `/zen/go/v1` (замер 19.10: консольный пропуск отвечает
 * 200 на ОБЕИХ дверях для muse-spark, но полагаться на совпадение нельзя — берём заявленную).
 *
 * Запас: реестр не задан → застывшее окружение, прежнее поведение (совместимость выкатки).
 */
export function resolveSparkTarget(deps: SparkDeps, orgHeader?: string | null): SparkTarget {
  const cfg = deps.config
  if (cfg.goRegistryPath) {
    const reg = loadRegistry(cfg.goRegistryPath)
    const org = pickOrg(reg, orgHeader)
    const cred = withGoCredential(org, {
      tokensPath: cfg.goTokensPath, environ: process.env, now: Date.now, userAgent: cfg.sparkUserAgent,
    })
    return {
      secret: cred.secret,
      headers: cred.headers,
      upstreamBase: org.baseUrl.replace(/\/$/, ''),
      orgName: org.name,
    }
  }
  if (!cfg.sparkApiKey) throw new Error('SPARK_API_KEY is not configured')
  const headers: Record<string, string> = { 'user-agent': cfg.sparkUserAgent }
  if (cfg.sparkOrgId) headers['x-opencode-org-id'] = cfg.sparkOrgId
  return {
    secret: cfg.sparkApiKey,
    headers,
    upstreamBase: cfg.sparkUpstreamUrl.replace(/\/$/, ''),
    orgName: null,
  }
}

export interface SparkWire {
  sessionId: string
  sourcePid: number | null
  srcPort: number | null
  signal?: AbortSignal | null
  /** Организация из запроса (`x-kiberos-go-org`): uid SynqTask или имя. Иначе — `active` реестра. */
  orgHeader?: string | null
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

  // 🔴 Организация + пропуск + дверь — ОДНИМ решением из ЖИВОГО реестра (шов двери /go).
  // Застывшее окружение — только запас, когда реестр не задан. Ошибка выбора — отказ вслух,
  // не деградация: пропуск истёк / организации нет / реестр не читается — каждый со своим кодом.
  let target: SparkTarget
  try {
    target = resolveSparkTarget(deps, wire.orgHeader)
  } catch (err: any) {
    const isClient = err instanceof GoOrgError
    const status = isClient ? 400 : 503
    const msg = String(err?.message ?? err).slice(0, 300)
    emit({ level: 'error', kind: EVENT.SPARK_ERROR, sessionId, msg: `spark target: ${msg}` })
    return sparkErrorResponse(status, msg, isClient ? 'invalid_request_error' : 'api_error')
  }
  // Заголовка нет — сказать ВСЛУХ: `pickOrg` отдаёт заданную `active`, а квоту он НЕ проверяет
  // (`go-registry.ts:67`), и сегодня `active` может быть исчерпана. Молчаливый выбор мёртвой
  // организации — тот же класс, что зелёный `/health` при мёртвой двери (замер 19.10.2026).
  if (deps.config.goRegistryPath && !wire.orgHeader) {
    emit({
      level: 'info', kind: EVENT.SPARK_REQUEST, sessionId,
      msg: `дверь spark: заголовка x-kiberos-go-org нет — взята заданная active реестра (${target.orgName ?? '?'}), живой она не проверена`,
    })
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
        // Заголовки — из выбора организации: у консольной орг `x-opencode-org-id` уже внутри
        // `target.headers`, у ключевой его нет (её дверь — зеновская, заголовка не требует).
        const upstreamHeaders: Record<string, string> = {
          ...target.headers,
          'content-type': 'application/json',
          'authorization': `Bearer ${target.secret}`,
          'x-opencode-session': sessionId,
        }
        try {
          const raw = Buffer.from(JSON.stringify(translation.body))
          const bytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
          captureBody(bytes, upstreamHeaders, { sessionId, sourcePid, srcPort })
        } catch { /* самописец не роняет ход */ }
        try {
          upstream = await fetch(`${target.upstreamBase}/responses`, {
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

        // Session: единое правило (FR-19/D3) — заголовок, иначе производный номер
        // (дверь совместимости), иначе честное «не опознан».
        const identity = resolveSessionIdentity({
          headerValue: readCallerSession(req.headers).sessionId,
          derive: () => {
            const authHeader = req.headers.get('authorization') ?? ''
            if (authHeader.startsWith('Bearer ') && authHeader.length > 20) {
              return 'spark-' + createHash('sha256').update(authHeader).digest('hex').slice(0, 8)
            }
            return 'spark-' + (server.requestIP(req)?.address ?? 'unknown')
          },
        })
        const sessionId = identity.sessionId ?? ''
        const peer = server.requestIP(req)
        const srcPort = peer?.port ?? null
        return serveSparkRequest(body, {
          sessionId,
          sourcePid: srcPort ? resolvePidFromPeerPort(srcPort) : null,
          srcPort,
          signal: req.signal,
          // Организация рождения агента — приоритетно из заголовка (как у двери /go).
          orgHeader: req.headers.get('x-kiberos-go-org'),
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
