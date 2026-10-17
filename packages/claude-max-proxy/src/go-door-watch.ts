/**
 * go-door-watch — заметить, что дверь Go стоит и отвечает, но НИ ОДИН вызов через неё не проходит.
 *
 * 🔴 ЗАЧЕМ, И ЭТО КУПЛЕНО СВОИМ СЧЁТОМ (17.10.2026).
 *
 * В этот день дверь на сервере kiberos.ai читалась как готовая: модуль `go-door`
 * загружен, два маршрута на месте, контейнер здоров. А ходить по ней было нечем —
 * каждый вызов получал отказ, и узнавалось это ТОЛЬКО вызовом. Рядом, в тот же день,
 * ровно так же молчал Anthropic: 1973 запроса за сутки, все 429, ни одного успеха —
 * и это не заметил никто, потому что сломано было то, чем никто не пользуется, кроме
 * одного служебного клиента.
 *
 * Это та же форма, что и PROXY_WARMS_NOTHING у identity-watch: прибор знает правду и
 * докладывает её в файл, о котором известно, что его не читают. Поэтому здесь — то же
 * лекарство: если за окно почти ВСЕ вызовы двери провалились, об этом говорят один раз
 * и называют, сколько их было и чем именно они падали.
 *
 * 🔴 ЧТО СЧИТАЕТСЯ ПРОВАЛОМ ДВЕРИ, А ЧТО НЕТ. Дверь — прозрачный проход, и не всякий
 * отказ означает, что она не работает:
 *   • 4xx — это ошибка ВЫЗЫВАЮЩЕГО (неверная модель, не то тело, названная организация,
 *     которой нет) — дверь исправна, она честно передала отказ поставщика;
 *   • 429 — исчерпанная квота организации: дверь исправна, ходить некуда;
 *   • 5xx и отказы БЕЗ статуса (503 «не настроена», 502 «шлюз недоступен») — вот это
 *     дверь не работает: либо нечем ходить, либо некуда.
 * Поэтому доля считается только по последнему классу: иначе живая дверь под чужой
 * нагрузкой кричала бы «я сломана» на каждый неверный запрос клиента.
 *
 * 🔴 НЕНАСТРОЕННАЯ ДВЕРЬ ТРЕВОГИ НЕ ПОДНИМАЕТ, И ЭТО НАРОЧНО. «Не заданы пути» —
 * состояние, которое мы выбрали сами; оно уже названо при запуске (GO_DOOR_UNCONFIGURED)
 * и видно в /health полем `doors`. Будить про него каждый час — ровно то, из-за чего
 * тревоги перестают читать. Сторож молчит, пока дверь не настроена, и становится живым
 * в тот момент, когда по ней НАЧАЛИ ходить: тогда молчание — уже новость.
 */

import { bus } from './event-bus.js'
import { goDoorReadiness } from './modules/go-door.js'
import type { ProxyConfig } from './config.js'

/** Окно наблюдения — час: короче ловит всплески, длиннее тупит. */
const WINDOW_MS = 60 * 60 * 1000
/** Меньше этого числа вызовов за окно — говорить не о чем, слишком мало данных. */
const MIN_REQUESTS = 20
/** Доля провалов, при которой дверь заведомо не работает. */
const MIN_SHARE = 0.9
/** Одна тревога в шесть часов: беда постоянная, будить каждый час незачем. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000

let requests: number[] = []
let failures: number[] = []
/** Последний увиденный отказ — чтобы назвать, ЧЕМ падало, а не только сколько раз. */
let lastFailure: { status: number | null; msg: string | null } | null = null
let configured = false
let lastAlertAt = 0
/** Подписана ли слежка. Ноль у неподписанной — не «тишина», а «не мерили». */
let watching = false

function prune(now: number): void {
  const cutoff = now - WINDOW_MS
  while (requests.length && requests[0]! < cutoff) requests.shift()
  while (failures.length && failures[0]! < cutoff) failures.shift()
}

/** Провал ли это ДВЕРИ (а не ошибка вызывающего и не исчерпанная квота). */
function isDoorFailure(status: number | null | undefined): boolean {
  if (status === null || status === undefined) return true // 503 «не настроена» / 502 «шлюз недоступен»
  return status >= 500
}

/** Состояние для тестов и диагностики. */
export function _goDoorState(): { requests: number; failures: number; configured: boolean } {
  return { requests: requests.length, failures: failures.length, configured }
}

/**
 * Окно наблюдения ДЛЯ СТРОКИ ЗДОРОВЬЯ — сколько вызовов двери пришло за час и сколько
 * из них провалилось. Возвращает null, когда слежка не подписана: тогда полей НЕ БУДЕТ
 * ВОВСЕ — «не измеряли» обязано отличаться от «измерили ноль» (та же дисциплина, что у
 * identityWindow).
 */
export function goDoorWindow(): { requests: number; failures: number; windowMin: number } | null {
  if (!watching) return null
  prune(Date.now())
  return { requests: requests.length, failures: failures.length, windowMin: Math.round(WINDOW_MS / 60000) }
}

/**
 * Подписаться на шину. Возвращает функцию остановки (тесты и выключение).
 * Тревога уходит событием на шину — её подхватывает local-alert, как PROXY_WARMS_NOTHING.
 */
export function startGoDoorWatch(cfg: ProxyConfig): () => void {
  watching = true
  configured = goDoorReadiness(cfg).configured

  const offReq = bus.onKind('GO_REQUEST' as never, () => {
    const now = Date.now()
    requests.push(now)
    prune(now)
  })

  const offErr = bus.onKind('GO_ERROR' as never, (e: any) => {
    const now = Date.now()
    const status = typeof e?.status === 'number' ? e.status : null
    // Вызов уже посчитан по GO_REQUEST: дверь говорит его ДО обращения к поставщику,
    // а провал, который мы считаем (5xx / без статуса), приходит уже после него.
    // Поэтому здесь долю не пополняем — иначе один вызов считался бы дважды.
    if (!isDoorFailure(status)) return
    failures.push(now)
    lastFailure = { status, msg: typeof e?.msg === 'string' ? e.msg.slice(0, 200) : null }
    prune(now)
    evaluate(now)
  })

  return () => {
    try { offReq?.() } catch { /* already off */ }
    try { offErr?.() } catch { /* already off */ }
    requests = []
    failures = []
    lastFailure = null
    configured = false
    lastAlertAt = 0
    watching = false
  }
}

function evaluate(now: number): void {
  // Ненастроенная дверь — известное состояние, а не беда (см. шапку файла).
  if (!configured) return
  if (requests.length < MIN_REQUESTS) return
  const share = failures.length / requests.length
  if (share < MIN_SHARE) return
  if (lastAlertAt && now - lastAlertAt < COOLDOWN_MS) return
  lastAlertAt = now

  const why = lastFailure
    ? `последний отказ: ${lastFailure.status === null ? 'без статуса (503/502)' : `HTTP ${lastFailure.status}`}`
      + (lastFailure.msg ? ` — ${lastFailure.msg}` : '')
    : ''
  bus.emitEvent({
    level: 'error',
    kind: 'GO_DOOR_FAILING',
    requests: requests.length,
    failures: failures.length,
    failureShare: Math.round(share * 100) / 100,
    windowMin: Math.round(WINDOW_MS / 60000),
    msg: `за час ${failures.length} из ${requests.length} вызовов двери Go провалились — `
      + 'ходить по двери нечем или некуда; клиенты получают отказ на каждый вызов'
      + (why ? `; ${why}` : ''),
  } as never)
}
