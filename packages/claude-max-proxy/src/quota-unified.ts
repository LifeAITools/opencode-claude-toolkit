#!/usr/bin/env bun
/**
 * quota-unified — ОДИН формат квоты для всех провайдеров.
 *
 * ЗАЧЕМ (слово фаундера 05.11.2026): «каждый провайдер выдаёт по-своему, а за пределами
 * нашего kiberos-go прокси мы должны отдавать единообразно, чтобы остальные системы —
 * OpenCode Go harness, DeepSeek harness — получали эти данные нативно, без адаптации
 * под каждого провайдера».
 *
 * Каждый провайдер пишет СВОЙ файл (`quota-status-<provider>.json`), потому что источник
 * у каждого свой и падает он по-своему. Здесь эти файлы приводятся к одному контракту:
 * снаружи спрашивают `/quota` и не знают, откуда пришли числа.
 *
 * 🔴 ТРИ ПРАВИЛА, БЕЗ КОТОРЫХ ЕДИНЫЙ ФОРМАТ СТАНОВИТСЯ ЛОЖЬЮ:
 * 1. Отсутствующее число — `null`, а НЕ `0` (рельс null-is-not-zero-in-measurements).
 * 2. У каждого числа есть ВОЗРАСТ и ИСТОЧНИК (`measuredAt`, `ageSec`, `source`) —
 *    рельс number-carries-subject-and-age.
 * 3. Провайдер, который сломался, не исчезает из ответа: он приходит со `status:
 *    'unreadable'` и причиной. Иначе список «работающих» читается как «все работают».
 */
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { CLAUDE_LOCAL } from './quota-paths.js'
import { loadProviderRegistry } from './provider-registry.js'

// 🔴 ИМЯ ФАЙЛА НЕ ДОЛЖНО СОВПАДАТЬ С ФАЙЛОМ КВОТЫ ANTHROPIC (замер 05.11.2026).
// `quota-status.json` уже занят: его пишет сама дверь для подвала Claude (поля
// version/accounts/pids/sessions/orgs/traffic). Мой единый файл сначала назывался так же —
// два писателя топили друг друга: то пропадал `providers`, то окна Go.
export const UNIFIED_QUOTA_JSON = join(CLAUDE_LOCAL, 'quota-status-unified.json')
/** Свежесть: сборщики ходят раз в 5 минут. Три пропуска — это уже «не про сейчас». */
export const STALE_AFTER_SEC = 1200

export type WindowName = '5h' | 'week' | 'month'

export interface UnifiedWindow {
  name: WindowName
  /** Доля использованного 0..1. `null` — не измерено (это НЕ ноль). */
  usedFraction: number | null
  resetsAt: string | null
  source: 'provider-api' | 'own-accounting'
  /** Окно выбрано до предела. Явный признак, а не «догадка по 1.0». */
  exhausted: boolean
}

