/**
 * Прокси, который работает и не греет ничего, обязан сказать это вслух.
 *
 * 🔴 ЧЕМ КУПЛЕНО (28.08.2026, чужим счётом). У соседнего проекта прокси месяцами
 * стоял на проде, честно отвечал на запросы и был бесполезен: их клиент — обычный
 * Anthropic SDK — не сообщал, чья это сессия, поэтому подогрев не вооружался
 * никогда. Каждый ход менеджера покупал тёплый кэш заново, при том что запись
 * стоит 1.25 от входа, а чтение 0.1. Владелец нашёл это САМ, разглядывая строку
 * здоровья: sessions=0 liveKa=0 firesLastHour=0.
 *
 * Прокси всё это время ЗНАЛ — событие о безымянном запросе есть, — но говорил об
 * этом в журнал, который никто не читает. Здесь проверяется, что теперь он зовёт
 * человека, и ровно тогда, когда беда настоящая: почти весь поток безымянный И
 * ни одной вооружённой сессии. Смешанная нагрузка тревогу поднимать не смеет.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { bus, emit } from '../src/event-bus.js'
import { startIdentityWatch, identityWindow } from '../src/identity-watch.js'

let stop: (() => void) | null = null
let seen: any[] = []
let off: (() => void) | null = null

function arm() {
  seen = []
  off = bus.onKind('PROXY_WARMS_NOTHING' as never, (e: any) => seen.push(e))
  stop = startIdentityWatch()
}

afterEach(() => {
  try { stop?.() } catch { /* уже остановлен */ }
  try { off?.() } catch { /* уже отписан */ }
  stop = null; off = null
})

const start = () => emit({ level: 'info', kind: 'REAL_REQUEST_START', sessionId: 's' } as never)
const nameless = () => emit({ level: 'info', kind: 'REQUEST_UNIDENTIFIED', sessionId: 'anon' } as never)
const heartbeat = (sessions: number) => emit({ level: 'info', kind: 'HEALTH_HEARTBEAT', sessions } as never)

describe('прокси, который ничего не греет, зовёт человека', () => {
  test('весь поток безымянный и сессий нет — тревога, ровно одна', () => {
    arm()
    heartbeat(0)
    for (let i = 0; i < 25; i++) { start(); nameless() }
    expect(seen.length).toBe(1)
    expect(seen[0].msg).toContain('x-claude-code-session-id')
  })

  test('мало запросов — молчим: на пяти ходах вывод делать не о чем', () => {
    arm()
    heartbeat(0)
    for (let i = 0; i < 5; i++) { start(); nameless() }
    expect(seen.length).toBe(0)
  })

  test('есть вооружённые сессии — молчим, даже если часть запросов безымянна', () => {
    arm()
    heartbeat(7)
    for (let i = 0; i < 30; i++) { start(); nameless() }
    expect(seen.length).toBe(0)
  })

  test('смешанная нагрузка — молчим: беда в том, что безымянен ПОЧТИ ВЕСЬ поток', () => {
    arm()
    heartbeat(0)
    for (let i = 0; i < 30; i++) start()
    for (let i = 0; i < 12; i++) nameless()   // 40% — ниже порога
    expect(seen.length).toBe(0)
  })

  test('после остановки наблюдателя тревог нет', () => {
    arm()
    heartbeat(0)
    for (let i = 0; i < 25; i++) { start(); nameless() }
    expect(seen.length).toBe(1)
    stop?.()
    for (let i = 0; i < 25; i++) { start(); nameless() }
    expect(seen.length).toBe(1)
  })
})

/**
 * 🔴 ВТОРАЯ ПОЛОВИНА ТОЙ ЖЕ БЕДЫ, И КУПЛЕНА ОНА ТЕМ ЖЕ ЧУЖИМ СЧЁТОМ (29.08.2026).
 *
 * Тревога выше зовёт человека, когда поток безымянный. Но владелец соседнего
 * проекта смотрел не на тревогу, а на строку здоровья — и `sessions=0` соврал
 * нам ОБОИМ: мы прочитали его как факт о клиенте, а он был фактом о тишине,
 * через прокси за девять часов не прошло ни одного запроса. Число, означающее
 * два разных состояния, разбирается только вторым числом рядом.
 *
 * И третье состояние важнее обоих: «не измеряли». Оно обязано выглядеть иначе,
 * чем измеренный ноль, иначе двусмысленный ноль чинится вторым таким же.
 */
describe('окно наблюдения в строке здоровья', () => {
  test('слежка не подписана — null, то есть НЕ МЕРИЛИ, а не ноль', () => {
    expect(identityWindow()).toBeNull()
  })

  test('подписана, но запросов не было — ноль ИЗМЕРЕННЫЙ, а не отсутствие данных', () => {
    arm()
    const w = identityWindow()
    expect(w).not.toBeNull()
    expect(w!.requests).toBe(0)
    expect(w!.unidentified).toBe(0)
  })

  test('тишина и безымянный поток различимы по паре чисел', () => {
    arm()
    heartbeat(0)
    for (let i = 0; i < 25; i++) { start(); nameless() }
    const w = identityWindow()!
    expect(w.requests).toBe(25)
    expect(w.unidentified).toBe(25)
  })

  test('остановка возвращает состояние в «не мерили»', () => {
    arm()
    start()
    expect(identityWindow()).not.toBeNull()
    stop!(); stop = null
    expect(identityWindow()).toBeNull()
  })
})
