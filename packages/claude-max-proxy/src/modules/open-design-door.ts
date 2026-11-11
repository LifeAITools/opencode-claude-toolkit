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
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { EVENT } from '../event-bus.js'
import { readCallerSession, resolveSessionIdentity } from '../session-identity.js'
import { loadProviderRegistry, keyEnvFor, type ProviderRegistry } from '../provider-registry.js'
import { UNIFIED_QUOTA_JSON } from '../quota-unified.js'
import { planPlacement, type PlacementOrg } from '../placement.js'
import { recentRatesFromSamples } from '../placement-rates.js'
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

/**
 * ПОТОЛОК ОДНОВРЕМЕННОСТИ НА АККАУНТ (11.11.2026).
 *
 * 🔴 ЗАЧЕМ. У поставщика потолок одновременности на ЧЛЕНСТВО — замер 11.11.2026, живой
 * вызов: `400 [code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10`.
 * Дверь это не проверяла вовсе: она выбирала аккаунт по ЗАПАСУ, а запас у одновременных
 * вызовов разный не бывает — двенадцать запросов флота разом уходили на ОДИН аккаунт
 * (в журнале двери видно 09:16:56–09:16:59Z, все на hello@uniclowd.com), и одиннадцатый
 * получал отказ поставщика. Свой потолок ниже поставщиковского (8 из 10) — это запас
 * человеку и всем путям, которые идут мимо этой двери.
 *
 * `OD_MAX_CONCURRENT_PER_ACCOUNT` — настройка, а не константа: у другой организации тот
 * же поставщик может разрешать больше или меньше. Значение выше 10 бессмысленно — это его
 * потолок, и мы только воспроизведём его отказ своими руками.
 */
export function odSlotCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OD_MAX_CONCURRENT_PER_ACCOUNT ?? 8)
  if (!Number.isFinite(raw) || raw <= 0) return 8
  return Math.min(10, Math.max(1, Math.floor(raw)))
}
/** Сколько ждём свободный слот, прежде чем назвать отказ. Простой слот освобождает ответ модели. */
export function odQueueMaxWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OD_QUEUE_MAX_WAIT_MS ?? 30_000)
  if (!Number.isFinite(raw) || raw <= 0) return 30_000
  return Math.floor(raw)
}

interface OdWaiter {
  email: string
  sessionId: string | null
  model: string | null
  enqueuedAt: number
  handoff: (release: () => void) => void
  refuse: (why: string) => void
  timer: ReturnType<typeof setTimeout> | null
}

interface OdSlotState { inFlight: number; queue: OdWaiter[] }
const slots = new Map<string, OdSlotState>()

function slotState(email: string): OdSlotState {
  let s = slots.get(email)
  if (!s) { s = { inFlight: 0, queue: [] }; slots.set(email, s) }
  return s
}

/** Занятые слоты — карта «аккаунт → сколько в полёте». Для анализатора размещения. */
export function odInFlightByEmail(): Map<string, number> {
  const out = new Map<string, number>()
  for (const [email, s] of slots) if (s.inFlight > 0) out.set(email, s.inFlight)
  return out
}

/** Свободен ли слот прямо сейчас (без ожидания и без побочных эффектов). */
export function odSlotFree(email: string): boolean {
  return slotState(email).inFlight < odSlotCap()
}

/**
 * Занять слот немедленно. `null` — все слоты заняты; ждать нужно через `acquireOdSlot`.
 * Возвращённая функция освобождает слот ровно один раз (повторные вызовы — no-op).
 */
export function tryAcquireOdSlot(email: string): (() => void) | null {
  const st = slotState(email)
  if (st.inFlight >= odSlotCap()) return null
  st.inFlight++
  return makeRelease(email)
}

function makeRelease(email: string): () => void {
  let released = false
  return () => {
    if (released) return
    released = true
    const st = slotState(email)
    st.inFlight = Math.max(0, st.inFlight - 1)
    // Слот уходит ПРЯМО следующему в очереди, а не «в общий пул»: иначе проснувшиеся
    // разом увидят свободный слот и снова переполнят аккаунт.
    const next = st.queue.shift()
    if (next) {
      if (next.timer) clearTimeout(next.timer)
      st.inFlight++
      next.handoff(makeRelease(email))
    }
  }
}