export interface UnifiedAccount {
  provider: string
  account: string | null
  plan: string | null
  walletUsd: string | null
  status: 'active' | 'absent' | 'exhausted' | 'unreadable'
  level: 'ok' | 'warning' | 'critical' | null
  measuredAt: string | null
  ageSec: number | null
  stale: boolean
  windows: UnifiedWindow[]
  /**
   * Запас до ближайшей стены: 1 − наибольшая занятость среди окон. `null` — не измерено.
   * 🔴 Зачем числом, а не ярлыком (поправка home-relishev-general 05.11.2026): `active`
   * при неделе 99% и `active` при неделе 17% — одно слово и два разных решения. Ярлык
   * говорит «можно», а число — «на сколько ходов».
   */
  headroomFraction: number | null
  /** До какого числа держится окно, которое и ограничивает запас. */
  bindsUntil: string | null
  /**
   * Стабильный идентификатор аккаунта У ПРОВАЙДЕРА: у Go — `uid` организации, у OpenDesign —
   * `workspaceId`. Почему не только email (просьба packages-lat-context-owner 05.11.2026):
   * email — слабый ключ соединения с агентом, его переименование или алиас молча рвут связь,
   * а один и тот же email встречается у ДВУХ провайдеров (`relishev@gmail.com` есть и в
   * open-design, и в opencode-go). `null` — провайдер такого поля не даёт (это НЕ «нет аккаунта»).
   */
  orgUid: string | null
  /**
   * Значение `billingMode` ОТ ПОСТАВЩИКА — как есть, без толкования (05.11.2026).
   * У обоих workspace OpenDesign стоит `shared`; что это значит — НЕ УСТАНОВЛЕНО
   * (владелец аккаунта отверг трактовку «общий счёт»). `null` — поле не отдано.
   */
  billingMode: string | null
  /** Почему нет чисел. Для `status !== 'active'` — обязательное объяснение. */
  reason?: string
  /**
   * Какое окно упёрлось и до какого числа. Заполняется, когда `status === 'exhausted'`.
   * 🔴 Без этого «есть квота» и «можно работать» выглядят одинаково (замер 05.11.2026:
   * 10 организаций с МЕСЯЦЕМ 100% показывались зелёными, потому что срок пропуска живой).
   */
  exhaustedWindow?: { name: WindowName; resetsAt: string | null }
}

/**
 * ДЕНЬГИ — ОТДЕЛЬНЫМ БЛОКОМ, А НЕ ОКНОМ (решение 07.11.2026, вопрос vibe-deepseek-harness-owner).
 *
 * 🔴 Почему не `windows[].kind='budget'`: окно измеряется ДОЛЕЙ и имеет предел; деньги —
 * НАКОПЛЕНИЕ с необязательным периодом. Смешать единицы в одном массиве значит заставить
 * каждого потребителя разбирать, в чём измерено именно это окно, — и рано или поздно
 * кто-то сложит проценты с рублями.
 *
 * 🔴 Почему МАССИВ, а не один блок: у суммы обязан быть ПРЕДМЕТ (`subject`) и ИСТОЧНИК
 * (`source`). LiteLLM считает по ключу, наш dsh-счётчик — по ответу, провайдер — по
 * организации. Один блок на провайдера заставил бы их делить место и приписывать число
 * чужому счёту — ровно тот класс, что стоил нам расхождений 05–07.11.
 */
export type SpendBasis = 'per-request' | 'key' | 'account' | 'org' | 'instance'

export interface SpendReading {
  /** Валюта ISO-4217 ('USD'). Без неё число не сравнимо ни с чем. */
  currency: string
  /** Накопленный расход за период `since`: НЕ остаток и НЕ бюджет. */
  total: number
  /** Чей это счётчик. Обязателен: сумма без предмета — не факт. */
  basis: SpendBasis
  /** Конкретный предмет: id ключа, email аккаунта или имя организации. */
  subject: string
  /** С какого момента накопление. Без этого `total` невозможно проверить. */
  since: string
  /** Когда число снято (возраст замера, а не период накопления). */
  measuredAt: string
  /** Кто именно это измерил: 'litellm_spend_logs' | 'x-litellm-response-cost' | 'provider-api' | … */
  source: string
  /** Бюджет, если задан. `null` — бюджета нет; отсутствие поля — не сообщили. */
  limit?: number | null
  /** Когда период (и накопление) обнулится. */
  periodResetAt?: string | null
}

