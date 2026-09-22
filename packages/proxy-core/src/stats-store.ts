import { Database } from 'bun:sqlite'

/**
 * stats-store — статистика расхода в SQLite (WAL), защищённая от параллельной записи.
 *
 * Почему база, а не append-JSONL: несколько прокси пишут в один стора, панель читает
 * одновременно. WAL даёт конкурентных читателей + сериализованного писателя; каждый INSERT —
 * короткая транзакция, поэтому SQLite сам сериализует запись между процессами, а
 * `busy_timeout` заставляет второго писателя ПОДОЖДАТЬ вместо падения с `SQLITE_BUSY`.
 *
 * 🔴 ПОДКЛЮЧЕНИЕ НЕ КОПИТСЯ (урок 07.09: проверка копилки соединений съела пул и молча
 * выключила запрет записи). Каждая операция открывает соединение и закрывает его в finally;
 * читающие открывают ТОЛЬКО readonly.
 */

export interface UsageRow {
  ts: string
  pid: number
  provider: string | null
  model: string | null
  sessionId: string | null
  inputTokens: number
  outputTokens: number
  cacheRead: number
  cacheWrite: number
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  pid INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  session_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  cache_write INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage(session_id);
`

function open(path: string, readonly: boolean): Database {
  return new Database(path, { create: true, readonly })
}

/** Схема + WAL + busy_timeout. Идемпотентна, зовётся при старте прокси (и при каждом
 *  писателе — CREATE IF NOT EXISTS дёшев, а WAL-режим применяется на каждое новое соединение). */
export function initStore(path: string): void {
  const db = open(path, false)
  try {
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA synchronous = NORMAL;')
    db.exec('PRAGMA busy_timeout = 5000;')
    db.exec(SCHEMA)
  } finally {
    db.close()
  }
}

/** Одна строка = одна короткая транзакция. Упадёт крайне-только при физической беде — не
 *  ронять разговор: вызывающий оборачивает. */
export function insertUsage(path: string, row: UsageRow): void {
  const db = open(path, false)
  try {
    db.exec('PRAGMA busy_timeout = 5000;')
    db.run(
      'INSERT INTO usage (ts, pid, provider, model, session_id, input_tokens, output_tokens, cache_read, cache_write) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.ts, row.pid, row.provider, row.model, row.sessionId, row.inputTokens, row.outputTokens, row.cacheRead, row.cacheWrite],
    )
  } finally {
    db.close()
  }
}

/** Агрегат для панели — читающая операция, подключение readonly. */
export function aggregateUsage(
  path: string,
  opts: { provider?: string; hours?: number } = {},
): { totalInput: number; totalOutput: number; totalCacheRead: number; rows: number } {
  const db = open(path, true)
  try {
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (opts.provider) {
      clauses.push('provider = ?')
      params.push(opts.provider)
    }
    if (opts.hours) {
      const since = new Date(Date.now() - opts.hours * 3600_000).toISOString()
      clauses.push('ts >= ?')
      params.push(since)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = db
      .query(
        `SELECT COUNT(*) AS rows, COALESCE(SUM(input_tokens),0) AS ti, COALESCE(SUM(output_tokens),0) AS \`to\`, COALESCE(SUM(cache_read),0) AS cr FROM usage ${where}`,
      )
      .get(...(params as [never]))
    const r = row as { rows: number; ti: number; to: number; cr: number }
    return { rows: r.rows, totalInput: r.ti, totalOutput: r.to, totalCacheRead: r.cr }
  } finally {
    db.close()
  }
}