/**
 * Занять слот, при необходимости — в ОГРАНИЧЕННОЙ ОЧЕРЕДИ. Отказ — не 400 и не «нет места»:
 * причина названа, сколько ждали и когда повторить.
 */
export async function acquireOdSlot(
  email: string,
  meta: { sessionId: string | null; model: string | null },
): Promise<() => void> {
  const st = slotState(email)
  if (st.inFlight < odSlotCap()) {
    st.inFlight++
    return makeRelease(email)
  }
  const maxWait = odQueueMaxWaitMs()
  return await new Promise<() => void>((resolve, reject) => {
    const waiter: OdWaiter = {
      email,
      sessionId: meta.sessionId,
      model: meta.model,
      enqueuedAt: Date.now(),
      handoff: (release) => { if (waiter.timer) clearTimeout(waiter.timer); resolve(release) },
      refuse: (why) => reject(new Error(why)),
      timer: null,
    }
    waiter.timer = setTimeout(() => {
      const i = st.queue.indexOf(waiter)
      if (i >= 0) st.queue.splice(i, 1)
      reject(new OdSlotQueueTimeout(email, Date.now() - waiter.enqueuedAt))
    }, maxWait)
    st.queue.push(waiter)
  })
}

export class OdSlotQueueTimeout extends Error {
  constructor(readonly email: string, readonly waitedMs: number) {
    super(`Slot guard: all ${odSlotCap()} slots on ${email} are busy; waited ${Math.round(waitedMs / 1000)}s`)
    this.name = 'OdSlotQueueTimeout'
  }
}

/** Снимок для диагностики: кто занял, сколько ждёт, каков потолок. */
export function odSlotSnapshot(): {
  cap: number
  queueMaxWaitMs: number
  accounts: Record<string, { inFlight: number; queued: number }>
  waiters: Array<{ account: string; sessionId: string | null; model: string | null; waitedMs: number }>
  measuredAt: string
} {
  const now = Date.now()
  const accounts: Record<string, { inFlight: number; queued: number }> = {}
  const waiters: Array<{ account: string; sessionId: string | null; model: string | null; waitedMs: number }> = []
  for (const [email, st] of slots) {
    if (st.inFlight === 0 && st.queue.length === 0) continue
    accounts[email] = { inFlight: st.inFlight, queued: st.queue.length }
    for (const w of st.queue) {
      waiters.push({ account: email, sessionId: w.sessionId, model: w.model, waitedMs: now - w.enqueuedAt })
    }
  }
  return { cap: odSlotCap(), queueMaxWaitMs: odQueueMaxWaitMs(), accounts, waiters, measuredAt: new Date(now).toISOString() }
}

