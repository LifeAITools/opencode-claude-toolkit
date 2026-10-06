/**
 * РАСХОД СЕССИИ АГЕНТА OPENCODE — из его же локальной базы, а не из догадок.
 *
 * ЗАЧЕМ. Реестр присутствия ждёт половинку расхода (spend) и окон квоты, а платить
 * за вход в личный кабинет поставщика некому: у адаптера нет логина никуда. Зато
 * сам opencode пишет расход каждого ответа в свою базу (`message.data`: tokens +
 * cost) — ключом служит id сессии opencode. Замер 06.10: индексированный SUM по
 * своей сессии на базе 3.8 ГБ — 2 мс, то есть его можно делать на каждом ответе.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Лимиты подписки/портала здесь не разведаны — их несёт
 * владелец ядра отдельно; этот модуль отдаёт только измеренный расход, а остаток
 * (лимит минус расход) считает потребитель, который лимит знает.
 *
 * ВАЛЮТА — USD, строкой в договоре. В самой базе валюты нет, но владелец ядра
 * подтвердил живьём 06.10 (знак в интерфейсе opencode, прайсинг в USD, сверено
 * со stats за сутки): cost из базы читается в долларах.
 *
 * ОКНА. Подписка одна на пользователя машины, поэтому окна считаются по ВСЕМ
 * сессиям базы, а не по своей: rolling 5ч, неделя 7 сут, месяц 30 сут от now.
 * resetAt нет (дни сброса недели/месяца неизвестны — реестр принимает без них).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionSpend {
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  /** Сумма cost по ответам сессии; null — ни у одного ответа цены не было. */
  cost: number | null
  /** USD — подтверждено живьём (см. шапку), а не угадано из базы. */
  currency: 'USD'
  measuredAt: string
}

export interface WindowSpend {
  kind: 'rolling' | 'weekly' | 'monthly'
  windowMs: number
  /** Сумма cost по всем сессиям в окне; null — расхода не было. */
  spent: number | null
  measuredAt: string
}

export const SPEND_WINDOWS: ReadonlyArray<{ kind: WindowSpend['kind']; windowMs: number }> = [
  { kind: 'rolling', windowMs: 5 * 3600_000 },
  { kind: 'weekly', windowMs: 7 * 24 * 3600_000 },
  { kind: 'monthly', windowMs: 30 * 24 * 3600_000 },
]

/** Путь базы opencode этого пользователя. */
export function defaultOpencodeDbPath(): string {
  return join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/**
 * Расход одной сессии: суммы по её ответам ассистента. Любая неудача
 * (нет базы, закрыта, чужая сессия без строк) — null, а не нули: отсутствие
 * ключа нельзя спутать с законным нулём.
 */
export function readSessionSpend(
  openDb: (path: string) => { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void },
  dbPath: string,
  sessionId: string,
  now: Date = new Date(),
): SessionSpend | null {
  if (!sessionId || sessionId === 'unknown') return null
  let db: { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void } | null = null
  try {
    db = openDb(dbPath)
    const row = db.query(
      `SELECT count(*) AS n,
        sum(json_extract(data,'$.tokens.input')) AS input,
        sum(json_extract(data,'$.tokens.output')) AS output,
        sum(json_extract(data,'$.tokens.reasoning')) AS reasoning,
        sum(json_extract(data,'$.cost')) AS cost
       FROM message WHERE session_id = ? AND json_extract(data,'$.role') = 'assistant'`,
    ).get(sessionId) as { n: number; input: number | null; output: number | null; reasoning: number | null; cost: number | null } | null
    if (!row || num(row.n) === 0) return null
    return {
      inputTokens: num(row.input),
      outputTokens: num(row.output),
      reasoningTokens: num(row.reasoning),
      cost: row.cost == null ? null : num(row.cost),
      currency: 'USD',
      measuredAt: now.toISOString(),
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* закрытие — тоже best-effort */ }
  }
}

/**
 * Расход по окнам подписки: суммы cost по всем сессиям базы за каждое окно.
 * Пустое окно — spent null (не 0): «не было расхода» отличается от «потрачено ноль».
 */export function readWindowSpend(
  openDb: (path: string) => { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void },
  dbPath: string,
  nowMs: number = Date.now(),
): WindowSpend[] | null {
  const measuredAt = new Date(nowMs).toISOString()
  let db: { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void } | null = null
  try {
    db = openDb(dbPath)
    const out: WindowSpend[] = []
    for (const w of SPEND_WINDOWS) {
      const row = db.query(
        `SELECT count(*) AS n, sum(json_extract(data,'$.cost')) AS cost
         FROM message WHERE time_created >= ? AND json_extract(data,'$.role') = 'assistant'`,
      ).get(nowMs - w.windowMs) as { n: number; cost: number | null } | null
      if (!row || num(row.n) === 0) {
        out.push({ kind: w.kind, windowMs: w.windowMs, spent: null, measuredAt })
      } else {
        out.push({ kind: w.kind, windowMs: w.windowMs, spent: row.cost == null ? null : num(row.cost), measuredAt })
      }
    }
    return out
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* закрытие — тоже best-effort */ }
  }
}

/**
 * Расход одной модели за окна Go (5ч/7д/30д): суммы cost её ответов.
 * Для computeGoWindows (provider-go-usage.ts). Пустое окно — null.
 */
export function readModelWindowSpend(
  openDb: (path: string) => { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void },
  dbPath: string,
  modelId: string,
  nowMs: number = Date.now(),
): { spend5h: number | null; spendWeek: number | null; spendMonth: number | null } | null {
  if (!modelId) return null
  const WINDOWS = [5 * 3600_000, 7 * 24 * 3600_000, 30 * 24 * 3600_000]
  let db: { query: (sql: string) => { get: (...args: any[]) => any }; close: () => void } | null = null
  try {
    db = openDb(dbPath)
    const spends: Array<number | null> = []
    for (const w of WINDOWS) {
      const row = db.query(
        `SELECT count(*) AS n, sum(json_extract(data,'$.cost')) AS cost
         FROM message WHERE time_created >= ? AND json_extract(data,'$.role') = 'assistant'
         AND json_extract(data,'$.modelID') = ?`,
      ).get(nowMs - w, modelId) as { n: number; cost: number | null } | null
      spends.push(!row || num(row.n) === 0 ? null : row.cost == null ? null : num(row.cost))
    }
    return { spend5h: spends[0]!, spendWeek: spends[1]!, spendMonth: spends[2]! }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* закрытие — тоже best-effort */ }
  }
}
