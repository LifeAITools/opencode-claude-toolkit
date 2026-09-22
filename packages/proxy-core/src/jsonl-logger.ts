import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * jsonl-logger — общий логер строк в том же формате, что уже у claude-max-proxy:
 * `{ts, level, kind, msg}`. Наблюдательный слой: отказ записи не должен ронять разговор.
 */

export interface LogEntry {
  level: 'debug' | 'info' | 'warn' | 'error'
  kind: string
  msg: string
}

export function logLine(path: string, entry: LogEntry): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* наблюдательный слой — молча */
  }
}