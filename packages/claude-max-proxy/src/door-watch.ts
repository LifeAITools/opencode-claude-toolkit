/**
 * door-watch — заметить, что дверь поставщика СТОИТ, ОТВЕЧАЕТ и не пропускает НИЧЕГО.
 *
 * 🔴 ЗАЧЕМ, И ЭТО КУПЛЕНО СВОИМ СЧЁТОМ (17.10.2026).
 *
 * В этот день рядом со мной 33 часа молчал Anthropic: 1973 запроса за сутки, все отказы,
 * НИ ОДНОГО успеха — и не заметил никто, потому что сломано было то, чем никто не
 * пользуется, кроме одного служебного клиента. В тот же день дверь Go на сервере читалась
 * как готовая (модуль загружен, маршруты на месте, контейнер здоров), а ходить по ней было
 * нечем. Обе беды — одна форма: прибор знает правду и говорит её в файл, о котором известно,
 * что его не читают. Ровно та же форма, что у PROXY_WARMS_NOTHING (identity-watch), и
 * лекарство то же: если за окно почти НИ ОДИН вызов не прошёл, об этом говорят один раз.
 *
 * 🔴 ПОЧЕМУ СЧИТАЕТСЯ ДОЛЯ УСПЕХА, А НЕ «ОШИБКИ ДВЕРИ». Первая версия этого сторожа (1.1.61)
 * считала провалом только 5xx и отказы без статуса, а 4xx и 429 исключала — рассуждение было
 * «дверь прозрачна, она честно передаёт отказ поставщика». И ровно поэтому она НЕ поймала бы
 * сегодняшнюю беду: та была на 429. Для вопроса «дверь жива» неважно, ПОЧЕМУ ничего не
 * проходит, — важно, что не проходит ничего. Поэтому здесь считается доля ПРОШЕДШИХ вызовов,
 * а причина называется отдельно (`dominant`): исчерпанная квота, отказ поставщика или
 * ошибка вызывающего. Читатель получает и факт, и причину, и не может принять одно за другое.
 *
 * 🔴 НЕНАСТРОЕННАЯ ДВЕРЬ ТРЕВОГИ НЕ ПОДНИМАЕТ, И ЭТО НАРОЧНО. «Не заданы пути» — состояние,
 * которое мы выбрали сами; оно уже названо при запуске (GO_DOOR_UNCONFIGURED) и видно в
 * /health полем `doors`. Будить про него каждый час — ровно то, из-за чего тревоги перестают
 * читать. Сторож молчит, пока дверь не настроена, и становится живым в тот момент, когда по
 * ней НАЧАЛИ ходить: тогда молчание — уже новость.
 */

import { bus } from './event-bus.js'
import type { EventKind } from './event-bus.js'
import { goDoorReadiness } from './modules/go-door.js'
import type { ProxyConfig } from './config.js'

/** Окно наблюдения — час: короче ловит всплески, длиннее тупит. */
const WINDOW_MS = 60 * 60 * 1000
/** Меньше этого числа вызовов за окно — говорить не о чем, слишком мало данных. */
const MIN_REQUESTS = 20
/** Доля ПРОШЕДШИХ, ниже которой дверь заведомо не работает. */
const MIN_OK_SHARE = 0.1
/** Одна тревога в шесть часов: беда постоянная, будить каждый час незачем. */
const COOLDOWN_MS = 6 * 60 * 60 * 1000

/** Почему не проходит: имена классов, а не числа — читателю нужен смысл. */
export type FailureClass = 'provider' | 'quota' | 'client' | 'unknown'

function classOf(status: number | null): FailureClass {
  if (status === null) return 'provider' // 503 «не настроена» / 502 «шлюз недоступен»
  if (status >= 500) return 'provider'
  if (status === 429) return 'quota'
  if (status >= 400) return 'client'
  return 'unknown'
}

interface DoorState {
  spec: DoorSpec
  starts: number[]
  ok: number[]
  bad: Array<{ at: number; cls: FailureClass; status: number | null; msg: string | null }>
  lastAlertAt: number
}

/** Одна дверь: чем начинается вызов, чем он кончается и чем он падает. */
export interface DoorSpec {
  name: string
  start: EventKind
  complete: EventKind
  error: EventKind
}

export interface DoorWindow {
  name: string
  requests: number
  succeeded: number
  failed: number
  /** Почему не проходит — по большинству отказов за окно. null, когда отказов не было. */
  dominant: FailureClass | null
  windowMin: number
}

const doors: DoorState[] = []
/** Предварительное условие двери Go: пока пути не заданы — тревоги нет (см. шапку файла). */
let goConfigured = false
let watching = false

function prune(d: DoorState, now: number): void {
  const cutoff = now - WINDOW_MS
  while (d.starts.length && d.starts[0]! < cutoff) d.starts.shift()
  while (d.ok.length && d.ok[0]! < cutoff) d.ok.shift()
  while (d.bad.length && d.bad[0]!.at < cutoff) d.bad.shift()
}

