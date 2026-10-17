/**
 * Дверь, которая стоит и отвечает, но не пропускает НИ ОДНОГО вызова, обязана сказать это вслух.
 *
 * 🔴 ЧЕМ КУПЛЕНО (17.10.2026, своим счётом). В этот день дверь на сервере читалась как
 * готовая — модуль загружен, маршруты на месте, контейнер здоров, — а ходить по ней было
 * нечем. Рядом ровно так же молчал Anthropic: 1973 запроса за сутки, все отказы, ни одного
 * успеха, и не заметил никто. Здесь проверяется, что теперь об этом говорят один раз, с
 * числом вызовов и с последним отказом в руках.
 *
 * И проверяется ГРАНИЦА: ошибка вызывающего (4xx) и исчерпанная квота (429) — не провал
 * двери. Дверь прозрачна, она честно передаёт отказ поставщика; кричать «я сломана» на
 * каждый неверный запрос клиента — это то, из-за чего тревоги перестают читать.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { bus, emit } from '../src/event-bus.js'
import { startGoDoorWatch, goDoorWindow, _goDoorState } from '../src/go-door-watch.js'

let stop: (() => void) | null = null
let seen: any[] = []
let off: (() => void) | null = null

const CONFIGURED = { goRegistryPath: '/x/go-orgs.yaml', goTokensPath: '/x/.go-tokens.json' } as any
const UNCONFIGURED = { goRegistryPath: null, goTokensPath: null } as any

function arm(cfg: any) {
  seen = []
  off = bus.onKind('GO_DOOR_FAILING' as never, (e: any) => seen.push(e))
  stop = startGoDoorWatch(cfg)
}

afterEach(() => {
  try { stop?.() } catch { /* уже остановлен */ }
  try { off?.() } catch { /* уже отписан */ }
  stop = null; off = null
})

const call = () => emit({ level: 'info', kind: 'GO_REQUEST', sessionId: 's', org: 'o' } as never)
const fail = (status: number | null) =>
  emit({ level: 'error', kind: 'GO_ERROR', sessionId: 's', org: 'o', status, msg: 'upstream down' } as never)

describe('дверь Go, которая не пропускает ничего, зовёт человека', () => {
  test('все вызовы провалились — тревога, ровно одна, и в ней есть число', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { call(); fail(503) }
    expect(seen.length).toBe(1)
    // Тревога поднимается на ПЕРЕСЕЧЕНИИ порога, а не в конце бури: 20 — это MIN_REQUESTS.
    expect(seen[0].msg).toContain('20 из 20')
    expect(seen[0].failureShare).toBe(1)
    expect(seen[0].msg).toContain('HTTP 503')
  })

  test('отказ БЕЗ статуса (503 «не настроена» / 502 «шлюз недоступен») тоже считается провалом', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { call(); fail(null) }
    expect(seen.length).toBe(1)
    expect(seen[0].msg).toContain('без статуса')
  })

  test('мало вызовов — молчим: на пяти ходах вывод делать не о чем', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 5; i++) { call(); fail(503) }
    expect(seen.length).toBe(0)
  })

  test('🔴 4xx и 429 — НЕ провал двери: она честно передала отказ поставщика', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 30; i++) { call(); fail(400) }
    for (let i = 0; i < 30; i++) { call(); fail(429) }
    expect(seen.length).toBe(0)
  })

  test('🔴 ненастроенная дверь тревоги НЕ поднимает: это выбранное нами состояние, оно названо при запуске', () => {
    arm(UNCONFIGURED)
    for (let i = 0; i < 30; i++) { call(); fail(503) }
    expect(seen.length).toBe(0)
  })

  test('смешанная нагрузка — молчим: живая дверь под чужой нагрузкой не сломана', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 30; i++) call()
    for (let i = 0; i < 5; i++) fail(503)
    expect(seen.length).toBe(0)
  })

  test('повторная буря внутри окна охлаждения — по-прежнему одна тревога', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { call(); fail(503) }
    for (let i = 0; i < 25; i++) { call(); fail(503) }
    expect(seen.length).toBe(1)
  })
})

describe('окно наблюдения для строки здоровья', () => {
  test('до подписки — null, а не ноль: «не мерили» ≠ «измерили ноль»', () => {
    expect(goDoorWindow()).toBe(null)
  })

  test('после подписки — числа вызовов и провалов', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 7; i++) call()
    fail(503)
    const w = goDoorWindow()
    expect(w?.requests).toBe(7)
    expect(w?.failures).toBe(1)
    expect(w?.windowMin).toBe(60)
  })

  test('состояние для диагностики отдаёт и признак «настроена»', () => {
    arm(UNCONFIGURED)
    expect(_goDoorState().configured).toBe(false)
  })
})
