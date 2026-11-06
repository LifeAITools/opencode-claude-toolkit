/**
 * open-design-door — POST /od/chat/completions: OpenAI-совместимая дверь к OpenDesign.
 *
 * 🔴 ЗАЧЕМ ОНА (слово фаундера 05.11.2026): «балансировщик должен зажать на ту
 * организацию, где есть запас». До этой двери выбор делал LiteLLM — по привязке к
 * сессии, не глядя на окна, — и половина трафика уходила на аккаунт, чью квоту мы
 * вообще не измеряли. Здесь выбор идёт по ИЗМЕРЕННОМУ запасу из единого файла квоты.
 *
 * 🔴 ПОЧЕМУ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ОБОБЩЕНИЕ `go-door`. У двери Go 1700 строк политики,
 * привязанной к её провайдеру: пин организации, сторож холодной переписи, полосы
 * префикса, прогрев. Обобщать это «на ходу» — самый дорогой способ сломать флот; в
 * плане это отдельный шаг S7 и он ждёт замеров. Здесь — узкая дверь, которая делает
 * ровно две вещи: выбирает аккаунт по запасу и честно называет, кто обслужил.
 *
 * 🔴 ЖИВАЯ СЕССИЯ НЕ ПЕРЕЕЗЖАЕТ (рельс no-live-account-migration). Аккаунт выбирается
 * ОДИН раз на сессию и держится за номером сессии; отказ закреплённого аккаунта
 * возвращается клиенту как отказ, а не уезжает молча на соседний. Смена — только
 * новым разговором.
 *
 * Ключи НЕ в коде и НЕ здесь: `config/providers.yaml` объявляет, какая переменная
 * окружения отвечает за какой аккаунт (`account_keys`), значения живут в litellm/.env.
 */
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { readCallerSession, resolveSessionIdentity } from '../session-identity.js'
import { loadProviderRegistry, keyEnvFor, type ProviderRegistry } from '../provider-registry.js'
import { UNIFIED_QUOTA_JSON } from '../quota-unified.js'
import { planPlacement, type PlacementOrg } from '../placement.js'
import {
  newRecord, writeDump, redactHeaders, pickQuotaSeen, sha256, classifyError,
  extractUsageChat, usageFromSseText, bodyField,
} from '../provider-dump.js'

const PROVIDER = 'open-design'
const DEFAULT_UPSTREAM = 'https://amr-link.open-design.ai/v1'
const CALL_KIND_HEADER = 'x-kiberos-call-kind'
/** Хвост потока, который держим для usage: строка `usage` короткая, остальное не нужно. */
const STREAM_CAP_BYTES = 1_000_000
/** Сколько живёт выбор аккаунта за сессией. 12 ч — как у пинов двери Go. */
const PIN_TTL_MS = 12 * 60 * 60 * 1000

export interface OdAccountView {
  account: string | null
  status: string
  headroomFraction: number | null
  windows: Array<{ name: string; usedFraction: number | null; resetsAt: string | null }>
}

/**
 * Отчёт квоты → вход анализатора размещения.
 *
 * 🔴 ЗДЕСЬ РЕШАЕТ `planPlacement`, А НЕ ГОЛЫЙ ЗАПАС (слово фаундера 05.11.2026).
 * Простой «у кого больше запас» сгоняет всех на одну организацию, они разгоняют её и
 * упираются в стену. Анализатор считает темп окна, время до стены и то, сколько агентов
 * уже посажено (маргинальная нагрузка посадки ещё одного).
 *
 * Аккаунт без измеренных окон даёт вердикт `unknown` и НЕ выходит вперёд измеренных.
 */
export function odPlacementInputs(
  accounts: OdAccountView[],
  activeAgentsByEmail: Map<string, number> = new Map(),
): PlacementOrg[] {
  return accounts.map(a => {
    const status = String(a.status ?? 'unreadable').toLowerCase()
    const blockedReason = status === 'exhausted' ? 'организация исчерпана'
      : status === 'absent' ? 'организация без подписки'
        : status === 'unreadable' ? 'квоту измерить не удалось'
          : null
    return {
      name: String(a.account ?? ''),
      windows: (a.windows ?? []).map(w => ({
        name: w.name,
        util: typeof w.usedFraction === 'number' ? w.usedFraction : null,
        resetAt: w.resetsAt ? Date.parse(w.resetsAt) : null,
      })),
      activeAgents: activeAgentsByEmail.get(String(a.account ?? '')) ?? 0,
      blockedReason,
    }
  })
}