function dominantOf(d: DoorState): FailureClass | null {
  if (!d.bad.length) return null
  const c: Record<string, number> = {}
  for (const b of d.bad) c[b.cls] = (c[b.cls] ?? 0) + 1
  return (Object.entries(c).sort((a, b) => b[1] - a[1])[0]![0]) as FailureClass
}

/** Состояние для тестов и диагностики. */
export function _doorState(): Array<{ name: string; requests: number; ok: number; bad: number }> {
  return doors.map(d => ({ name: d.spec.name, requests: d.starts.length, ok: d.ok.length, bad: d.bad.length }))
}

/**
 * Окно наблюдения ДЛЯ СТРОКИ ЗДОРОВЬЯ — по каждой двери. Возвращает null, когда слежка не
 * подписана: тогда полей НЕ БУДЕТ ВОВСЕ — «не измеряли» обязано отличаться от «измерили
 * ноль» (та же дисциплина, что у identityWindow).
 */
export function doorWindows(): DoorWindow[] | null {
  if (!watching) return null
  const now = Date.now()
  return doors.map(d => {
    prune(d, now)
    return {
      name: d.spec.name,
      requests: d.starts.length,
      succeeded: d.ok.length,
      failed: d.bad.length,
      dominant: dominantOf(d),
      windowMin: Math.round(WINDOW_MS / 60000),
    }
  })
}

/** Тревога поднимается только по двери Go, у которой есть предварительное условие. */
function enabled(d: DoorState): boolean {
  return d.spec.name === 'go-door' ? goConfigured : true
}

/**
 * Подписаться на шину. Возвращает функцию остановки (тесты и выключение).
 * Тревога уходит событием на шину — её подхватывает local-alert, как PROXY_WARMS_NOTHING.
 */
export function startDoorWatch(cfg: ProxyConfig): () => void {
  watching = true
  goConfigured = goDoorReadiness(cfg).configured
  doors.length = 0
  doors.push(
    { spec: { name: 'anthropic', start: 'REAL_REQUEST_START', complete: 'REAL_REQUEST_COMPLETE', error: 'REAL_REQUEST_ERROR' }, starts: [], ok: [], bad: [], lastAlertAt: 0 },
    { spec: { name: 'go-door', start: 'GO_REQUEST', complete: 'GO_COMPLETE', error: 'GO_ERROR' }, starts: [], ok: [], bad: [], lastAlertAt: 0 },
  )

  const offs = doors.map(d => [
    bus.onKind(d.spec.start as never, () => { const now = Date.now(); d.starts.push(now); prune(d, now) }),
    bus.onKind(d.spec.complete as never, () => { const now = Date.now(); d.ok.push(now); prune(d, now) }),
    bus.onKind(d.spec.error as never, (e: any) => {
      const now = Date.now()
      const status = typeof e?.status === 'number' ? e.status : null
      d.bad.push({ at: now, cls: classOf(status), status, msg: typeof e?.msg === 'string' ? e.msg.slice(0, 200) : null })
      prune(d, now)
      evaluate(d, now)
    }),
  ])

  return () => {
    for (const group of offs) for (const off of group) { try { off?.() } catch { /* already off */ } }
    doors.length = 0
    goConfigured = false
    watching = false
  }
}

function evaluate(d: DoorState, now: number): void {
  // Ненастроенная дверь — известное состояние, а не беда (см. шапку файла).
  if (!enabled(d)) return
  if (d.starts.length < MIN_REQUESTS) return
  const share = d.ok.length / d.starts.length
  if (share >= MIN_OK_SHARE) return
  if (d.lastAlertAt && now - d.lastAlertAt < COOLDOWN_MS) return
  d.lastAlertAt = now

  const cls = dominantOf(d)
  const why = {
    provider: 'отказы поставщика/транспорта (5xx или без статуса) — дверь не работает',
    quota: 'исчерпана квота организации (429) — ходить некуда',
    client: 'отказы вызывающего (4xx) — дверь исправна, но ни один запрос не принят',
    unknown: 'отказы без понятного класса',
  }[cls ?? 'unknown']
  const last = d.bad[d.bad.length - 1]
  bus.emitEvent({
    level: 'error',
    kind: 'DOOR_PASSES_NOTHING',
    door: d.spec.name,
    requests: d.starts.length,
    succeeded: d.ok.length,
    failed: d.bad.length,
    dominant: cls,
    windowMin: Math.round(WINDOW_MS / 60000),
    msg: `дверь ${d.spec.name}: за час ${d.ok.length} из ${d.starts.length} вызовов прошли — `
      + `дверь не пропускает почти ничего; причина: ${why}`
      + (last?.msg ? `; последний отказ: ${last.status === null ? 'без статуса' : `HTTP ${last.status}`} — ${last.msg}` : ''),
  } as never)
}
