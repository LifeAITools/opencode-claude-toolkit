/**
 * Жива ли сессия флота DeepSeek Harness — по его собственному списку текущих сессий.
 *
 * Зачем (14.11.2026, письмо vibe-deepseek-harness-owner): у флота в ОДНОМ процессе живут ~23
 * агента, каждый со своей сессией, и все ходят через LiteLLM :4000 — номер процесса прокси не
 * опознаёт. Уборщик снимал такие сессии через 2 ч после последнего хода, хотя флот держал их
 * текущими, а прогрев — их кэш (session-f933b5aa: ход 20:26:04Z, прогрев до 22:17Z, снята
 * 22:26:05Z; утром продолжить на тёплом кэше было нельзя).
 *
 * Источник — `~/.dsh/fleet-sessions.json` ({ <binding>: { sessionId, at, role } }), его пишет
 * сам флот при выборе сессии агента. Файл, а не дверь /live: локален, без сети и без токена,
 * и отвечает в часы тишины, когда сессия ходов не шлёт.
 *
 * Ответ: true — сессия числится текущей у агента; undefined — не знаю (пусть решают часы).
 * НИКОГДА false: отсутствие в чужом файле — не доказательство смерти. Файл старше суток —
 * не опора (флот могли остановить целиком, а его сессии не должны жить вечно).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FLEET_SESSIONS_MAX_AGE_MS = 24 * 60 * 60 * 1000

export function fleetSessionsPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_FLEET_SESSIONS_PATH ?? join(env.HOME ?? homedir(), '.dsh', 'fleet-sessions.json')
}

export function fleetSessionLiveness(
  path: string,
  now: () => number = Date.now,
): (sessionId: string) => boolean | undefined {
  let cache: { mtimeMs: number; ids: Set<string> } | null = null
  return (sessionId: string) => {
    try {
      if (!existsSync(path)) return undefined
      const m = statSync(path).mtimeMs
      if (now() - m > FLEET_SESSIONS_MAX_AGE_MS) return undefined
      if (!cache || cache.mtimeMs !== m) {
        const doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { sessionId?: unknown }>
        const ids = new Set<string>()
        for (const v of Object.values(doc ?? {})) {
          if (v && typeof v.sessionId === 'string' && v.sessionId) ids.add(v.sessionId)
        }
        cache = { mtimeMs: m, ids }
      }
      return cache.ids.has(sessionId) ? true : undefined
    } catch {
      return undefined
    }
  }
}
