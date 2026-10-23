/**
 * ДВЕРЬ USAGE ПОДПИСКИ GO/ZEN — opencode.ai/zen/go/v1/usage (provider-go-usage.ts).
 *
 * ЗАЧЕМ. Окна подписки (5h/неделя/месяц со сбросами) отдаёт только эта дверь;
 * в базе opencode их нет, а ключ opencode-go из auth.json дверь отвергает
 * (401 без схемы, 403 с Bearer — замер 06.10). Нужен ключ формы auth-login
 * (таблица credential или Zen-ключ) — его делает вход, см. ниже.
 *
 * ЧЕСТНАЯ ГРАНИЦА МОДУЛЯ. Форму успешного ответа живьём ещё никто не снимал:
 * модуль везёт сырой JSON как есть и НЕ выдумывает окна. Отображение в окна —
 * вторым шагом, когда первый успешный ответ покажет форму (факты, не догадка).
 * Ключи читаются в момент запроса (таблица credential, затем auth.json: Zen,
 * затем Go), нигде не хранятся и ни в какой журнал не едут.
 */

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export interface GoUsageRaw {
  provider: 'zen' | 'go'
  measuredAt: string
  /** Сырой JSON успешного ответа — форму покажет первый живой замер. */
  data: unknown
}

const finiteStr = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/**
 * Ключи рабочей области по порядку двери: сначала Zen, затем Go; сначала
 * таблица credential (форма auth-login), затем auth.json. Возвращает пары
 * {provider, key} без самих значений наружу — вызывающая сторона их не логирует.
 */
export function resolveWorkspaceKeys(
  dbRows: Array<{ integration_id?: unknown; value?: unknown }>,
  authJson: Record<string, { key?: unknown }>,
): Array<{ provider: 'zen' | 'go'; key: string }> {
  const out: Array<{ provider: 'zen' | 'go'; key: string }> = []
  const push = (provider: 'zen' | 'go', key: unknown) => {
    const k = finiteStr(key)
    if (k && !out.some((e) => e.key === k)) out.push({ provider, key: k })
  }
  for (const row of dbRows ?? []) {
    const id = typeof row.integration_id === 'string' ? row.integration_id.trim() : ''
    let key: unknown = null
    try { key = JSON.parse(String(row.value ?? '')).key } catch { key = null }
    if (id === 'opencode') push('zen', key)
    else if (id === 'opencode-go') push('go', key)
  }
  push('zen', authJson?.['opencode']?.key)
  push('zen', authJson?.['zen']?.key)
  push('go', authJson?.['opencode-go']?.key)
  // Порядок двери: Zen первым, затем Go.
  out.sort((a, b) => (a.provider === b.provider ? 0 : a.provider === 'zen' ? -1 : 1))
  return out
}

/**
 * Один опрос двери первым же работающим ключом. 200 — сырой JSON как есть;
 * всё остальное — null (дверь без ключа, отказ, сеть). Никогда не бросает.
 */
export async function queryGoUsage(
  fetchFn: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
  }>,
  keys: Array<{ provider: 'zen' | 'go'; key: string }>,
  now: Date = new Date(),
): Promise<GoUsageRaw | null> {
  for (const { provider, key } of keys) {
    try {
      const res = await fetchFn(GO_USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) continue
      const data = await res.json()
      if (data == null) continue
      return { provider, measuredAt: now.toISOString(), data }
    } catch {
      continue
    }
  }
  return null
}

/**
 * ОКНА GO ИЗ ПУБЛИЧНЫХ ЛИМИТОВ И ИЗМЕРЕННОГО РАСХОДА — без входа.
 *
 * ЗАЧЕМ БЕЗ ДВЕРИ. Лимиты подписки публичны (docs.opencode.ai/docs/go):
 * окна — доли месячного лимита модели (5h = 20%, неделя = 50%, месяц = 100%),
 * а расход — наш собственный замер из базы. Вход в консоль не нужен вовсе:
 * дверь usage отвечает только консольной сессии, а арифметика та же.
 * Честная граница: виден только трафик этой машины; месячный лимит — из
 * таблицы доков для плана Go (Plus выше — тогда доля меньше, см. ниже).
 */

/** Месячный лимит модели в USD, план Go (docs 06.10.2026; у Plus выше). */
export const GO_MODEL_MONTHLY_LIMIT_USD: Readonly<Record<string, number>> = {
  'muse-spark-1.3-contributor': 120,
  'muse-spark-1.2-contributor': 120,
}