export interface OdPick {
  email: string
  keyEnv: string
  why: string
}

/** Выбор аккаунта для НОВОГО разговора — через анализатор размещения. */
export function pickOpenDesignAccount(
  accounts: OdAccountView[],
  keyByEmail: (email: string | null) => string | null,
  opts: { nowMs?: number; activeAgentsByEmail?: Map<string, number>; seed?: string } = {},
): OdPick | null {
  const now = opts.nowMs ?? Date.now()
  // Аккаунт без объявленного ключа — НЕ кандидат, и отсекается ДО анализатора: иначе он
  // выиграл бы по запасу и превратил бы выбор в отказ, хотя рядом есть годный.
  const usable = accounts.filter(a => keyByEmail(a.account))
  const plan = planPlacement(odPlacementInputs(usable, opts.activeAgentsByEmail), now, opts.seed ?? '')
  if (!plan.org) return null
  const keyEnv = keyByEmail(plan.org.name)
  if (!keyEnv) return null
  return { email: plan.org.name, keyEnv, why: plan.reason }
}

/** `deepseek-v4.1-flash-od` → `deepseek-v4.1-flash` (суффикс — наш, у поставщика его нет). */
export function upstreamModel(model: string): string {
  return model.endsWith('-od') ? model.slice(0, -3) : model
}

/** Источник выбора аккаунта — КОД для заголовка и журнала, не человеческая фраза. */
export function odAccountSource(pinned: boolean): 'pin' | 'quota' {
  return pinned ? 'pin' : 'quota'
}

/** Вид вызова — тем же заголовком, что и у двери Go: один контракт на все двери. */
export function odCallKind(headerValue: string | null): 'real' | 'warm' | 'probe' | 'refresh' | 'title' {
  return headerValue === 'warm' || headerValue === 'probe' || headerValue === 'refresh' || headerValue === 'title'
    ? headerValue
    : 'real'
}

let ctx: ModuleContext
const pins = new Map<string, { email: string; at: number }>()

function registryPath(): string {
  return process.env.PROVIDER_REGISTRY_PATH ?? join(import.meta.dir, '..', '..', 'config', 'providers.yaml')
}

function registry(): ProviderRegistry | null {
  try {
    const path = registryPath()
    if (!existsSync(path)) return null
    return loadProviderRegistry(path)
  } catch { return null }
}

function accountsFromQuota(): OdAccountView[] {
  try {
    const doc = JSON.parse(readFileSync(UNIFIED_QUOTA_JSON, 'utf8'))
    return (Array.isArray(doc?.accounts) ? doc.accounts : [])
      .filter((a: any) => a?.provider === PROVIDER)
      .map((a: any) => ({
        account: a?.account ?? null,
        status: String(a?.status ?? 'unreadable'),
        headroomFraction: typeof a?.headroomFraction === 'number' ? a.headroomFraction : null,
        windows: Array.isArray(a?.windows) ? a.windows : [],
      }))
  } catch { return [] }
}