export interface UnifiedSnapshot {
  schemaVersion: 1
  generatedAt: string
  unit: { used: 'fraction'; range: '0..1' }
  accounts: UnifiedAccount[]
  providers: Record<string, {
    file: string | null
    status: 'active' | 'absent' | 'exhausted' | 'unreadable'
    reason?: string
    /**
     * Модели провайдера — из его же файла (`models`), как их называет посредник.
     * 🔴 Зачем (просьба packages-lat-context-owner 05.11.2026): читатель выбирает файл по
     * ТОЧНОМУ имени модели. Без списка остаётся путь «по организации», а он молчит ровно
     * там, где организация встречается у двух провайдеров. Пустой массив — провайдер
     * моделей не объявил; это НЕ «моделей нет».
     */
    models: string[]
    /** Откуда список: `provider-file` (живой ответ поставщика), `registry` (объявление
     *  в `config/providers.yaml`), `none` (ни там, ни там). Без этого пустой список
     *  читался бы как «моделей нет» — а это третье состояние, «не объявлено». */
    modelsSource: 'provider-file' | 'registry' | 'none'
    /** Денежные счётчики провайдера. Пусто/отсутствует — денег никто не мерил. */
    spend?: SpendReading[]
  }>
}

const SPEND_BASES: readonly SpendBasis[] = ['per-request', 'key', 'account', 'org', 'instance'] as const
/**
 * `cumulative` — синоним `instance`, а не отдельная семантика (07.11.2026).
 * Так назвал писатель счётчика всего посредника (`spend-litellm-local.json`), и без этого
 * алиаса строка ВЫБРАСЫВАЛАСЬ МОЛЧА — живая потеря денег, которую никто бы не заметил.
 * В схеме остаётся одно значение; синоним принимается на входе и приводится.
 */
const SPEND_BASIS_ALIASES: Record<string, SpendBasis> = { cumulative: 'instance' }

/**
 * Нормализация денежных счётчиков: принимаем массив или один объект, выбрасываем всё,
 * у чего нет ПРЕДМЕТА, ИСТОЧНИКА или ПЕРИОДА, либо сумма не число.
 * 🔴 Не «починить догадкой»: строка без `subject`/`since` — это не факт, и подставлять
 * ей имя провайдера значило бы вернуть класс «число с чужим предметом».
 */
export function normalizeSpend(v: unknown): SpendReading[] {
  return normalizeSpendDetailed(v).accepted
}

/**
 * То же, но с ПРИЧИНОЙ отказа по каждой строке (07.11.2026).
 *
 * 🔴 Зачем: валидатор молча выбрасывал строку, и писатель не мог узнать, что дальше приёма
 * она не прошла — так пропали $9 143,84 с `basis: 'cumulative'`. «Тихо» хуже, чем «красно».
 * Счётчики отказов ещё не в снимке (это находка F13 ревью); пока причина доступна через
 * `--check <файл>`.
 */
export function normalizeSpendDetailed(v: unknown): { accepted: SpendReading[]; rejected: Array<{ index: number; reason: string }> } {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []
  const accepted: SpendReading[] = []
  const rejected: Array<{ index: number; reason: string }> = []
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i]
    if (!raw || typeof raw !== 'object') { rejected.push({ index: i, reason: 'not_an_object' }); continue }
    const r = raw as Record<string, unknown>
    const total = num(r.total)
    const currency = typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : ''
    const subject = typeof r.subject === 'string' ? r.subject.trim() : ''
    const source = typeof r.source === 'string' ? r.source.trim() : ''
    const since = iso(r.since)
    const measuredAt = iso(r.measuredAt)
    const rawBasis = typeof r.basis === 'string' ? r.basis.trim().toLowerCase() : ''
    const basis = (SPEND_BASES as readonly string[]).includes(rawBasis)
      ? (rawBasis as SpendBasis)
      : (SPEND_BASIS_ALIASES[rawBasis] ?? null)
    const reason = total === null ? 'total_not_a_number'
      : !currency ? 'currency_missing'
        : !subject ? 'subject_missing'
          : !source ? 'source_missing'
            : !since ? 'since_invalid'
              : !measuredAt ? 'measuredAt_invalid'
                : !basis ? 'basis_unknown' : null
    if (reason) { rejected.push({ index: i, reason }); continue }
    accepted.push({
      currency, total: total as number, basis: basis as SpendBasis, subject, since: since as string,
      measuredAt: measuredAt as string, source,
      ...(r.limit === null || r.limit === undefined ? {} : { limit: num(r.limit) }),
      ...(r.periodResetAt === null || r.periodResetAt === undefined ? {} : { periodResetAt: iso(r.periodResetAt) }),
    })
  }
  return { accepted, rejected }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const iso = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  return Number.isFinite(Date.parse(v)) ? v : null
}

