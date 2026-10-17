/**
 * Go-door — POST /go/chat/completions и POST /go/responses: дверь к OpenCode Go с организациями.
 *
 * Стоит ЗА LiteLLM :4000 (рельс front-topology): записи моделей Go указывают api_base на
 * http://host.docker.internal:5050/go, как модели Claude на :5050. Диалект не переводим —
 * chat/completions и Responses идут к поставщику как пришли; меняются только пропуск и
 * заголовки организации. Поэтому дверь — прозрачный проход, а не переводчик (в отличие от
 * spark-responses.ts, где Anthropic↔Responses).
 *
 * Организация: заголовок `x-kiberos-go-org` (uid SynqTask или имя) → иначе рабочая из реестра.
 * Названная и не найденная — 400, НИКОГДА не подмена другой (no-live-account-migration).
 *
 * Секрет берётся только через withGoCredential (единая точка выдачи); значение нигде не
 * логируется. Каждый вызов, включая отказ сети и отказ квоты, пишет ровно одну запись
 * provider-dump/v1 (контрольный вопрос 4 архитектуры).
 *
 * ПРОГРЕВА здесь нет и быть не может, пока warmQuotaShareMax = 0 (решение фаундера 15.10):
 * дверь только ходит и пишет дамп.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { loadRegistry, pickOrg, GoOrgError, GoRegistryError, type GoRegistry } from '../go-registry.js'
import { withGoCredential, GoCredentialError } from '../go-credentials.js'
import {
  newRecord, writeDump, redactHeaders, pickQuotaSeen, sha256, bodyField, classifyError,
  extractUsageChat, extractUsageResponses, usageFromSseText, type CallKind,
} from '../provider-dump.js'
import { resolveSessionIdentity } from '../session-identity.js'

const ORG_HEADER = 'x-kiberos-go-org'
const SESSION_HEADER = 'x-litellm-session-id'
const CALL_KIND_HEADER = 'x-kiberos-call-kind'
const ACTOR_HEADER = 'x-kiberos-user'
/** Сколько текста потока держим для разбора usage и дампа. */
const STREAM_CAP_BYTES = 256 * 1024

let ctx: ModuleContext

function errorResponse(status: number, message: string, type = 'api_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status, headers: { 'content-type': 'application/json' },
  })
}

function hashActor(v: string | null): string | null {
  return v ? sha256(v).slice(0, 16) : null
}

function callKindOf(req: Request): CallKind {
  const v = req.headers.get(CALL_KIND_HEADER)
  return v === 'warm' || v === 'probe' || v === 'refresh' || v === 'title' ? v : 'real'
}

/** Реестр читается заново на каждый вызов: он маленький, а правка реестра не должна требовать перезапуска. */
function registry(): GoRegistry {
  const path = ctx.config.goRegistryPath
  if (!path) throw new GoRegistryError('GO_REGISTRY_PATH не задан')
  return loadRegistry(path)
}

