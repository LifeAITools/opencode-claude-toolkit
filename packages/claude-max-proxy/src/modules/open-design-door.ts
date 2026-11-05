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

const PROVIDER = 'open-design'
const DEFAULT_UPSTREAM = 'https://amr-link.open-design.ai/v1'
/** Сколько живёт выбор аккаунта за сессией. 12 ч — как у пинов двери Go. */
const PIN_TTL_MS = 12 * 60 * 60 * 1000

export interface OdAccountView {
  account: string | null
  status: string
  headroomFraction: number | null
  windows: Array<{ name: string; usedFraction: number | null; resetsAt: string | null }>
}

export interface OdPick {
  email: string
  keyEnv: string
  headroomFraction: number | null
  why: string
}

/**
 * Выбор аккаунта — ЧИСТАЯ функция, чтобы её можно было проверить без сети.
 *
 * Правила:
 *  • только `status: 'active'` — `absent`/`exhausted`/`unreadable` не кандидаты;
 *  • аккаунт без объявленного ключа не кандидат (иначе пришлось бы гадать ключом соседа);
 *  • порядок — по запасу: больше `headroomFraction` выше; `null` (не измерено) идёт
 *    ПОСЛЕ измеренных, но не отбрасывается: незнание не равно «нет запаса»;
 *  • ничья — по email, чтобы порядок не прыгал между вызовами.
 */
export function pickOpenDesignAccount(
  accounts: OdAccountView[],
  keyByEmail: (email: string | null) => string | null,
): OdPick | null {
  const candidates: OdPick[] = []
  for (const a of accounts) {
    if (a.status !== 'active') continue
    const keyEnv = keyByEmail(a.account)
    if (!keyEnv) continue
    candidates.push({
      email: String(a.account),
      keyEnv,
      headroomFraction: a.headroomFraction,
      why: a.headroomFraction === null ? 'headroom_unmeasured' : 'headroom',
    })
  }
  if (!candidates.length) return null
  candidates.sort((x, y) => {
    const hx = x.headroomFraction
    const hy = y.headroomFraction
    if (hx === null && hy !== null) return 1
    if (hy === null && hx !== null) return -1
    if (hx !== null && hy !== null && hx !== hy) return hy - hx
    return x.email.localeCompare(y.email)
  })
  return candidates[0]
}

/** `deepseek-v4.1-flash-od` → `deepseek-v4.1-flash` (суффикс — наш, у поставщика его нет). */
export function upstreamModel(model: string): string {
  return model.endsWith('-od') ? model.slice(0, -3) : model
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

  let parsed: any
  let model: string | null = null
  try {
    parsed = JSON.parse(await req.text())
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

  // 🔴 ВЫБОР ОДИН РАЗ НА СЕССИЮ. Живая сессия не переезжает — даже если сосед стал свободнее.
  let chosen: OdPick | null = null
  let pinned = false
  if (sessionId) {
    const p = pins.get(sessionId)
    if (p && Date.now() - p.at < PIN_TTL_MS) {
      const envName = keyByEmail(p.email)
      if (envName) { chosen = { email: p.email, keyEnv: envName, headroomFraction: null, why: 'pin' }; pinned = true }
    }
  }
  if (!chosen) {
    chosen = pickOpenDesignAccount(accountsFromQuota(), keyByEmail)
    if (!chosen) {
      ctx.emit({
        level: 'error', kind: EVENT.OD_ERROR, sessionId, model,
        msg: `дверь OpenDesign: нет ни одного годного аккаунта с ключом (квота: ${UNIFIED_QUOTA_JSON})`,
      })
      return errorResponse(503, 'no usable OpenDesign account: none active with a declared key env', 'configuration_error')
    }
    if (sessionId) { pins.set(sessionId, { email: chosen.email, at: Date.now() }); pinned = false }
  }

  const key = keyOf(chosen.keyEnv)
  if (!key) {
    ctx.emit({
      level: 'error', kind: EVENT.OD_ERROR, sessionId, model,
      msg: `дверь OpenDesign: у аккаунта ${chosen.email} не задана ${chosen.keyEnv}`,
    })
    return errorResponse(503, `key env ${chosen.keyEnv} for ${chosen.email} is not set`, 'configuration_error')
  }

  const body = { ...parsed, model: upstreamModel(model) }
  const url = `${upstreamBase}/chat/completions`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    accept: parsed?.stream === true ? 'text/event-stream' : 'application/json',
  }

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
    return errorResponse(502, `OpenDesign upstream unreachable: ${String(err?.message ?? err).slice(0, 200)}`, 'upstream_error')
  }

  const passHeaders: Record<string, string> = {
    'content-type': upstream.headers.get('content-type') ?? (parsed?.stream === true ? 'text/event-stream' : 'application/json'),
    'x-open-design-account': chosen.email,
    'x-open-design-account-source': pinned ? 'pin' : chosen.why,
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
    return new Response(text, { status: upstream.status, headers: passHeaders })
  }

  // Поток отдаём как приходит: одно чтение → один кусок, без ожидания целых строк.
  // Именно на ожидании «полной SSE-строки» дверь Go и вставала (6faa7ac) — здесь это
  // правило соблюдено с рождения.
  const reader = upstream.body.getReader()
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
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (err) {
        ctx.emit({
          level: 'error', kind: EVENT.OD_ABORTED, sessionId, model, status: upstream.status,
          durationMs: Date.now() - t0,
          msg: `дверь OpenDesign: поток оборвался — ${String((err as any)?.message ?? err).slice(0, 160)}`,
        })
        controller.error(err)
      }
    },
    cancel() {
      aborted = true
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