function ageOf(measuredAt: string | null, now: Date): number | null {
  if (!measuredAt) return null
  const t = Date.parse(measuredAt)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.round((now.getTime() - t) / 1000))
}

function levelOf(fiveHour: number | null): 'ok' | 'warning' | 'critical' | null {
  if (fiveHour === null) return null
  if (fiveHour >= 0.95) return 'critical'
  if (fiveHour >= 0.8) return 'warning'
  return 'ok'
}

/** Один провайдерный файл → нормализованные аккаунты. Чистая функция: тестируется без диска. */
export function unifyProviderFile(provider: string, doc: any, now: Date): UnifiedAccount[] {
  if (!doc || typeof doc !== 'object') {
    return [{ provider, account: null, orgUid: null, billingMode: null, plan: null, walletUsd: null, status: 'unreadable', level: null,
      measuredAt: null, ageSec: null, stale: true, headroomFraction: null, bindsUntil: null, windows: [], reason: 'file_unreadable' }]
  }
  const measuredAt = iso(doc.measured_at) ?? iso(doc.updatedAt)
  const ageSec = ageOf(measuredAt, now)
  const stale = ageSec === null ? true : ageSec > STALE_AFTER_SEC

  // Провайдер прямо объявил, что чисел нет (например, истёк вход в консоль).
  if (doc.quotaAbsent) {
    const reason = typeof doc.quotaAbsent === 'string'
      ? doc.quotaAbsent
      : String(doc.quotaAbsent?.reason ?? doc.error ?? 'quota_absent')
    return [{ provider, account: iso(doc.org) ?? doc.org ?? null, orgUid: null, billingMode: null, plan: doc.plan ?? null,
      walletUsd: doc.balanceUsd ?? null, status: 'absent', level: null, measuredAt, ageSec, stale,
      headroomFraction: null, bindsUntil: null, windows: [], reason }]
  }

  // 🔴 ДВА ИСТОЧНИКА ОДНОГО ФАКТА, И ВТОРОЙ НЕЛЬЗЯ ТЕРЯТЬ (замер 05.11.2026).
  // Сборщик Go кладёт в `accounts` ТОЛЬКО активную организацию, а все 18 — в `orgs[]`.
  // Пока читали только `accounts`, семнадцать организаций исчезали из единого формата,
  // и организация с МЕСЯЦЕМ 100% не показывалась вовсе. Поэтому: сначала `orgs[]`
  // (полный список), поверх него — `accounts` (там больше полей). Ключ — имя.
  const merged = new Map<string, any>()
  for (const o of Array.isArray(doc.orgs) ? doc.orgs : []) {
    const key = String(o?.name ?? o?.org ?? '').trim()
    if (key) merged.set(key, { ...o })
  }
  for (const [name, a] of Object.entries((doc.accounts && typeof doc.accounts === 'object' ? doc.accounts : {}) as Record<string, any>)) {
    const prev = merged.get(name)
    merged.set(name, prev ? { ...prev, ...a } : a)
  }
  const entries = [...merged.entries()]
  if (entries.length === 0) {
    return [{ provider, account: doc.org ?? null, orgUid: null, billingMode: null, plan: doc.plan ?? null, walletUsd: doc.balanceUsd ?? null,
      status: 'unreadable', level: null, measuredAt, ageSec, stale, headroomFraction: null, bindsUntil: null, windows: [],
      reason: typeof doc.error === 'string' ? doc.error : 'no_accounts' }]
  }

  return entries.map(([name, a]: [string, any]) => {
    const windows: UnifiedWindow[] = []
    const push = (w: WindowName, used: unknown, resets: unknown) => {
      const u = num(used)
      const r = iso(resets)
      if (u === null && r === null) return
      windows.push({ name: w, usedFraction: u, resetsAt: r, source: 'provider-api', exhausted: u !== null && u >= 1 })
    }
    if (Array.isArray(a?.windows) && a.windows.length) {
      for (const w of a.windows) {
        const label = String(w?.window ?? '').toLowerCase()
        const nm: WindowName | null =
          label === '5h' ? '5h' : label === 'week' || label === '7d' ? 'week' : label === 'month' ? 'month' : null
        if (!nm) continue
        const used = num(w?.util)
        const rateLimited = String(w?.status ?? '').toLowerCase() === 'rate-limited'
        windows.push({
          name: nm,
          usedFraction: used,
          resetsAt: iso(w?.resetIso) ?? (num(w?.resetAt) !== null ? new Date(num(w!.resetAt)!).toISOString() : null),
          source: 'provider-api',
          exhausted: rateLimited || (used !== null && used >= 1),
        })
      }
    } else {
      push('5h', a?.util5h, a?.reset5hAt)
      push('week', a?.util7d, a?.reset7dAt ?? a?.reset7dIso)
      push('month', a?.utilMonth, a?.resetMonthAt)
    }
    const five = windows.find(w => w.name === '5h')?.usedFraction ?? null
    const absent = typeof a?.absent === 'string' ? a.absent : undefined
    // 🔴 ГОДНОСТЬ — ПО ВСЕМ ОКНАМ СРАЗУ, а не по одному. Организация с МЕСЯЦЕМ 100%
    // не «работает»: она упрётся в отказ на первом же вызове, хотя срок пропуска живой.
    // Порядок окон здесь — порядок строгости: 5ч кончается раньше всех, месяц — позже.
    const measured = windows.filter(w => w.usedFraction !== null)
    const binding = measured.length
      ? measured.reduce((a, b) => ((b.usedFraction as number) > (a.usedFraction as number) ? b : a))
      : null
    const headroomFraction = binding ? Math.max(0, 1 - (binding.usedFraction as number)) : null
    const bindsUntil = binding?.resetsAt ?? null
    const hit = windows.find(w => w.exhausted) ?? null
    // 🔴 НЕТ НИ ОДНОГО ИЗМЕРЕННОГО ОКНА — ЭТО `unreadable`, А НЕ `active` (замер 05.11.2026).
    // `active` с пустым `windows[]` читался как «можно ходить», хотя числа не существует:
    // ровно тот класс, от которого предостерегал читатель подвала — ярлык говорит «да»,
    // а измерить не удалось (сломан вход, поставщик молчит). Три состояния, а не два:
    // измерено / упёрлось / измерить не удалось.
    const unmeasured = !absent && !hit && measured.length === 0
    const status = absent
      ? 'absent' as const
      : hit
        ? 'exhausted' as const
        : unmeasured ? 'unreadable' as const : 'active' as const
    const reason = absent
      ? absent
      : hit
        ? `${hit.name}_exhausted${hit.resetsAt ? `_until_${hit.resetsAt}` : ''}`
        : unmeasured ? 'no_windows_measured' : undefined
    // 🔴 КЛЮЧ СОЕДИНЕНИЯ — uuid, А НЕ EMAIL (просьба packages-lat-context-owner 05.11.2026).
    // Go отдаёт `uid` на организацию, OpenDesign — `workspaceId`. Берём первый доступный.
    const orgUid = (typeof a?.uid === 'string' && a.uid.trim())
      || (typeof a?.orgUid === 'string' && a.orgUid.trim())
      || (typeof a?.workspaceId === 'string' && a.workspaceId.trim())
      || (typeof a?.zitadelOrgId === 'string' && a.zitadelOrgId.trim())
      || null
    return {
      provider,
      account: a?.org ?? a?.accountHint ?? name ?? null,
      orgUid,
      billingMode: typeof a?.billingMode === 'string' && a.billingMode.trim() ? a.billingMode.trim() : null,
      plan: a?.plan ?? doc.plan ?? null,
      walletUsd: a?.balanceUsd ?? null,
      status,
      level: levelOf(five),
      measuredAt,
      ageSec,
      stale,
      headroomFraction,
      bindsUntil,
      windows,
      ...(reason ? { reason } : {}),
      ...(hit ? { exhaustedWindow: { name: hit.name, resetsAt: hit.resetsAt } } : {}),
    } satisfies UnifiedAccount
  })
}

