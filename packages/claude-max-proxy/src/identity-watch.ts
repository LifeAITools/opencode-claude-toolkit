/**
 * identity-watch — заметить, что прокси работает, но не греет НИЧЕГО.
 *
 * 🔴 ЗАЧЕМ, И ЭТО КУПЛЕНО ЧУЖИМ СЧЁТОМ (28.08.2026).
 *
 * У соседнего проекта прокси стоял на проде, отвечал на все запросы и был
 * совершенно бесполезен: строка здоровья показывала `sessions=0 liveKa=0
 * firesLastHour=0`. Причина не в нагрузке, а в том, что их клиент — обычный
 * Anthropic SDK, а не родной Claude Code, — не сообщал, чья это сессия. Прокси
 * такие запросы обслуживает честно, но подогрев не вооружает: ему нечем
 * связать следующий ход с предыдущим (см. REQUEST_UNIDENTIFIED в
 * proxy-client). Каждый ход менеджера приходил холодным и покупал тёплую копию
 * заново — при том что запись кэша стоит 1.25 от входа, а чтение 0.1.
 *
 * Владелец нашёл это САМ, спустя недели, разглядывая строку здоровья. Прокси
 * всё это время знал правду и молчал: событие есть, уровень info, журнал
 * никто не тайлит. Это ровно та форма дефекта, которую сегодня чинили дважды —
 * прибор, докладывающий в файл, о котором известно, что его не читают.
 *
 * Поэтому: если за окно почти все настоящие запросы пришли безымянными И ни
 * одна сессия не вооружена, человека зовут ОДИН раз и говорят, что именно
 * добавить в клиент. Порог намеренно высокий: смешанная нагрузка (родной CLI
 * плюс пара служебных вызовов) не должна поднимать тревогу — беда именно в
 * том, что не опознан ПОЧТИ ВЕСЬ поток.
 */

import { bus } from './event-bus.js'

/** Окно наблюдения — час: короче ловит утренние всплески, длиннее тупит. */
const WINDOW_MS = 60 * 60 * 1000
/** Меньше этого числа запросов за окно — говорить не о чем, слишком мало данных. */
const MIN_REQUESTS = 20
/** Доля безымянных, при которой прокси заведомо бесполезен. */
const MIN_SHARE = 0.9
/** Одна тревога в шесть часов: беда постоянная, будить каждый час незачем. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000

let starts: number[] = []
let unidentified: number[] = []
let armedSessions = 0
let lastAlertAt = 0

function prune(now: number): void {
  const cutoff = now - WINDOW_MS
  while (starts.length && starts[0]! < cutoff) starts.shift()
  while (unidentified.length && unidentified[0]! < cutoff) unidentified.shift()
}

/** Состояние для тестов и диагностики. */
export function _identityState(): { starts: number; unidentified: number; armed: number } {
  return { starts: starts.length, unidentified: unidentified.length, armed: armedSessions }
}

/**
 * Подписаться на шину. Возвращает функцию остановки (тесты и выключение).
 * `onAlert` — куда звать человека; по умолчанию событие на шину, которое
 * подхватывает local-alert.
 */
export function startIdentityWatch(): () => void {
  const offStart = bus.onKind('REAL_REQUEST_START', () => {
    const now = Date.now()
    starts.push(now)
    prune(now)
  })

  const offUnid = bus.onKind('REQUEST_UNIDENTIFIED' as never, () => {
    const now = Date.now()
    unidentified.push(now)
    prune(now)
    evaluate(now)
  })

  // Сколько сессий реально вооружено — берём из строки здоровья, чтобы не
  // держать вторую копию реестра. Ноль здесь и есть вторая половина условия:
  // безымянные запросы при живых сессиях — норма (разовая суммаризация),
  // безымянные при НУЛЕ сессий — прокси, который ничего не делает.
  const offBeat = bus.onKind('HEALTH_HEARTBEAT' as never, (e: any) => {
    armedSessions = Number(e?.sessions ?? 0)
  })

  return () => {
    try { offStart?.() } catch { /* already off */ }
    try { offUnid?.() } catch { /* already off */ }
    try { offBeat?.() } catch { /* already off */ }
    starts = []
    unidentified = []
    armedSessions = 0
    lastAlertAt = 0
  }
}

function evaluate(now: number): void {
  if (armedSessions > 0) return
  if (starts.length < MIN_REQUESTS) return
  const share = unidentified.length / starts.length
  if (share < MIN_SHARE) return
  if (lastAlertAt && now - lastAlertAt < COOLDOWN_MS) return
  lastAlertAt = now

  bus.emitEvent({
    level: 'error',
    kind: 'PROXY_WARMS_NOTHING',
    requests: starts.length,
    unidentifiedShare: Math.round(share * 100) / 100,
    windowMin: Math.round(WINDOW_MS / 60000),
    msg: `за час ${unidentified.length} из ${starts.length} запросов пришли без имени сессии и ни одна сессия не вооружена — `
      + 'подогрев не работает вовсе, каждый ход покупает кэш заново; клиент должен слать заголовок '
      + 'x-claude-code-session-id (устойчивый id разговора) либо metadata.user_id с session_id',
  } as never)
}