/** Для испытаний: обнулить занятость и очередь между проверками. */
export function resetOdSlotsForTest(): void {
  for (const st of slots.values()) {
    for (const w of st.queue) if (w.timer) clearTimeout(w.timer)
  }
  slots.clear()
}

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
  opts: {
    inFlightByEmail?: Map<string, number>
    slotCap?: number
    /** Скорость расхода (доля окна/час) по аккаунту — производная из ряда замеров. */
    recentRatesByEmail?: Map<string, Record<string, number>>
  } = {},
): PlacementOrg[] {
  return accounts.map(a => {
    const status = String(a.status ?? 'unreadable').toLowerCase()
    const blockedReason = status === 'exhausted' ? 'организация исчерпана'
      : status === 'absent' ? 'организация без подписки'
        : status === 'unreadable' ? 'квоту измерить не удалось'
          : null
    const name = String(a.account ?? '')
    return {
      name,
      windows: (a.windows ?? []).map(w => ({
        name: w.name,
        util: typeof w.usedFraction === 'number' ? w.usedFraction : null,
        resetAt: w.resetsAt ? Date.parse(w.resetsAt) : null,
      })),
      activeAgents: activeAgentsByEmail.get(name) ?? 0,
      blockedReason,
      // Скорость расхода: если ряд есть, анализатор берёт БОЛЬШУЮ из средней и текущей —
      // «сейчас жжём быстрее среднего» и есть всплеск, ради которого ряд копится.
      ...(opts.recentRatesByEmail?.has(name) ? { recentRates: opts.recentRatesByEmail.get(name) } : {}),
      // Слоты считаем ВСЕГДА, когда включён потолок: занятый аккаунт — не кандидат,
      // даже если его запас лучше всех.
      ...(opts.slotCap !== undefined
        ? { inFlight: opts.inFlightByEmail?.get(name) ?? 0, slotCap: opts.slotCap }
        : {}),
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
  opts: {
    nowMs?: number
    activeAgentsByEmail?: Map<string, number>
    seed?: string
    /** Сколько вызовов уже в полёте на каждый аккаунт — занятые аккаунты не выбираются. */
    inFlightByEmail?: Map<string, number>
    /** Потолок слотов; `undefined` — слоты в выборе не учитываются. */
    slotCap?: number
    /** Производная расхода квоты по аккаунтам (из ряда сэмплов). */
    recentRatesByEmail?: Map<string, Record<string, number>>
  } = {},
): OdPick | null {
  const now = opts.nowMs ?? Date.now()
  // Аккаунт без объявленного ключа — НЕ кандидат, и отсекается ДО анализатора: иначе он
  // выиграл бы по запасу и превратил бы выбор в отказ, хотя рядом есть годный.
  const usable = accounts.filter(a => keyByEmail(a.account))
  const plan = planPlacement(
    odPlacementInputs(usable, opts.activeAgentsByEmail, {
      inFlightByEmail: opts.inFlightByEmail,
      slotCap: opts.slotCap,
      recentRatesByEmail: opts.recentRatesByEmail,
    }),
    now,
    opts.seed ?? '',
  )
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

/**
 * 🔴 ПРИВЯЗКИ ПЕРЕЖИВАЮТ ПЕРЕЗАПУСК (07.11.2026). Полюс измерен на живой сессии:
 * выкатка двери обнуляла память, и первый же ход ЖИВОЙ сессии выбирал счёт заново —
 * mermaid-ink сам «переехал» на новую организацию, хотя его никто не переселял.
 * Ровно та же ошибка была у двери Go и исправлена ею 26.10; здесь механизм тот же:
 * файл на диске, атомарная запись, срок как у выдачи — 12 ч.
 */
function pinsPath(): string {
  return process.env.OD_ORG_PINS_PATH ?? join(homedir(), '.claude-local', 'od-org-pins.json')
}
let pinsLoaded = false
export function loadOpenDesignPins(path = pinsPath()): void {
  if (pinsLoaded) return
  pinsLoaded = true
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { pins?: Record<string, { email?: unknown; at?: unknown }> }
    const now = Date.now()
    for (const [k, v] of Object.entries(doc.pins ?? {})) {
      if (typeof v?.email === 'string' && typeof v?.at === 'number' && now - v.at <= PIN_TTL_MS) {
        pins.set(k, { email: v.email, at: v.at })
      }
    }
  } catch { /* файла нет или он битый — начинаем с пустого */ }
}
export function saveOpenDesignPins(path = pinsPath()): void {
  try {
    const now = Date.now()
    const out: Record<string, { email: string; at: number }> = {}
    for (const [k, v] of pins) if (now - v.at <= PIN_TTL_MS) out[k] = v
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, pins: out }), { mode: 0o600 })
    renameSync(tmp, path)
  } catch { /* запись не смеет ломать вызов */ }
}

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

/**
 * РЯД СКОРОСТИ РАСХОДА — читается не чаще раза в минуту.
 * Замер 11.11: сэмплер пишет строку на провайдера каждые 5 минут, файл ~360 КБ на сутки;
 * читать его на КАЖДЫЙ запрос незачем — производная за минуту не меняется.
 */
const RATES_TTL_MS = 60_000
let ratesCache: { at: number; rates: Map<string, Record<string, number>> } | null = null