/**
 * Модели из ОБЪЯВЛЕНИЯ (`config/providers.yaml`), когда поставщик их не отдал.
 * 🔴 Замер 05.11.2026: у Go живой запрос `GET /models` отвечает 401, и файл писал
 * `models: []`. Читателю подвала список нужен, чтобы выбрать провайдера по ТОЧНОМУ
 * имени модели; пустой список оставлял его на слабом пути «по организации». Объявление
 * в реестре — наш собственный SSOT, поэтому оно годится как запасной источник, но
 * ОБЯЗАНО называться (`modelsSource: 'registry'`), а не выдавать себя за живой ответ.
 */
function registryModels(provider: string): string[] {
  try {
    const path = join(import.meta.dir, '..', 'config', 'providers.yaml')
    if (!existsSync(path)) return []
    const reg = loadProviderRegistry(path)
    return reg.providers.find(p => p.id === provider)?.models ?? []
  } catch { return [] }
}

/** Все файлы каталога `quota-status-*.json` → один снимок. */
export function unifyAll(dir = CLAUDE_LOCAL, now = new Date()): UnifiedSnapshot {
  const accounts: UnifiedAccount[] = []
  const providers: UnifiedSnapshot['providers'] = {}
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => /^quota-status-[a-z0-9-]+\.json$/.test(f) && f !== 'quota-status.json' && f !== 'quota-status-unified.json')
  } catch { files = [] }
  // Деньги живут в СВОИХ файлах (`spend-<provider>.json`), а не в файле квоты: у суммы
  // свой писатель, и два писателя на один файл — та же беда, что с пропусками Go.
  const spendByProvider = new Map<string, SpendReading[]>()
  try {
    for (const f of readdirSync(dir).filter(f => /^spend-[a-z0-9-]+\.json$/.test(f))) {
      try {
        const doc: any = JSON.parse(readFileSync(join(dir, f), 'utf8'))
        const provider = typeof doc?.provider === 'string' && doc.provider.trim()
          ? doc.provider.trim() : f.replace(/^spend-/, '').replace(/\.json$/, '')
        const list = normalizeSpend(doc?.spend ?? doc?.spends ?? doc)
        if (list.length) spendByProvider.set(provider, [...(spendByProvider.get(provider) ?? []), ...list])
      } catch { /* битый файл не рушит сборку: деньги — не повод потерять квоту */ }
    }
  } catch { /* каталог не читается — денег просто нет */ }

  for (const file of files.sort()) {
    const provider = file.replace(/^quota-status-/, '').replace(/\.json$/, '')
    let doc: any = null
    try { doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) } catch { doc = null }
    const list = unifyProviderFile(provider, doc, now)
    accounts.push(...list)
    // Худшее состояние называет провайдера честно: одна упёршаяся организация важнее
    // десяти живых, потому что в подвале зелёный цвет — это «можно ходить».
    // 🔴 ПОРЯДОК СТРОГОСТИ: exhausted > unreadable > absent > active. `unreadable` стоит
    // ПОСЛЕ `exhausted` нарочно: с 05.11.2026 аккаунт без измеренных окон помечается
    // `unreadable`, и если поставить его первым, провайдер с тремя живыми и двумя
    // нечитаемыми читался бы как «сломан целиком» — то есть тот же обман, только навыворот.
    const worst: UnifiedAccount['status'] = list.some(a => a.status === 'exhausted')
      ? 'exhausted'
      : list.some(a => a.status === 'unreadable')
        ? 'unreadable'
        : list.every(a => a.status === 'absent') ? 'absent' : 'active'
    // Причина берётся у той записи, которая и определила худшее состояние, — иначе
    // провайдер «active» тащил бы на себе чужую причину (замер 05.11.2026: у open-design
    // в причине стояло no_active_subscription от второй, пустой организации).
    // Деньги: свой файл + (если провайдер сам их объявил) его поле `spend`.
    const spendOf: SpendReading[] = [...(spendByProvider.get(provider) ?? []), ...normalizeSpend(doc?.spend)]
    const liveModels: string[] = Array.isArray(doc?.models)
      ? (doc.models as unknown[]).filter((m): m is string => typeof m === 'string' && m.length > 0)
      : []
    const declaredModels = liveModels.length ? [] : registryModels(provider)
    const worstEntry = list.find(a => a.status === worst && a.reason)
    providers[provider] = {
      file: existsSync(join(dir, file)) ? file : null,
      status: worst,
      // Сначала живой ответ поставщика, затем наше собственное объявление.
      // Каждый источник НАЗВАН — «пусто» и «не объявлено» не должны выглядеть одинаково.
      models: liveModels.length ? liveModels : declaredModels,
      modelsSource: liveModels.length ? 'provider-file' : declaredModels.length ? 'registry' : 'none',
      ...(worst !== 'active' && worstEntry?.reason ? { reason: worstEntry.reason } : {}),
      ...(spendOf.length ? { spend: spendOf } : {}),
    }
  }
  // 🔴 ДЕНЬГИ БЕЗ ФАЙЛА КВОТЫ НЕ ТЕРЯЕМ МОЛЧА (07.11.2026). Если spend-файл называет
  // провайдера, для которого нет `quota-status-<id>.json`, прежний код просто не создавал
  // запись — сумма исчезала, и никто бы не узнал. Это не «нет данных», это несовпадение
  // имени (живой пример: сборщик пишет `kiberos-go`, а наш id — `opencode-go`).
  // Статус `unreadable` здесь честен: квоту этого провайдера мы не меряем, но сумму видно.
  for (const [p, list] of spendByProvider) {
    if (providers[p] || !list.length) continue
    providers[p] = { file: null, status: 'unreadable', reason: 'no_quota_file', models: [], modelsSource: 'none', spend: list }
  }
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    unit: { used: 'fraction', range: '0..1' },
    accounts,
    providers,
  }
}

