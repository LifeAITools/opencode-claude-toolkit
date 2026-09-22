import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * stats-emitter — узкая, ВЕРСИОНИРОВАННАЯ строка статистики на каждый завершённый ход.
 *
 * Контракт (одна строка на квалифицированный ответ):
 *   { v, ts, pid, type:"stream", model, usage:{ in, out, cacheRead, cacheWrite } }
 *
 * Это ровно форма `claude-max-stats.jsonl` соседнего claude-max-proxy — перенесён НЕ кодом,
 * а контрактом, поэтому потребитель (панель, quota-watcher) читает оба файла одними глазами.
 *
 * Failure policy: отказ записи НИКОГДА не распространяется в обработку запроса. Каждое
 * append обёрнуто; на беде пишется одно дросселированное предупреждение, строка теряется.
 * Пайплайн деградирует до «устаревшая статистика», а не до упавшего прокси.
 */

export const STATS_SCHEMA_VERSION = 1

export interface StatsUsage {
  in: number
  out: number
  cacheRead: number
  /** Выводимая величина, пока OpenAI-совместимый апстрим не даёт `cache_creation` отдельным
   *  полем: `prompt_tokens − cached_tokens`. Это версионируемый факт схемы `v`, а не
   *  молчаливое поле — при появлении апстримного поля переходим без ломки потребителя. */
  cacheWrite: number
}

export interface StatsLine {
  v: number
  ts: string
  pid: number
  type: 'stream'
  model: string
  usage: StatsUsage
}

const WRITE_WARN_THROTTLE_MS = 30_000
let lastWriteWarnAt = 0

export function appendStatsLine(path: string, line: StatsLine): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(line) + '\n')
  } catch (error: unknown) {
    const now = Date.now()
    if (now - lastWriteWarnAt >= WRITE_WARN_THROTTLE_MS) {
      lastWriteWarnAt = now
      // Best-effort; если и это упало — всё равно не роняем.
      try {
        console.warn(
          `proxy-core:stats-emitter append to ${path} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      } catch {}
    }
  }
}