function keyOf(envName: string): string | null {
  const v = process.env[envName]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function errorResponse(status: number, message: string, type = 'api_error'): Response {
  return new Response(JSON.stringify({ error: { type, message } }), {
    status, headers: { 'content-type': 'application/json' },
  })
}

async function serve(req: Request): Promise<Response> {
  const t0 = Date.now()
  const cfg = ctx.config as any
  const upstreamBase = (cfg.openDesignUpstreamUrl ?? process.env.OPEN_DESIGN_UPSTREAM_URL ?? DEFAULT_UPSTREAM).replace(/\/$/, '')

  const rawText = await req.text()
  let parsed: any
  let model: string | null = null
  try {
    parsed = JSON.parse(rawText)
    model = typeof parsed?.model === 'string' ? parsed.model : null
  } catch {
    return errorResponse(400, 'Invalid JSON body', 'invalid_request_error')
  }
  if (!model) return errorResponse(400, 'model is required', 'invalid_request_error')

  const reg = registry()
  if (!reg) return errorResponse(503, 'provider registry is not readable (config/providers.yaml)', 'configuration_error')
  const keyByEmail = (email: string | null) => keyEnvFor(reg, PROVIDER, email)

  const caller = readCallerSession(req.headers)
  const identity = resolveSessionIdentity({ headerValue: caller.sessionId })
  const sessionId = identity.sessionId

  /**
   * 🔴 СЛЕД О ТОМ, КТО ОБСЛУЖИЛ, — В ЖУРНАЛ ДВЕРИ (06.11.2026).
   *
   * `GET /admin/served-org` читает именно этот файл, а `org_id` писала только дверь Go.
   * Маршрут OpenDesign идёт мимо неё, поэтому такие сессии навсегда оставались
   * `found:false`, и сборщик присутствия не мог назвать ни provider, ни account.
   * Пишем ТОТ ЖЕ вид записи, что и Go: `org_id` — аккаунт (`relishev@gmail.com`), а не
   * id развёртывания, `org_source` — КОД (pin|quota), а не человеческая фраза.
   */
  const rec = newRecord({
    door: 'proxy:open-design',
    provider: PROVIDER,
    call_kind: odCallKind(req.headers.get(CALL_KIND_HEADER)),
  })
  rec.model = model
  rec.session_id = sessionId
  rec.caller = {
    session_header: caller.header,
    user_agent: (req.headers.get('user-agent') ?? '').slice(0, 120) || null,
  }
  rec.request.body_bytes = new TextEncoder().encode(rawText).byteLength
  rec.request.body_sha256 = sha256(rawText)

  let finished = false
  const finish = (text: string | null, streamed = false) => {
    if (finished) return
    finished = true
    rec.timing.total_ms = Date.now() - t0
    let usage: unknown | null = null
    if (text) {
      if (streamed) usage = usageFromSseText(text)
      else {
        try {
          const j = JSON.parse(text)
          usage = j?.usage ?? null
          rec.response.body = bodyField(text)
        } catch { /* не-JSON — отдаём как есть */ }
      }
    }
    rec.usage_raw = usage
    rec.usage_norm = extractUsageChat(usage)
    writeDump(rec)
  }

  // 🔴 ВЫБОР ОДИН РАЗ НА СЕССИЮ. Живая сессия не переезжает — даже если сосед стал свободнее.
  let chosen: OdPick | null = null
  let pinned = false
  if (sessionId) {
    const p = pins.get(sessionId)
    if (p && Date.now() - p.at < PIN_TTL_MS) {
      const envName = keyByEmail(p.email)
      if (envName) { chosen = { email: p.email, keyEnv: envName, why: 'pin' }; pinned = true }
    }
  }
  if (!chosen) {
    // Сколько агентов уже посажено на каждый аккаунт — по пинам этой же двери.
    const counts = new Map<string, number>()
    for (const p of pins.values()) counts.set(p.email, (counts.get(p.email) ?? 0) + 1)
    chosen = pickOpenDesignAccount(accountsFromQuota(), keyByEmail, { activeAgentsByEmail: counts, seed: sessionId ?? '' })
    if (!chosen) {
      ctx.emit({
        level: 'error', kind: EVENT.OD_ERROR, sessionId, model,
        msg: `дверь OpenDesign: нет ни одного годного аккаунта с ключом (квота: ${UNIFIED_QUOTA_JSON})`,
      })
      rec.response.status = 503
      rec.error = classifyError(503, false)
      finish(null)
      return errorResponse(503, 'no usable OpenDesign account: none active with a declared key env', 'configuration_error')
    }
    if (sessionId) { pins.set(sessionId, { email: chosen.email, at: Date.now() }); pinned = false }
  }

  rec.org_id = chosen.email
  // 🔴 КОД, а не фраза: `why` — русское предложение, и в заголовке оно недопустимо
  // (замер 06.11: `new Response` с таким header падал TypeError → 500 уже после ответа
  // апстрима). Человеческая причина остаётся в журнале и в событии, наружу едет код.
  const accountSource = odAccountSource(pinned)
  rec.org_source = accountSource

  const key = keyOf(chosen.keyEnv)
  if (!key) {
    ctx.emit({
      level: 'error', kind: EVENT.OD_ERROR, sessionId, model,
      msg: `дверь OpenDesign: у аккаунта ${chosen.email} не задана ${chosen.keyEnv}`,
    })
    rec.response.status = 503
    rec.error = { kind: 'auth', provider_type: null }
    finish(null)
    return errorResponse(503, `key env ${chosen.keyEnv} for ${chosen.email} is not set`, 'configuration_error')
  }

  const body = { ...parsed, model: upstreamModel(model) }
  const url = `${upstreamBase}/chat/completions`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    accept: parsed?.stream === true ? 'text/event-stream' : 'application/json',
  }
  rec.request.url = url
  rec.request.headers = redactHeaders(headers)

  ctx.emit({
    level: 'info', kind: EVENT.OD_REQUEST, sessionId, model,
    msg: `дверь OpenDesign: аккаунт ${chosen.email} (${pinned ? 'pin' : chosen.why}), вверх ${body.model}`,
  })

  let upstream: Response
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch (err: any) {
    ctx.emit({
      level: 'error', kind: EVENT.OD_ERROR, sessionId, model,
      msg: `дверь OpenDesign: апстрим недоступен — ${String(err?.message ?? err).slice(0, 200)}`,
    })
    rec.response.status = 502
    rec.error = classifyError(null, true)
    finish(null)
    return errorResponse(502, `OpenDesign upstream unreachable: ${String(err?.message ?? err).slice(0, 200)}`, 'upstream_error')
  }

  rec.timing.ttfb_ms = Date.now() - t0
  rec.response.status = upstream.status
  const respHeaders = redactHeaders(upstream.headers)
  rec.response.headers = respHeaders
  rec.quota_seen = pickQuotaSeen(respHeaders)
  rec.error = classifyError(upstream.status, false)

  const passHeaders: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? (parsed?.stream === true ? 'text/event-stream' : 'application/json'),
    'x-open-design-account': chosen.email,
    'x-open-design-account-source': accountSource,
    // Тот же след выбора, что у двери Go: потребителю не нужно знать, какая дверь отвечала.
    'x-kiberos-served-org': chosen.email,
  }

  if (parsed?.stream !== true || !upstream.body) {
    const text = await upstream.text().catch(() => '')
    let outTokens: number | null = null
    try {
      const j = JSON.parse(text)
      outTokens = j?.usage?.completion_tokens ?? null
    } catch { /* не-JSON — отдаём как есть */ }
    ctx.emit({
      level: upstream.ok ? 'info' : 'error',
      kind: upstream.ok ? EVENT.GO_COMPLETE : EVENT.GO_ERROR,
      sessionId, model, status: upstream.status, durationMs: Date.now() - t0, outTokens,
      msg: `дверь OpenDesign: ${chosen.email} → ${upstream.status}`,
    })
    finish(text, false)
    return new Response(text, { status: upstream.status, headers: passHeaders })
  }

  // Поток отдаём как приходит: одно чтение → один кусок, без ожидания целых строк.
  // Именно на ожидании «полной SSE-строки» дверь Go и вставала (6faa7ac) — здесь это
  // правило соблюдено с рождения.
  const reader = upstream.body.getReader()
  // Копию держим только для usage в журнале: сам поток не задерживается ни на байт.
  let kept = ''
  let keptBytes = 0
  const decoder = new TextDecoder()
  let aborted = false
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          ctx.emit({
            level: upstream.ok ? 'info' : 'error',
            kind: upstream.ok ? EVENT.GO_COMPLETE : EVENT.GO_ERROR,
            sessionId, model, status: upstream.status, durationMs: Date.now() - t0,
            msg: `дверь OpenDesign: ${chosen!.email} → ${upstream.status} (поток закрыт)`,
          })
          finish(kept, true)
          controller.close()
          return
        }
        if (keptBytes < STREAM_CAP_BYTES) {
          kept += decoder.decode(value, { stream: true })
          keptBytes += value.byteLength
        }
        controller.enqueue(value)
      } catch (err) {
        ctx.emit({
          level: 'error', kind: EVENT.OD_ABORTED, sessionId, model, status: upstream.status,
          durationMs: Date.now() - t0,
          msg: `дверь OpenDesign: поток оборвался — ${String((err as any)?.message ?? err).slice(0, 160)}`,
        })
        finish(kept, true)
        controller.error(err)
      }
    },
    cancel() {
      aborted = true
      finish(kept, true)
      reader.cancel().catch(() => {})
      ctx.emit({
        level: 'info', kind: EVENT.OD_ABORTED, sessionId, model, status: upstream.status,
        durationMs: Date.now() - t0,
        msg: 'дверь OpenDesign: клиент оборвал чтение — исход отдельный, не отказ двери',
      })
    },
  })

  void aborted
  return new Response(stream, { status: upstream.status, headers: passHeaders })
}

export function createOpenDesignDoorModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/od/chat/completions', handler: (req) => serve(req) },
  ]
  return { name: 'open-design-door', routes, init(c) { ctx = c } }
}

/** Для испытаний: сброс пинов между проверками. */
export function resetOpenDesignPins(): void { pins.clear() }