async function serve(req: Request, dialect: 'chat' | 'responses'): Promise<Response> {
  const t0 = Date.now()
  const cfg = ctx.config
  const kind = callKindOf(req)
  const door = 'proxy:opencode-go'
  // Единое правило опознания (FR-19/D3). У двери Go носителя в теле нет, поэтому
  // дверей две: заголовок `x-litellm-session-id` или честное «не опознан».
  const identity = resolveSessionIdentity({ headerValue: req.headers.get(SESSION_HEADER) })
  const sessionId = identity.sessionId
  const actor = hashActor(req.headers.get(ACTOR_HEADER))
  const path = dialect === 'chat' ? '/chat/completions' : '/responses'

  const raw = new Uint8Array(await req.arrayBuffer())
  let model: string | null = null
  let wantStream = false
  try {
    const j = JSON.parse(new TextDecoder().decode(raw))
    model = typeof j.model === 'string' ? j.model : null
    wantStream = j.stream === true
  } catch {
    return errorResponse(400, 'Invalid JSON body', 'invalid_request_error')
  }

  // Неопознанный запрос ОБСЛУЖИВАЕТСЯ, но назван в журнале: у разового вызова нет
  // номера, по которому его узнать второй раз, — прогрев на нём не вооружается.
  if (identity.source === 'none') {
    ctx.emit({
      level: 'info', kind: EVENT.GO_REQUEST_UNIDENTIFIED,
      sessionId: null, model,
      msg: 'дверь Go: запрос без x-litellm-session-id — обслужен, прогрев на нём не вооружается',
    })
  }

  const rec = newRecord({ door, provider: 'opencode-go', call_kind: kind })
  rec.model = model
  rec.session_id = sessionId
  rec.actor = actor
  rec.request.body_bytes = raw.byteLength
  rec.request.body_sha256 = sha256(raw)

  let org
  let cred
  try {
    org = pickOrg(registry(), req.headers.get(ORG_HEADER))
    rec.org_id = org.name
    rec.provider_org_ref = org.workspace
    cred = withGoCredential(org, {
      tokensPath: cfg.goTokensPath, environ: process.env, now: Date.now, userAgent: cfg.goUserAgent,
    })
  } catch (err: any) {
    const status = err instanceof GoOrgError ? 400 : 503
    const msg = String(err?.message ?? err).slice(0, 300)
    rec.response.status = status
    rec.error = { kind: err instanceof GoOrgError ? 'client' : err instanceof GoCredentialError ? 'auth' : 'provider', provider_type: null }
    rec.timing.total_ms = Date.now() - t0
    writeDump(rec)
    ctx.emit({ level: 'error', kind: EVENT.GO_ERROR, sessionId, org: org?.name ?? null, msg })
    return errorResponse(status, msg, status === 400 ? 'invalid_request_error' : 'api_error')
  }

  const url = org.baseUrl.replace(/\/$/, '') + path
  rec.request.url = url
  const upstreamHeaders: Record<string, string> = {
    ...cred.headers,
    'content-type': 'application/json',
    authorization: `Bearer ${cred.secret}`,
    // Постоянный на всех: шлюз скоупит кэш этим заголовком (архитектура R6 — не менять до замера 5.4).
    'x-opencode-session': cfg.goProviderSession,
  }
  rec.request.headers = redactHeaders(upstreamHeaders)

  ctx.emit({ level: 'info', kind: EVENT.GO_REQUEST, sessionId, org: org.name, model, stream: wantStream, callKind: kind })

  let upstream: Response
  try {
    upstream = await fetch(url, { method: 'POST', headers: upstreamHeaders, body: raw, signal: req.signal })
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? 'client aborted' : `gateway unreachable: ${err?.message}`
    rec.error = classifyError(null, true)
    rec.timing.total_ms = Date.now() - t0
    writeDump(rec)
    ctx.emit({ level: 'error', kind: EVENT.GO_ERROR, sessionId, org: org.name, msg: msg.slice(0, 200) })
    return errorResponse(502, msg)
  }

  rec.timing.ttfb_ms = Date.now() - t0
  rec.response.status = upstream.status
  const respHeaders = redactHeaders(upstream.headers)
  rec.response.headers = respHeaders
  rec.quota_seen = pickQuotaSeen(respHeaders)
  rec.error = classifyError(upstream.status, false)
  const extract = dialect === 'chat' ? extractUsageChat : extractUsageResponses

  const passHeaders = new Headers()
  for (const h of ['content-type', 'retry-after', 'cache-control']) {
    const v = upstream.headers.get(h)
    if (v) passHeaders.set(h, v)
  }

  const finish = (text: string, streamed: boolean) => {
    rec.timing.total_ms = Date.now() - t0
    let usage: unknown | null = null
    if (streamed) usage = usageFromSseText(text)
    else {
      try { const j = JSON.parse(text); usage = j?.usage ?? j?.response?.usage ?? null; rec.response.body = bodyField(text) } catch { /* не JSON */ }
    }
    if (streamed) rec.response.body = bodyField(null)
    rec.usage_raw = usage
    rec.usage_norm = extract(usage)
    if (rec.error) {
      try { rec.response.body = JSON.parse(text) } catch { rec.response.body = text.slice(0, 2000) }
    }
    writeDump(rec)
    ctx.emit({
      level: upstream.ok ? 'info' : 'error',
      kind: upstream.ok ? EVENT.GO_COMPLETE : EVENT.GO_ERROR,
      sessionId, org: org.name, model, stream: streamed, status: upstream.status,
      durationMs: rec.timing.total_ms, inTokens: rec.usage_norm.input, outTokens: rec.usage_norm.output,
      cachedTokens: rec.usage_norm.cache_read, callKind: kind,
    })
  }

  if (!wantStream || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    finish(text, false)
    return new Response(text, { status: upstream.status, headers: passHeaders })
  }

  // Поток: отдаём клиенту как идёт, копию (до предела) держим для usage и дампа.
  let kept = ''
  let keptBytes = 0
  const decoder = new TextDecoder()
  const tee = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk)
      if (keptBytes < STREAM_CAP_BYTES) { kept += decoder.decode(chunk, { stream: true }); keptBytes += chunk.byteLength }
    },
    flush() { finish(kept, true) },
    // Обрыв читателя: запись всё равно уходит (отказ сети и обрыв — тоже вызов).
  })
  return new Response(upstream.body.pipeThrough(tee), { status: upstream.status, headers: passHeaders })
}

export function createGoDoorModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/go/chat/completions', handler: (req) => serve(req, 'chat') },
    { method: 'POST', path: '/go/responses', handler: (req) => serve(req, 'responses') },
  ]
  return { name: 'go-door', routes, init(c) { ctx = c } }
}
