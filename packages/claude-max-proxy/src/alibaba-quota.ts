#!/usr/bin/env bun
/**
 * alibaba-quota — остаток подписки Alibaba Token Plan в файл квоты, для подвала агентов OpenCode.
 *
 * 🔴 ЗАЧЕМ (02.10.2026, просьба фаундера через vibe-yjs-todo-sync-owner). Агенты OpenCode на
 * моделях Alibaba показывали в подвале «квота поставщика не измерена»: lat-context 0.227.0
 * перестал класть им пул Claude, а своего файла у них не было. Читает файл lat-context
 * (packages-lat-context-owner), пишет его только этот сборщик.
 *
 * ОТКУДА ЧИСЛА. В заголовках ответов Token Plan остатка нет (замер 02.10). Остаток отдаёт консоль
 * Alibaba (`tokenplan/personal/api/v2/usage`) по входу, который делает `bl auth login --console`.
 * 🔴 НЕ ЧЕРЕЗ `bl usage token-plan`: утилита разбирает только per5Hour* и per1Week*, а наш план
 * МЕСЯЧНЫЙ — консоль прислала per1MonthPercentage 0.0247 и per1MonthResetTime, и `bl` показал
 * «лимит, возможно, не ограничен» с пустым JSON (замер 02.10). Поэтому запрос повторён здесь в
 * точности так, как его шлёт `bl` (виден в `--verbose`), а окна читаются все: 5h, неделя, месяц.
 * Вход истекает (NotLogined) — тогда файл говорит об этом прямо (`error`), а не молчит.
 *
 * КАКИМ МОДЕЛЯМ ПРИНАДЛЕЖИТ. Не догадка по приставке: берутся провайдеры opencode, чей baseURL
 * ведёт в подписку (прямо или через прослойку openai-compat-proxy), и умножаются на GET /models
 * подписки, спрошенный ключом этого провайдера. Получается `provider/model` в той форме, что
 * у агентов в строках присутствия.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CLAUDE_LOCAL, QUOTA_STATUS_ALIBABA_JSON, classifyLevel } from './quota-paths.js'
import { postSystemNotice, type SystemNotice, type SystemNoticeResult } from './surface-card.js'

export interface TokenPlanUsage {
  per5HourPercentage?: number
  per5HourResetTime?: number
  per1WeekPercentage?: number
  per1WeekResetTime?: number
  per1MonthPercentage?: number
  per1MonthResetTime?: number
}

export interface PlanProvider {
  id: string
  baseURL: string
  apiKey: string
}

/** Провайдеры opencode, чей baseURL ведёт в подписку: напрямую или через локальную прослойку. */
export function findPlanProviders(
  opencodeConfig: unknown,
  planBases: string[],
): PlanProvider[] {
  const norm = (u: string) => u.replace(/\/+$/, '').replace(/\/v1$/, '')
  const bases = new Set(planBases.map(norm))
  const providers = (opencodeConfig as { provider?: Record<string, { options?: { baseURL?: string; apiKey?: string } }> })?.provider ?? {}
  const out: PlanProvider[] = []
  for (const [id, p] of Object.entries(providers)) {
    const baseURL = p?.options?.baseURL
    const apiKey = p?.options?.apiKey
    if (typeof baseURL === 'string' && typeof apiKey === 'string' && bases.has(norm(baseURL))) {
      out.push({ id, baseURL, apiKey })
    }
  }
  return out
}

/** Отпечаток ключа для имени аккаунта: по нему видно, что ключ сменился, сам ключ не утекает. */
export function accountHintFor(apiKey: string): string {
  return 'alibaba-tokenplan-' + createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
}

export interface BuildInput {
  usage: TokenPlanUsage | null
  error: string | null
  accountHint: string
  models: string[]
  modelsSource: string
  measuredAt: Date
  /** Эпизод истёкшего входа — пишется в файл как названное отсутствие. */
  quotaAbsent?: QuotaAbsent | null
}

