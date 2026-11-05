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
  /** Почему нет чисел. Для `status !== 'active'` — обязательное объяснение. */
  reason?: string
  /**
   * Какое окно упёрлось и до какого числа. Заполняется, когда `status === 'exhausted'`.
   * 🔴 Без этого «есть квота» и «можно работать» выглядят одинаково (замер 05.11.2026:
   * 10 организаций с МЕСЯЦЕМ 100% показывались зелёными, потому что срок пропуска живой).
   */
  exhaustedWindow?: { name: WindowName; resetsAt: string | null }
}

export interface UnifiedSnapshot {
  schemaVersion: 1
  generatedAt: string
  unit: { used: 'fraction'; range: '0..1' }
  accounts: UnifiedAccount[]
  providers: Record<string, { file: string | null; status: 'active' | 'absent' | 'exhausted' | 'unreadable'; reason?: string }>
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
    return [{ provider, account: null, plan: null, walletUsd: null, status: 'unreadable', level: null,
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
    return [{ provider, account: iso(doc.org) ?? doc.org ?? null, plan: doc.plan ?? null,
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
    return [{ provider, account: doc.org ?? null, plan: doc.plan ?? null, walletUsd: doc.balanceUsd ?? null,
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
    const status = absent ? 'absent' as const : hit ? 'exhausted' as const : 'active' as const
    const reason = absent
      ? absent
      : hit
        ? `${hit.name}_exhausted${hit.resetsAt ? `_until_${hit.resetsAt}` : ''}`
        : undefined
    return {
      provider,
      account: a?.org ?? a?.accountHint ?? name ?? null,
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

/** Все файлы каталога `quota-status-*.json` → один снимок. */
export function unifyAll(dir = CLAUDE_LOCAL, now = new Date()): UnifiedSnapshot {
  const accounts: UnifiedAccount[] = []
  const providers: UnifiedSnapshot['providers'] = {}
  let files: string[] = []
  try {
    files = readdirSync(dir).filter(f => /^quota-status-[a-z0-9-]+\.json$/.test(f) && f !== 'quota-status.json' && f !== 'quota-status-unified.json')
  } catch { files = [] }
  for (const file of files.sort()) {
    const provider = file.replace(/^quota-status-/, '').replace(/\.json$/, '')
    let doc: any = null
    try { doc = JSON.parse(readFileSync(join(dir, file), 'utf8')) } catch { doc = null }
    const list = unifyProviderFile(provider, doc, now)
    accounts.push(...list)
    // Худшее состояние называет провайдера честно: одна упёршаяся организация важнее
    // десяти живых, потому что в подвале зелёный цвет — это «можно ходить».
    // Порядок строгости: unreadable > exhausted > absent > active.
    const worst: UnifiedAccount['status'] = list.some(a => a.status === 'unreadable')
      ? 'unreadable'
      : list.some(a => a.status === 'exhausted')
        ? 'exhausted'
        : list.every(a => a.status === 'absent') ? 'absent' : 'active'
    // Причина берётся у той записи, которая и определила худшее состояние, — иначе
    // провайдер «active» тащил бы на себе чужую причину (замер 05.11.2026: у open-design
    // в причине стояло no_active_subscription от второй, пустой организации).
    const worstEntry = list.find(a => a.status === worst && a.reason)
    providers[provider] = {
      file: existsSync(join(dir, file)) ? file : null,
      status: worst,
      ...(worst !== 'active' && worstEntry?.reason ? { reason: worstEntry.reason } : {}),
    }
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
  const snap = unifyAll()
  const out = writeUnified(snap)
  console.log(`[quota-unified] ${out}: ${snap.accounts.length} аккаунт(ов) от ${Object.keys(snap.providers).length} провайдер(ов)`)
  for (const [p, s] of Object.entries(snap.providers)) console.log(`  ${p}: ${s.status}${s.reason ? ' — ' + s.reason : ''}`)
}
