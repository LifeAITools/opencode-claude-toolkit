/**
 * СЛЕД ПОТОКА — нативный повтор формата ядра (PRPs/harness-adapters/09-stream-trace.md).
 *
 * ПОЧЕМУ ПОВТОР, А НЕ ЗАВИСИМОСТЬ. Прокси не тянет @kiberos/signal-wire-core
 * зависимостью (бинарь собирается отдельно, поезда релизов разные) — формат
 * повторён дословно: файл session-stream-<sid>.json, поля chars/deltas/
 * stream_started_at/last_delta_at/ended_at/harness, прореживание 5 с, первый
 * кусок и конец сразу, атомарная запись tmp→rename, каталог SW_HEARTBEAT_DIR.
 * Считаются символы, не токены. Нет номера сессии — нет следа (решает вызыватель:
 * при idSource none след не пишется вовсе).
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export interface StreamTrace {
  session_id: string
  harness: 'claude-code'
  chars: number
  deltas: number
  stream_started_at: string
  last_delta_at: string
  ended_at?: string
}

export function streamTraceDir(): string {
  const raw = process.env.SW_HEARTBEAT_DIR
  return raw && raw.trim() ? raw.trim() : join(homedir(), '.claude', 'hooks', 'state')
}

export function streamTracePath(dir: string, sessionId: string): string {
  return join(dir, `session-stream-${sessionId}.json`)
}

export const STREAM_TRACE_INTERVAL_MS = 5000

interface Live { trace: StreamTrace; lastWriteMs: number }

/**
 * Учётчик потока: delta на каждый кусок текста, end на message_stop.
 * На обрыв потока end НЕ зовётся (зовёт вызыватель только на штатном конце) —
 * «замолчал» остаётся отличимым от «закончил».
 */
export class StreamTracer {
  private readonly live = new Map<string, Live>()
  private readonly intervalMs: number

  constructor(
    private readonly dir: string,
    intervalMs: number = STREAM_TRACE_INTERVAL_MS,
  ) {
    this.intervalMs = intervalMs
  }

  delta(sessionId: string, text: string): void {
    if (!sessionId) return
    const t = Date.now()
    const iso = new Date(t).toISOString()
    let l = this.live.get(sessionId)
    if (!l) {
      l = {
        trace: { session_id: sessionId, harness: 'claude-code', chars: 0, deltas: 0, stream_started_at: iso, last_delta_at: iso },
        lastWriteMs: Number.NEGATIVE_INFINITY,
      }
      this.live.set(sessionId, l)
    }
    l.trace.chars += text.length
    l.trace.deltas += 1
    l.trace.last_delta_at = iso
    if (t - l.lastWriteMs >= this.intervalMs) {
      this.write(l.trace)
      l.lastWriteMs = t
    }
  }

  end(sessionId: string): void {
    if (!sessionId) return
    const l = this.live.get(sessionId)
    if (!l) return
    this.live.delete(sessionId)
    this.write({ ...l.trace, ended_at: new Date().toISOString() })
  }

  private write(st: StreamTrace): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const p = streamTracePath(this.dir, st.session_id)
      const tmp = `${p}.tmp.${process.pid}`
      writeFileSync(tmp, JSON.stringify(st) + '\n')
      renameSync(tmp, p)
    } catch {
      // След — сведение для показа, не часть ответа: сбой не роняет поток.
    }
  }
}
