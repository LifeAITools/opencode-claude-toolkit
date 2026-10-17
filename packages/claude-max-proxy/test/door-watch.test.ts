/**
 * Дверь поставщика, которая стоит, отвечает и не пропускает НИЧЕГО, обязана сказать это вслух.
 *
 * 🔴 ЧЕМ КУПЛЕНО (17.10.2026, своим счётом). В этот день 33 часа молчал Anthropic: 1973
 * запроса за сутки, все отказы, ни одного успеха — и не заметил никто, потому что сломано
 * было то, чем никто не пользуется. Ровно та же форма, что у PROXY_WARMS_NOTHING.
 *
 * 🔴 И ЗДЕСЬ ЖЕ ПРОВЕРЯЕТСЯ ПОПРАВКА К СОБСТВЕННОЙ ПЕРВОЙ ВЕРСИИ (1.1.61). Она считала
 * провалом только 5xx и отказы без статуса, а 429 исключала как «не вину двери» — и ровно
 * поэтому НЕ ПОЙМАЛА БЫ сегодняшнюю беду, потому что та была на 429. Теперь считается доля
 * ПРОШЕДШИХ вызовов, а причина называется отдельно; ниже это закреплено испытанием, чтобы
 * правило не вернулось обратно.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { bus, emit } from '../src/event-bus.js'
import { startDoorWatch, doorWindows, _doorState } from '../src/door-watch.js'

let stop: (() => void) | null = null
let seen: any[] = []
let off: (() => void) | null = null

const CONFIGURED = { goRegistryPath: '/x/go-orgs.yaml', goTokensPath: '/x/.go-tokens.json' } as any
const UNCONFIGURED = { goRegistryPath: null, goTokensPath: null } as any

function arm(cfg: any) {
  seen = []
  off = bus.onKind('DOOR_PASSES_NOTHING' as never, (e: any) => seen.push(e))
  stop = startDoorWatch(cfg)
}

afterEach(() => {
  try { stop?.() } catch { /* уже остановлен */ }
  try { off?.() } catch { /* уже отписан */ }
  stop = null; off = null
})

// ── дверь Anthropic ─────────────────────────────────────────────
const aStart = () => emit({ level: 'info', kind: 'REAL_REQUEST_START', sessionId: 's' } as never)
const aOk = () => emit({ level: 'info', kind: 'REAL_REQUEST_COMPLETE', sessionId: 's' } as never)
const aBad = (status: number | null) =>
  emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId: 's', status, msg: 'rate_limit_error' } as never)

// ── дверь Go ────────────────────────────────────────────────────
const gStart = () => emit({ level: 'info', kind: 'GO_REQUEST', sessionId: 's', org: 'o' } as never)
const gOk = () => emit({ level: 'info', kind: 'GO_COMPLETE', sessionId: 's', org: 'o', status: 200 } as never)
const gBad = (status: number | null) =>
  emit({ level: 'error', kind: 'GO_ERROR', sessionId: 's', org: 'o', status, msg: 'upstream down' } as never)

describe('дверь Anthropic, не пропускающая ничего, зовёт человека', () => {
  test('🔴 все вызовы падают на 429 — тревога, и причина названа квотой, а не дверью', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { aStart(); aBad(429) }
    expect(seen.length).toBe(1)
    expect(seen[0].door).toBe('anthropic')
    expect(seen[0].dominant).toBe('quota')
    expect(seen[0].msg).toContain('квота')
  })

  test('отказы поставщика (5xx) — тревога с причиной «поставщик»', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { aStart(); aBad(529) }
    expect(seen.length).toBe(1)
    expect(seen[0].dominant).toBe('provider')
  })

  test('мало вызовов — молчим: на пяти ходах вывод делать не о чем', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 5; i++) { aStart(); aBad(429) }
    expect(seen.length).toBe(0)
  })

  test('смешанная нагрузка — молчим: живая дверь под чужой нагрузкой не сломана', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 30; i++) { aStart(); aOk() }
    for (let i = 0; i < 3; i++) { aStart(); aBad(429) }
    expect(seen.length).toBe(0)
  })

  test('повторная буря внутри окна охлаждения — по-прежнему одна тревога', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { aStart(); aBad(429) }
    for (let i = 0; i < 25; i++) { aStart(); aBad(429) }
    expect(seen.length).toBe(1)
  })
})

describe('дверь Go', () => {
  test('настроена и всё падает — тревога с её именем', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { gStart(); gBad(503) }
    expect(seen.length).toBe(1)
    expect(seen[0].door).toBe('go-door')
    expect(seen[0].dominant).toBe('provider')
  })

  test('🔴 ненастроенная дверь тревоги НЕ поднимает: это выбранное нами состояние, оно названо при запуске', () => {
    arm(UNCONFIGURED)
    for (let i = 0; i < 30; i++) { gStart(); gBad(503) }
    expect(seen.length).toBe(0)
  })

  test('все вызовы — отказы вызывающего: тревога, но причина названа ЕГО ошибкой, а не поломкой двери', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 30; i++) { gStart(); gBad(400) }
    expect(seen.length).toBe(1)
    expect(seen[0].dominant).toBe('client')
    expect(seen[0].msg).toContain('исправна')
  })

  test('дверь работает — молчим', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 25; i++) { gStart(); gOk() }
    expect(seen.length).toBe(0)
  })
})

describe('окно наблюдения для строки здоровья', () => {
  test('до подписки — null, а не ноль: «не мерили» ≠ «измерили ноль»', () => {
    expect(doorWindows()).toBe(null)
  })

  test('после подписки — по КАЖДОЙ двери, с причиной отказов', () => {
    arm(CONFIGURED)
    for (let i = 0; i < 7; i++) { aStart(); aOk() }
    aStart(); aBad(429)
    gStart(); gBad(503)
    const w = doorWindows()
    const a = w?.find(x => x.name === 'anthropic')
    const g = w?.find(x => x.name === 'go-door')
    expect(a?.requests).toBe(8)
    expect(a?.succeeded).toBe(7)
    expect(a?.failed).toBe(1)
    expect(a?.dominant).toBe('quota')
    expect(g?.requests).toBe(1)
    expect(g?.dominant).toBe('provider')
  })

  test('состояние для диагностики знает обе двери', () => {
    arm(CONFIGURED)
    expect(_doorState().map(d => d.name).sort()).toEqual(['anthropic', 'go-door'])
  })
})