export interface GoWindow {
  kind: '5h' | '7d' | '30d'
  /** Доля лимита 0..1 (spent/limit). */
  util: number
  spent: number
  limit: number
  measuredAt: string
}

/**
 * Окна по модели: расход за 5ч/7д/30д против долей месячного лимита.
 * Лимита нет в таблице — null (не выдумываем).
 */
export function computeGoWindows(
  modelId: string,
  spend5h: number | null,
  spendWeek: number | null,
  spendMonth: number | null,
  now: Date = new Date(),
): GoWindow[] | null {
  const monthly = GO_MODEL_MONTHLY_LIMIT_USD[modelId]
  if (monthly == null) return null
  const measuredAt = now.toISOString()
  const w = (kind: GoWindow['kind'], frac: number, spent: number | null): GoWindow => {
    const limit = monthly * frac
    const s = spent ?? 0
    // 🔴 ЗАЖИМ 0..1. Без него `spent/limit` давал больше единицы — а «util5h=1» означает «окно
    // исчерпано» и зовёт агента на сдачу смены. Замер 22.10.2026: оценка по расходу выдала 1 при
    // живом окне (в реестре 0.01) — правдоподобное число не про то, с ценой в ложную сдачу.
    const ratio = limit > 0 ? s / limit : 0
    return { kind, util: Math.min(1, Math.max(0, ratio)), spent: s, limit, measuredAt }
  }
  return [w('5h', 0.2, spend5h), w('7d', 0.5, spendWeek), w('30d', 1, spendMonth)]
}

/** Файл окон подписки Go, который пишет прокси (claude-max-proxy/opencode-go-quota.ts). */
export const GO_QUOTA_STATUS_JSON = join(homedir(), '.claude-local', 'quota-status-opencode-go.json')

export interface GoStatusWindow {
  kind: string
  /** Доля 0..1. */
  util: number
  resetAt?: string
  measuredAt: string
}

/**
 * Окна АКТИВНОЙ организации Go из файла квоты, который пишет прокси.
 *
 * 🔴 ЗАЧЕМ, 16.10.2026. Окна подписки отдаёт только дверь провайдера, и её
 * снимает `go_refresher` в kiberos-app → файл `quota-status-opencode-go.json`.
 * Адаптер его НЕ читал: `computeGoWindows` выше считает окна лишь по моделям с
 * известным лимитом (Spark), а флотские модели (`deepseek-*-go`) оставались без
 * окон вовсе — ядро не могло судить паузу по квоте Go.
 *
 * 🔴 ОРГАНИЗАЦИЯ — ЭТОГО АГЕНТА, А НЕ АКТИВНАЯ В ФАЙЛЕ (22.10.2026, находка владельца
 * signal-wire, замер на живом). В `accounts` файла лежит РОВНО ОДНА запись — активная, а окна
 * каждой организации лежат в `orgs[]`. Поэтому два агента на разных организациях видели одни и
 * те же числа, и отличить это от правды было нельзя, пока они совпадали. Источник привязки —
 * `KIBEROS_GO_ORG` в окружении сессии (пишет пускатель; живьём, без HTTP и кэша). Нет
 * переменной — падаем на активную и НАЗЫВАЕМ это в `basis`, а не выдаём за назначение.
 *
 * Форма — как у provider-quota: `util` 0..1, `measuredAt` ISO (ценз 300 с у
 * потребителя). `week` → `7d`, `month` → `30d` — ради согласия с тем, как окна
 * зовёт Claude-снимок и `GoWindow`. Нет файла или окон — null (не выдумываем).
 */