const iso = (ms: number | undefined) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : null)
const frac = (v: number | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Файл в форме quota-status.json с provider:"alibaba". Чистая функция — испытывается без сети. */
export function buildAlibabaQuotaStatus(input: BuildInput): Record<string, unknown> {
  const { usage, error, accountHint, models, modelsSource, measuredAt } = input
  const base = {
    version: 1,
    provider: 'alibaba',
    updatedAt: measuredAt.toISOString(),
    measured_at: measuredAt.toISOString(),
    models,
    models_source: modelsSource,
  }
  if (!usage) {
    // Названное отсутствие: читатель покажет причину, а не старые или выдуманные числа.
    return { ...base, error: error ?? 'no_usage', ...(input.quotaAbsent ? { quotaAbsent: input.quotaAbsent } : {}), accounts: {} }
  }
  const util5h = frac(usage.per5HourPercentage)
  const util7d = frac(usage.per1WeekPercentage)
  const utilMonth = frac(usage.per1MonthPercentage)
  // Длинное окно, которое кончится раньше всех, судится по недельным порогам: месяц — тоже
  // «длинный» лимит, и его край так же нельзя перейти посреди шага.
  const longest = util7d === null ? utilMonth : utilMonth === null ? util7d : Math.max(util7d, utilMonth)
  const level = classifyLevel(util5h, longest)
  const windows = [
    { window: '5h', util: util5h, resetAt: usage.per5HourResetTime ?? null, resetIso: iso(usage.per5HourResetTime) },
    { window: 'week', util: util7d, resetAt: usage.per1WeekResetTime ?? null, resetIso: iso(usage.per1WeekResetTime) },
    { window: 'month', util: utilMonth, resetAt: usage.per1MonthResetTime ?? null, resetIso: iso(usage.per1MonthResetTime) },
  ].filter((w) => w.util !== null)
  const pct = (v: number) => (Math.round(v * 1000) / 10) + '%'
  return {
    ...base,
    accounts: {
      [accountHint]: {
        accountHint,
        util5h,
        util7d,
        utilMonth,
        resetAt: usage.per5HourResetTime ?? null,
        resetAt7d: usage.per1WeekResetTime ?? null,
        resetAtMonth: usage.per1MonthResetTime ?? null,
        reset5hAt: iso(usage.per5HourResetTime),
        reset7dAt: iso(usage.per1WeekResetTime),
        resetMonthAt: iso(usage.per1MonthResetTime),
        // Окна, которые план реально ограничивает. Окна нет — план его не ограничивает.
        windows,
        level,
        message: windows.length === 0
          ? 'Alibaba Token Plan: the plan reports no limited window.'
          : 'Alibaba Token Plan: ' + windows.map((w) => `${w.window} ${pct(w.util as number)}`).join(', ') + '.',
      },
    },
  }
}

/** Атомарная запись: читатель никогда не видит полфайла. */
export function writeAtomic(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
  renameSync(tmp, path)
}

export interface ConsoleSession {
  token: string
  switchAgent: number | string | null
  region: string
}

/** Вход консоли из настроек `bl` (~/.bailian/config.json). Нет входа — null. */
export function readConsoleSession(blConfigPath: string): ConsoleSession | null {
  try {
    const c = JSON.parse(readFileSync(blConfigPath, 'utf8')) as Record<string, unknown>
    if (typeof c.access_token !== 'string' || !c.access_token) return null
    return {
      token: c.access_token,
      switchAgent: (c.console_switch_agent as number | string | undefined) ?? null,
      region: typeof c.console_region === 'string' ? c.console_region : 'ap-southeast-1',
    }
  } catch {
    return null
  }
}

const USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'

/** Тот же запрос, что шлёт `bl usage token-plan` (международный шлюз консоли). */
export async function readTokenPlanUsage(
  session: ConsoleSession | null,
  gatewayHost: string,
  fetcher: typeof fetch = fetch,
): Promise<{ usage: TokenPlanUsage | null; error: string | null }> {
  if (!session) return { usage: null, error: 'console_login_required: run `bl auth login --console --console-site international`' }
  const params = JSON.stringify({
    Api: USAGE_API,
    V: '1.0',
    Data: { cornerstoneParam: { protocol: 'V2', console: 'ONE_CONSOLE', productCode: 'p_efm', switchUserType: 3, consoleSite: 'BAILIAN_ALIYUN', switchAgent: session.switchAgent } },
  })
  try {
    const res = await fetcher(`https://${gatewayHost}/cli/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(USAGE_API)}`, {
      method: 'POST',
      headers: { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded', authorization: `Bearer ${session.token}` },
      body: new URLSearchParams({ params, region: session.region }).toString(),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return { usage: null, error: `console_http_${res.status}` }
    const body = (await res.json()) as { data?: { success?: boolean; errorCode?: unknown; DataV2?: { data?: { success?: boolean; data?: TokenPlanUsage; code?: string } } } }
    const d = body.data
    if (d?.success === false && d.errorCode) {
      const code = String(typeof d.errorCode === 'string' ? d.errorCode : JSON.stringify(d.errorCode))
      return { usage: null, error: code.includes('NotLogined') ? 'console_login_required: run `bl auth login --console --console-site international`' : `console_error: ${code.slice(0, 200)}` }
    }
    const inner = d?.DataV2?.data
    if (!inner || inner.success === false || !inner.data) return { usage: null, error: `console_no_data: ${String(inner?.code ?? 'empty')}` }
    return { usage: inner.data, error: null }
  } catch (e) {
    return { usage: null, error: `console_unreachable: ${String((e as Error).message).slice(0, 200)}` }
  }
}

async function planModels(provider: PlanProvider, fetcher: typeof fetch): Promise<string[] | null> {
  try {
    const res = await fetcher(provider.baseURL.replace(/\/+$/, '') + (provider.baseURL.replace(/\/+$/, '').endsWith('/v1') ? '' : '/v1') + '/models', {
      headers: { authorization: `Bearer ${provider.apiKey}` },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
    return ids.length > 0 ? ids : null
  } catch {
    return null
  }
}

// ─── Истёкший вход: эпизод, одна строка фаундеру, оценка срока жизни входа ─────────────────
//
// 🔴 ЗАЧЕМ (02.10.2026, просьба через vibe-yjs-todo-sync-owner). У входа `bl` нет ключа
// обновления, и срок его жизни нигде не назван. Фаундер спросил прямо: входить ли каждый день?
// Ответ даст первый же эпизод: момент входа (когда `bl` записал свои настройки) и первый отказ.
// Пока эпизод открыт, файл квоты говорит «отсутствует, потому что…», а не показывает пустоту
// или старое число; фаундеру — ОДНА строка на эпизод и одна, когда вход вернулся.

export interface QuotaAbsent {
  reason: 'console_login_expired'
  since: string
  lastOkAt: string | null
  loginAt: string | null
  /** Сколько прожил вход: не меньше (до последнего удачного замера) и не больше (до первого отказа). */
  loginLifetimeMs: { atLeast: number | null; atMost: number | null }
}

export interface EpisodeState {
  lastOkAt: string | null
  episode: (QuotaAbsent & { notifiedAt: string | null }) | null
}

export const ALIBABA_QUOTA_STATE_JSON = join(CLAUDE_LOCAL, 'alibaba-quota-state.json')

function readState(path: string): EpisodeState {
  try {
    const s = JSON.parse(readFileSync(path, 'utf8')) as EpisodeState
    return { lastOkAt: s.lastOkAt ?? null, episode: s.episode ?? null }
  } catch {
    return { lastOkAt: null, episode: null }
  }
}

function loginAtFrom(blConfigPath: string): Date | null {
  try {
    return statSync(blConfigPath).mtime
  } catch {
    return null
  }
}

const hours = (ms: number | null) => (ms === null ? '?' : (ms / 3_600_000).toFixed(1).replace(/\.0$/, '') + ' ч')

export function isLoginError(error: string | null): boolean {
  return !!error && error.startsWith('console_login_required')
}

/**
 * Один шаг эпизода. Чистая логика (без сети и диска): что записать в состояние, что сказать
 * фаундеру. Строка отправляется, пока не уйдёт (notifiedAt), — но не больше одной на эпизод.
 */
export function advanceEpisode(
  state: EpisodeState,
  ok: boolean,
  loginError: boolean,
  now: Date,
  loginAt: Date | null,
): { state: EpisodeState; notice: string | null; absent: QuotaAbsent | null } {
  if (ok) {
    const closed = state.episode
    const notice = closed && closed.notifiedAt
      ? `**Квота Alibaba снова видна.** Вход в консоль Alibaba восстановлен — сборщик снова пишет остаток подписки в подвал агентов OpenCode. Прошлый вход прожил ${closed.loginLifetimeMs.atLeast === null ? 'неизвестно сколько' : 'от ' + hours(closed.loginLifetimeMs.atLeast) + ' до ' + hours(closed.loginLifetimeMs.atMost)}.`
      : null
    return { state: { lastOkAt: now.toISOString(), episode: null }, notice, absent: null }
  }
  if (!loginError) return { state, notice: null, absent: null }
  let ep = state.episode
  if (!ep) {
    const loginMs = loginAt ? loginAt.getTime() : null
    const lastOkMs = state.lastOkAt ? Date.parse(state.lastOkAt) : null
    ep = {
      reason: 'console_login_expired',
      since: now.toISOString(),
      lastOkAt: state.lastOkAt,
      loginAt: loginAt ? loginAt.toISOString() : null,
      loginLifetimeMs: {
        atLeast: loginMs !== null && lastOkMs !== null && lastOkMs >= loginMs ? lastOkMs - loginMs : null,
        atMost: loginMs !== null ? now.getTime() - loginMs : null,
      },
      notifiedAt: null,
    }
  }
  const { notifiedAt: _n, ...absent } = ep
  const notice = ep.notifiedAt
    ? null
    : `**Квота Alibaba не видна: вход в консоль истёк.** Подвал агентов OpenCode на моделях Alibaba показывает «не измерено», пока вход не вернут. Вход прожил ${ep.loginLifetimeMs.atLeast === null ? 'неизвестно сколько' : 'от ' + hours(ep.loginLifetimeMs.atLeast) + ' до ' + hours(ep.loginLifetimeMs.atMost)}. Вернуть — на этой машине: \`bl auth login --console --console-site international\``
  return { state: { lastOkAt: state.lastOkAt, episode: ep }, notice, absent }
}

export interface CollectOptions {
  opencodeConfigPath: string
  planBases: string[]
  blConfigPath: string
  gatewayHost: string
  outPath: string
  fetcher?: typeof fetch
  readUsage?: () => Promise<{ usage: TokenPlanUsage | null; error: string | null }>
  now?: () => Date
  statePath?: string
  notice?: { chatId: string; threadId: string } | null
  sendNotice?: (n: SystemNotice) => Promise<SystemNoticeResult>
}

export async function collectOnce(opts: CollectOptions): Promise<Record<string, unknown>> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? (() => new Date())
  const config = Bun.JSONC.parse(readFileSync(opts.opencodeConfigPath, 'utf8'))
  const providers = findPlanProviders(config, opts.planBases)
  const models: string[] = []
  const sources: string[] = []
  for (const p of providers) {
    const ids = await planModels(p, fetcher)
    if (ids) {
      for (const id of ids) models.push(`${p.id}/${id}`)
      sources.push(`${p.id}: GET ${p.baseURL}/models (${ids.length})`)
    } else {
      sources.push(`${p.id}: GET /models failed`)
    }
  }
  const { usage, error } = opts.readUsage
    ? await opts.readUsage()
    : await readTokenPlanUsage(readConsoleSession(opts.blConfigPath), opts.gatewayHost, fetcher)
  const measuredAt = now()
  const statePath = opts.statePath ?? ALIBABA_QUOTA_STATE_JSON
  const step = advanceEpisode(readState(statePath), usage !== null, isLoginError(error), measuredAt, loginAtFrom(opts.blConfigPath))
  let state = step.state
  if (step.notice && opts.notice) {
    const r = await (opts.sendNotice ?? postSystemNotice)({ ...opts.notice, text: step.notice })
    if (r.sent && state.episode) state = { ...state, episode: { ...state.episode, notifiedAt: measuredAt.toISOString() } }
    if (!r.sent) console.error(`[alibaba-quota] notice not sent: ${r.reason ?? 'unknown'} — retry next run`)
  }
  writeAtomic(statePath, state)
  const status = buildAlibabaQuotaStatus({
    quotaAbsent: step.absent,
    usage,
    error: providers.length === 0 ? 'no_plan_provider_in_opencode_config' : error,
    accountHint: providers[0] ? accountHintFor(providers[0].apiKey) : 'alibaba-tokenplan-unknown',
    models: models.sort(),
    modelsSource: sources.join('; ') || 'no plan provider found',
    measuredAt,
  })
  writeAtomic(opts.outPath, status)
  return status
}

if (import.meta.main) {
  const home = homedir()
  const planBases = (process.env.ALIBABA_TOKEN_PLAN_BASES ??
    'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode,http://127.0.0.1:17100').split(',').map((s) => s.trim()).filter(Boolean)
  const status = await collectOnce({
    opencodeConfigPath: process.env.OPENCODE_CONFIG_PATH ?? join(home, '.config', 'opencode', 'opencode.jsonc'),
    planBases,
    blConfigPath: process.env.BL_CONFIG_PATH ?? join(home, '.bailian', 'config.json'),
    gatewayHost: process.env.ALIBABA_CONSOLE_GATEWAY ?? 'bailian-singapore-cs.alibabacloud.com',
    outPath: process.env.QUOTA_STATUS_ALIBABA_JSON ?? QUOTA_STATUS_ALIBABA_JSON,
    // Комната проекта claude-code-sdk — та же, куда идёт строка о покупке кэша прогревом.
    notice: { chatId: process.env.ALIBABA_NOTICE_CHAT_ID ?? '-1004351473367', threadId: process.env.ALIBABA_NOTICE_THREAD_ID ?? '9090' },
  })
  console.log(JSON.stringify({ written: process.env.QUOTA_STATUS_ALIBABA_JSON ?? QUOTA_STATUS_ALIBABA_JSON, error: status.error ?? null, models: (status.models as string[]).length }))
}