export function writeUnified(snap: UnifiedSnapshot, path = UNIFIED_QUOTA_JSON): string {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n')
  renameSync(tmp, path)
  return path
}

if (import.meta.main) {
  // `--check <файл>` — приём одного spend-файла без записи снимка. Писатель зовёт после
  // записи и видит, ПРОШЛА ли строка и почему нет. Код возврата: 0 всё принято,
  // 2 есть отказы или пусто. Это и есть «куда положить код возврата».
  if (process.argv[2] === '--check') {
    const file = process.argv[3]
    if (!file) { console.error('usage: quota-unified.ts --check <spend-file.json>'); process.exit(2) }
    let doc: any = null
    try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
      console.log(JSON.stringify({ file, ok: false, error: 'unreadable_or_not_json' }))
      process.exit(2)
    }
    const { accepted, rejected } = normalizeSpendDetailed(doc?.spend ?? doc?.spends ?? doc)
    console.log(JSON.stringify({ file, ok: accepted.length > 0 && rejected.length === 0, accepted: accepted.length, rejected }, null, 2))
    process.exit(accepted.length > 0 && rejected.length === 0 ? 0 : 2)
  }
  const snap = unifyAll()
  const out = writeUnified(snap)
  console.log(`[quota-unified] ${out}: ${snap.accounts.length} аккаунт(ов) от ${Object.keys(snap.providers).length} провайдер(ов)`)
  for (const [p, s] of Object.entries(snap.providers)) console.log(`  ${p}: ${s.status}${s.reason ? ' — ' + s.reason : ''}`)
}