export function readGoQuotaStatusWindows(
  path: string = GO_QUOTA_STATUS_JSON,
  opts: { org?: string; now?: number } = {},
): {
  measuredAt: string
  windows: GoStatusWindow[]
  basis: 'agent_org' | 'active_fallback'
  /** Окна, чей срок ИСТЁК: их числа — про закрытое окно и НЕ переезжают в новое. */
  expired?: string[]
} | null {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8')) as {
      measured_at?: unknown
      updatedAt?: unknown
      org?: unknown
      orgs?: Array<{ name?: unknown; windows?: unknown }>
      accounts?: Record<string, { active?: unknown; windows?: unknown }>
    }
    const measuredAt = finiteStr(d.measured_at) ?? finiteStr(d.updatedAt)
    if (!measuredAt) return null
    const accounts = d.accounts ?? {}
    // 🔴 THE AGENT'S OWN ORG FIRST (owner of this finding: packages-signal-wire-core-owner,
    // 2026-10-22, measured): `accounts` carries exactly ONE entry — the file's ACTIVE org — while
    // EVERY org's windows sit in `orgs[]`. Reading the active entry made two agents on two
    // different orgs see the same numbers, indistinguishable from truth until they disagree.
    // `KIBEROS_GO_ORG` is the assignment the launcher wrote into this session's environment: live,
    // no HTTP, no cache, and it changes only at rebirth. Absent ⇒ fall back to the active org and
    // SAY SO (`basis`), never silently.
    const wanted = finiteStr(opts.org)
    let raw: unknown
    let basis: 'agent_org' | 'active_fallback' = 'active_fallback'
    if (wanted) {
      const row = (Array.isArray(d.orgs) ? d.orgs : []).find((o) => finiteStr(o?.name) === wanted)
      // 🔴 ОРГАНИЗАЦИЯ НАЗВАНА, А ОКОН ПОД НЕЁ НЕТ — ОТВЕЧАЕМ «НЕ ЗНАЮ», А НЕ ЧУЖИМИ ЧИСЛАМИ.
      // Замер 22.10.2026: без этого гейта агент на организации, которой нет в `orgs[]` (или у
      // которой окон нет вовсе), получал окна АКТИВНОЙ организации — при этом `quotaAccountHint`
      // ему подставлялось ЕГО имя. То есть имя от одной организации, числа от другой, и отличить
      // это от правды было нельзя. «Неизвестно» здесь честнее правдоподобного числа не про то.
      if (!row || !Array.isArray(row.windows) || row.windows.length === 0) return null
      raw = row.windows
      basis = 'agent_org'
    }
    if (!Array.isArray(raw)) {
      const orgName = finiteStr(d.org)
      let acct = orgName ? accounts[orgName] : undefined
      if (!acct) acct = Object.values(accounts).find((a) => a?.active === true)
      raw = acct?.windows
    }
    if (!Array.isArray(raw)) return null
    const KIND: Record<string, string> = { '5h': '5h', week: '7d', month: '30d' }
    const windows: GoStatusWindow[] = []
    // 🔴 ЦЕНЗ ПО СБРОСУ — ЗДЕСЬ, А НЕ У ЧИТАТЕЛЯ (находка владельца signal-wire, 23.10.2026).
    // Производитель переписывает файл целиком и переносит СТАРОЕ число под СВЕЖИЙ штамп, поэтому
    // `measuredAt` свежий, а окно может быть уже закрыто. Замер до правки: `reset`=17:21Z, а
    // подвал печатал 5h=0.96 в 21:30Z — четыре часа ПОСЛЕ сброса, и агент дважды остановил работу
    // на числе, которое больше никого не ограничивает.
    // Читатель такое не различит: число выглядит живым. Число, чей срок истёк, — это НЕ измерение
    // текущего окна, поэтому оно здесь не отдаётся вовсе, а окно НАЗЫВАЕТСЯ истёкшим.
    const now = opts.now ?? Date.now()
    const expired: string[] = []
    for (const w of raw) {
      if (!w || typeof w !== 'object') continue
      const ww = w as { window?: unknown; util?: unknown; resetIso?: unknown }
      const kind = typeof ww.window === 'string' ? (KIND[ww.window] ?? ww.window) : null
      const util = typeof ww.util === 'number' && Number.isFinite(ww.util) ? ww.util : null
      if (!kind || util === null) continue
      const iso = finiteStr(ww.resetIso)
      if (iso) {
        const resetMs = Date.parse(iso)
        if (Number.isFinite(resetMs) && resetMs <= now) {
          // Окно закрыто: util принадлежит ему же и в новом окне не значит ничего.
          expired.push(kind)
          continue
        }
        const out: GoStatusWindow = { kind, util, measuredAt, resetAt: iso }
        windows.push(out)
        continue
      }
      // Сброс НЕИЗВЕСТЕН — судить не по чему, окно остаётся (fail-open: прежнее поведение).
      windows.push({ kind, util, measuredAt })
    }
    if (windows.length > 0) return { measuredAt, windows, basis, ...(expired.length ? { expired } : {}) }
    // Все окна закрыты: текущих измерений нет. Отдаём явное «пусто + причина», а не null,
    // чтобы потребитель мог сказать «сброшено», а не «данных нет вовсе».
    return expired.length > 0 ? { measuredAt, windows, basis, expired } : null
  } catch {
    return null
  }
}