export function odRatesFromSamples(nowMs: number = Date.now()): Map<string, Record<string, number>> {
  if (ratesCache && nowMs - ratesCache.at < RATES_TTL_MS) return ratesCache.rates
  try {
    const path = process.env.QUOTA_SAMPLES_PATH ?? join(homedir(), '.claude-local', 'quota-samples.jsonl')
    const rates = recentRatesFromSamples(readFileSync(path, 'utf8'), { provider: PROVIDER, nowMs })
    ratesCache = { at: nowMs, rates }
    return rates
  } catch {
    // Нет ряда — нет производной. Это НЕ ноль и НЕ «расхода нет»: анализатор честно
    // вернётся к средней с начала окна.
    ratesCache = { at: nowMs, rates: new Map() }
    return ratesCache.rates
  }
}
/** Для испытаний: сбросить кэш производной. */
export function resetOdRatesCacheForTest(): void { ratesCache = null }

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
  loadOpenDesignPins()
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
    const quota = accountsFromQuota()
    // 🔴 СНАЧАЛА — САМ ПО СЕБЕ СВОБОДНЫЙ СЛОТ. Занятый аккаунт не кандидат, даже если у него
    // лучший запас: посадка туда не «следующий агент», а его 400 от поставщика.
    const rates = odRatesFromSamples()
    chosen = pickOpenDesignAccount(quota, keyByEmail, {
      activeAgentsByEmail: counts,
      inFlightByEmail: odInFlightByEmail(),
      slotCap: odSlotCap(),
      recentRatesByEmail: rates,
      seed: sessionId ?? '',
    })
    if (!chosen) {
      // Все слоты заняты. Это НЕ «нет места»: выбираем по запасу и скорости, а ждать
      // будем слот — очередь ограничена и отказ называет причину.
      chosen = pickOpenDesignAccount(quota, keyByEmail, {
        activeAgentsByEmail: counts, recentRatesByEmail: rates, seed: sessionId ?? '',
      })
    }
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

  /**
   * 🔴 СЛОТ БЕРЁТСЯ ДО ОТПРАВКИ И ДЕРЖИТСЯ ДО КОНЦА ОТВЕТА (включая поток). Потолок у
   * поставщика считает ЖИВЫЕ вызовы, поэтому отпускать раньше конца потока значило бы
   * снова выпустить одиннадцатого в ту же секунду.
   */
  let releaseSlot: (() => void) | null = tryAcquireOdSlot(chosen.email)
  if (!releaseSlot) {
    const waitStarted = Date.now()
    try {
      releaseSlot = await acquireOdSlot(chosen.email, { sessionId, model })
      const waitedMs = Date.now() - waitStarted
      ctx.emit({
        level: 'info', kind: EVENT.OD_SLOT_WAIT, sessionId, model,
        msg: `дверь OpenDesign: слот на ${chosen.email} ждал ${(waitedMs / 1000).toFixed(1)}с (потолок ${odSlotCap()})`,
      })
    } catch (err) {
      const timeout = err instanceof OdSlotQueueTimeout ? err : null
      const waitedSec = Math.round((timeout?.waitedMs ?? Date.now() - waitStarted) / 1000)
      ctx.emit({
        level: 'error', kind: EVENT.OD_SLOT_TIMEOUT, sessionId, model,
        msg: timeout
          ? `дверь OpenDesign: ${timeout.message} — ждать дольше не имеем права`
          : `дверь OpenDesign: слот не получен — ${String((err as any)?.message ?? err).slice(0, 160)}`,
      })
      rec.response.status = 503
      rec.error = classifyError(503, false)
      finish(null)
      const retryAfter = Math.ceil(odQueueMaxWaitMs() / 1000)
      return new Response(JSON.stringify({
        error: {
          type: 'slot_guard',
          message: `Slot guard: все ${odSlotCap()} слотов на ${chosen.email} заняты; `
            + `ждали ${waitedSec}с. Это НЕ отказ поставщика — свой потолок держим ниже его `
            + `(10 на членство), чтобы не получить его 400. Повторите через ${retryAfter}с.`,
        },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
      })
    }
  }

  // Привязка пишется ТОЛЬКО когда слот добыт: иначе отказ в очереди оставил бы сессию
  // привязанной к аккаунту, который её ни разу не обслужил.
  if (!pinned && sessionId) {
    pins.set(sessionId, { email: chosen.email, at: Date.now() })
    saveOpenDesignPins()
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
    releaseSlot?.()
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
    releaseSlot?.()
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
  /**
   * 🔴 ОБРЫВ КЛИЕНТА — НОРМА, А НЕ ОШИБКА ДВЕРИ (замер 11.11.2026: после выкатки журнал
   * заполнился `OD_ABORTED ERROR ... Invalid state: Controller is already closed`).
   * `cancel()` закрывает контроллер, а `pull()`, уже ждавший `reader.read()`, возвращается
   * позже и пытается `enqueue`/`error` в закрытый контроллер — исключение превращалось
   * в ERROR-строку на каждый обычный обрыв. Держим один флаг и пишем в контроллер ТОЛЬКО
   * пока клиент жив; поздний выход гасим молча.
   */
  let clientGone = false
  const closeQuietly = (c: ReadableStreamDefaultController<Uint8Array>) => {
    try { c.close() } catch { /* контроллер уже закрыт клиентом или ошибкой */ }
  }
  const errorQuietly = (c: ReadableStreamDefaultController<Uint8Array>, e: unknown) => {
    try { c.error(e) } catch { /* контроллер уже закрыт клиентом */ }
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (clientGone) return
      try {
        const { done, value } = await reader.read()
        // Клиент ушёл, пока мы ждали чужой ответ: читать больше некому.
        if (clientGone) { reader.cancel().catch(() => {}); return }
        if (done) {
          ctx.emit({
            level: upstream.ok ? 'info' : 'error',
            kind: upstream.ok ? EVENT.GO_COMPLETE : EVENT.GO_ERROR,
            sessionId, model, status: upstream.status, durationMs: Date.now() - t0,
            msg: `дверь OpenDesign: ${chosen!.email} → ${upstream.status} (поток закрыт)`,
          })
          finish(kept, true)
          releaseSlot?.()
          closeQuietly(controller)
          return
        }
        if (keptBytes < STREAM_CAP_BYTES) {
          kept += decoder.decode(value, { stream: true })
          keptBytes += value.byteLength
        }
        controller.enqueue(value)
      } catch (err) {
        // Уже ушли — это не отказ двери: закрываем счёт и молчим.
        if (clientGone) { finish(kept, true); releaseSlot?.(); return }
        ctx.emit({
          level: 'error', kind: EVENT.OD_ABORTED, sessionId, model, status: upstream.status,
          durationMs: Date.now() - t0,
          msg: `дверь OpenDesign: поток оборвался — ${String((err as any)?.message ?? err).slice(0, 160)}`,
        })
        finish(kept, true)
        releaseSlot?.()
        errorQuietly(controller, err)
      }
    },
    cancel() {
      clientGone = true
      finish(kept, true)
      releaseSlot?.()
      reader.cancel().catch(() => {})
      ctx.emit({
        level: 'info', kind: EVENT.OD_ABORTED, sessionId, model, status: upstream.status,
        durationMs: Date.now() - t0,
        msg: 'дверь OpenDesign: клиент оборвал чтение — исход отдельный, не отказ двери',
      })
    },
  })

  return new Response(stream, { status: upstream.status, headers: passHeaders })
}

export function createOpenDesignDoorModule(): ProxyModule {
  const routes: RouteDefinition[] = [
    { method: 'POST', path: '/od/chat/completions', handler: (req) => serve(req) },
  ]
  return { name: 'open-design-door', routes, init(c) { ctx = c } }
}

/** Для испытаний: сброс пинов между проверками. */
export function resetOpenDesignPins(): void { pins.clear(); pinsLoaded = false }
/** Для испытаний: подменить память привязок без файла. */
export function restoreOpenDesignPinsForTest(entries: Array<[string, { email: string; at: number }]>): void {
  pins.clear(); pinsLoaded = true
  for (const [k, v] of entries) pins.set(k, v)
}
/** Для испытаний: снимок привязок. */
export function odPinsSnapshot(): Record<string, { email: string; at: number }> {
  return Object.fromEntries(pins)
}
