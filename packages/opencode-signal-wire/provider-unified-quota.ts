/**
 * ПЕРВОИСТОЧНИК ЧТЕНИЯ КВОТЫ — ОДИН ФАЙЛ НА ВСЕХ.
 *
 * Слово фаундера 05.11.2026: «данные должны проходить по правильному пайплайну и только
 * через первоисточник истины; иначе начинаются фолбэки и непонятные ошибки».
 *
 * Было ДВА прямых чтения (файл Go и файл OpenDesign) и два разных разборщика. Плюс env
 * `KIBEROS_GO_ORG`, который застывает при рождении агента. Отсюда и брались числа не про тот
 * предмет.
 *
 * Стало:
 *   сборщик провайдера → свой файл (внутреннее дело сборщика) → ЕДИНЫЙ quota-status.json
 *   → этот модуль → подвал/правила. Другого пути чтения нет.
 *
 * 🔴 ЧЕГО ЗДЕСЬ НЕТ И НЕ БУДЕТ: фолбэка на провайдерный файл, если единого нет. Нет файла —
 * значит «не измерено» (пусто), а не «возьмём ближайшее». Именно фолбэк и рождает тихие
 * ошибки: число есть, а про кого оно — неизвестно.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const UNIFIED_QUOTA_JSON = join(homedir(), '.claude-local', 'quota-status-unified.json')

export function unifiedQuotaPath(): string {
  return process.env.QUOTA_STATUS_JSON?.trim() || UNIFIED_QUOTA_JSON
}

export type UnifiedProviderId = 'opencode-go' | 'open-design' | 'alibaba' | string
export type UnifiedWindowKind = '5h' | '7d' | '30d'

export interface UnifiedQuotaReading {
  provider: UnifiedProviderId
  account: string | null
  measuredAt: string | null
  windows: Array<{ kind: UnifiedWindowKind; util: number; resetAt?: string }>
  /** Запас до ближайшей стены (1 − максимум занятости). null = не измерено. */
  headroomFraction: number | null
  bindsUntil: string | null
  status: 'active' | 'absent' | 'exhausted' | 'unreadable'
  /** Только для статусов, отличных от active. */
  reason?: string
  /** Пул по ВСЕМ аккаунтам провайдера — то, куда можно переехать. */
  pool: { util5h: number | null; util7d: number | null; accounts: number; level: string | null } | null
}

interface RawAccount {
  provider?: string
  account?: string | null
  status?: string
  measuredAt?: string | null
  headroomFraction?: number | null
  bindsUntil?: string | null
  reason?: string
  windows?: Array<{ name?: string; usedFraction?: number | null; resetsAt?: string | null }>
}

const KINDS: Record<string, UnifiedWindowKind> = { '5h': '5h', week: '7d', '7d': '7d', month: '30d', '30d': '30d' }

function readDoc(path: string): { accounts: RawAccount[]; generatedAt: string | null } | null {
  try {
    const d = JSON.parse(readFileSync(path, 'utf8'))
    if (!d || typeof d !== 'object' || !Array.isArray(d.accounts)) return null
    return { accounts: d.accounts as RawAccount[], generatedAt: typeof d.generatedAt === 'string' ? d.generatedAt : null }
  } catch { return null }
}

/**
 * Читает единый файл и отдаёт ОДНОГО провайдера.
 *
 * `account` — подсказка, кого именно спрашивают (для Go это привязка пускателя). Не назван —
 * берётся годный аккаунт с наибольшим запасом; нет годного — первый (он и объяснит причину).
 */
export function readUnifiedQuota(
  provider: UnifiedProviderId,
  opts: { account?: string | null; path?: string; refuseAmbiguous?: boolean } = {},
): UnifiedQuotaReading | null {
  const doc = readDoc(opts.path ?? unifiedQuotaPath())
  if (!doc) return null
  const own = doc.accounts.filter(a => (a.provider ?? '') === provider)
  if (!own.length) return null

  const wanted = (opts.account ?? '').trim()
  const byName = wanted ? own.find(a => (a.account ?? '') === wanted) : undefined
  const alive = own.filter(a => a.status === 'active')

  // 🔴 НЕ УГАДЫВАТЬ СЧЁТ (замер 05.11.2026). У OpenDesign ДВА живых счёта в одном
  // провайдере, и закрепление идёт по сессии — то есть «лучший по запасу» не имеет
  // отношения к тому, кто обслужил ЭТОТ запрос. Вызов `readUnifiedQuota('open-design')`
  // без подсказки возвращал hello@kiberos.app, тогда как проверенная по развёртываниям
  // сессия сидела на relishev@gmail.com: число с чужим предметом в подвале.
  // Здесь честный отказ: счёта не называем, чужие окна не показываем, пул — можно.
  if (opts.refuseAmbiguous && !byName && alive.length > 1) {
    const ha = alive.map(a => a.headroomFraction).filter((v): v is number => typeof v === 'number')
    return {
      provider,
      account: null,
      measuredAt: doc.generatedAt,
      windows: [],
      headroomFraction: null,
      bindsUntil: null,
      status: 'unreadable',
      reason: 'several_accounts_unresolved',
      pool: {
        util5h: ha.length ? 1 - Math.max(...ha) : null,
        util7d: null,
        accounts: alive.length,
        level: null,
      },
    }
  }
  const best = alive.sort((x, y) => (y.headroomFraction ?? -1) - (x.headroomFraction ?? -1))[0]
  const chosen = byName ?? best ?? own[0]

  const windows = (chosen.windows ?? [])
    .map(w => {
      const kind = KINDS[String(w.name ?? '')]
      const util = typeof w.usedFraction === 'number' && Number.isFinite(w.usedFraction) ? w.usedFraction : null
      if (!kind || util === null) return null
      return { kind, util, ...(typeof w.resetsAt === 'string' ? { resetAt: w.resetsAt } : {}) }
    })
    .filter((w): w is { kind: UnifiedWindowKind; util: number; resetAt?: string } => w !== null)

  // Пул — минимум по ЖИВЫМ аккаунтам провайдера: это запас флота, а не копия своего числа.
  // «Не измерено» в счёт не идёт (null ≠ 0).
  const pool5 = alive.map(a => a.headroomFraction).filter((v): v is number => typeof v === 'number')
  const pool = alive.length
    ? {
        util5h: pool5.length ? 1 - Math.max(...pool5) : null,
        util7d: null,
        accounts: alive.length,
        level: null,
      }
    : null

  return {
    provider,
    account: chosen.account ?? null,
    measuredAt: chosen.measuredAt ?? doc.generatedAt,
    windows,
    headroomFraction: chosen.headroomFraction ?? null,
    bindsUntil: chosen.bindsUntil ?? null,
    status: (chosen.status as UnifiedQuotaReading['status']) ?? 'unreadable',
    ...(chosen.reason ? { reason: chosen.reason } : {}),
    pool,
  }
}
