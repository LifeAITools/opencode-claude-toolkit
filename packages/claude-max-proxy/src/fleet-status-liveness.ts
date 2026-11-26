/**
 * Жива ли сессия флота DeepSeek Harness — по сетевому слепку его сторожа (guard GET /status).
 *
 * Зачем (26.11.2026, слово фаундера): прокси может стоять на другой машине, чем флот, и тогда
 * локальный `~/.dsh/fleet-sessions.json` недоступен. Владелец флота (vibe-deepseek-harness-owner)
 * отдаёт слепок по сети: на каждую связку — `session`, `alive`, `presence.lastSeenAgeSec`
 * (метка раз в ~5 мин). События «сессия снята» флот наружу не отдаёт.
 *
 * Порт `isSessionAlive` СИНХРОННЫЙ, а сеть — нет, поэтому опрос идёт в фоне и кладёт слепок в
 * память; проверка читает только память и сеть не трогает.
 *
 * Ответ: true — сессия числится текущей у живой связки и отметка свежая; undefined — не знаю.
 * НИКОГДА false: «нет в слепке» — не доказательство смерти (рельса no-idle-reap-anthropic-sessions,
 * 16.11.2026), в слепке только ТЕКУЩАЯ сессия связки, а флот после перезапуска возвращает агента
 * в ту же сессию. Слепок старше `maxSnapshotAgeMs` — не опора (флот или сеть могли пропасть).
 *
 * Токен — отдельный, ТОЛЬКО НА ЧТЕНИЕ (прокси не должен уметь командовать флотом); читается из
 * файла на каждый опрос, в память надолго не кладётся и в журнал не пишется.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FLEET_STATUS_POLL_MS = 90_000
/** Слепок свежее этого — опора; старше — «не знаю» (пропущено ~3 опроса). */
export const FLEET_STATUS_MAX_SNAPSHOT_AGE_MS = 5 * 60_000
/** Метка присутствия связки старше этого — не доказательство жизни (метка раз в ~5 мин). */
export const FLEET_STATUS_MAX_PRESENCE_AGE_SEC = 15 * 60

export interface FleetStatusConfig {
  /** Адрес `GET /status` сторожа флота. Нет адреса — источник выключен. */
  url: string | undefined
  tokenPath: string
}

export function fleetStatusConfig(env: NodeJS.ProcessEnv = process.env): FleetStatusConfig {
  return {
    url: env.DSH_FLEET_STATUS_URL || undefined,
    tokenPath: env.DSH_FLEET_STATUS_TOKEN_PATH ?? join(env.HOME ?? homedir(), '.dsh', 'keys', 'control-token-read'),
  }
}

interface Snapshot {
  at: number
  live: Set<string>
}

export interface FleetStatusPoller {
  /** Синхронная проверка по слепку в памяти (форма порта `isSessionAlive`). */
  isSessionAlive(sessionId: string): boolean | undefined
  /** Один опрос; никогда не бросает, ошибку возвращает текстом (null — успех). */
  refresh(): Promise<string | null>
  start(): void
  stop(): void
}

export function createFleetStatusPoller(opts: {
  config: FleetStatusConfig
  now?: () => number
  fetchImpl?: typeof fetch
  readToken?: (path: string) => string
  pollMs?: number
  onError?: (msg: string) => void
}): FleetStatusPoller {
  const now = opts.now ?? Date.now
  const doFetch = opts.fetchImpl ?? fetch
  const readToken = opts.readToken ?? ((p: string) => readFileSync(p, 'utf8').trim())
  let snap: Snapshot | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let lastErr: string | null = null

  async function refresh(): Promise<string | null> {
    const { url, tokenPath } = opts.config
    if (!url) return 'disabled'
    try {
      const token = readToken(tokenPath)
      const res = await doFetch(url, { headers: { 'x-control-token': token }, signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const doc = (await res.json()) as { agents?: Array<{ session?: unknown; alive?: unknown; presence?: { lastSeenAgeSec?: unknown } }> }
      const live = new Set<string>()
      for (const a of doc.agents ?? []) {
        const age = a?.presence?.lastSeenAgeSec
        if (a && a.alive === true && typeof a.session === 'string' && a.session &&
            typeof age === 'number' && age <= FLEET_STATUS_MAX_PRESENCE_AGE_SEC) live.add(a.session)
      }
      snap = { at: now(), live }
      lastErr = null
      return null
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Прежний слепок не стираем: он сам состарится и перестанет быть опорой.
      if (msg !== lastErr) opts.onError?.(msg)
      lastErr = msg
      return msg
    }
  }

  return {
    isSessionAlive(sessionId: string) {
      if (!snap || now() - snap.at > FLEET_STATUS_MAX_SNAPSHOT_AGE_MS) return undefined
      return snap.live.has(sessionId) ? true : undefined
    },
    refresh,
    start() {
      if (timer || !opts.config.url) return
      void refresh()
      timer = setInterval(() => { void refresh() }, opts.pollMs ?? FLEET_STATUS_POLL_MS)
      timer.unref?.()
    },
    stop() { if (timer) { clearInterval(timer); timer = null } },
  }
}

/** Сначала сетевой слепок, потом локальный файл: «жива» от любого из них; иначе «не знаю». */
export function firstAlive(
  ...sources: Array<(sessionId: string) => boolean | undefined>
): (sessionId: string) => boolean | undefined {
  return (sessionId) => {
    for (const s of sources) { if (s(sessionId) === true) return true }
    return undefined
  }
}
