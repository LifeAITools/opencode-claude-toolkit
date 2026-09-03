/**
 * Агент, который встал у сторожа и ЗАМОЛЧАЛ, обязан продолжать звать человека.
 *
 * 🔴 ЗАМЕР, КУПИВШИЙ ЭТИ ТЕСТЫ, ПРИНЁС СОСЕД, А НЕ МЫ (03.09.2026). Владелец
 * побудок прошёл ГЛАЗАМИ по экранам флота и нашёл восемь агентов, стоящих у
 * сторожа мёртво: у каждого последнее событие — отказ, дальше пустая строка.
 * Самый давний молчал 6,7 суток. По журналу при этом всё выглядело исправно —
 * 70 честных тревог за восемь дней, каждая с именем сессии и командой.
 *
 * Причина: прежняя тревога звучит НА ОТКАЗ, то есть пока агент ещё стучится. По
 * тем же 70 записям у активных сессий 5–6 срабатываний подряд, а у сдавшихся
 * после второго отказа — ровно одно. Кто встал и замолчал, выпадал из поля
 * зрения совсем: новых отказов нет, а тишина вставшего неотличима от тишины
 * здорового.
 *
 * Поэтому здесь проверяется СОСТОЯНИЕ, а не событие.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { emit } from '../src/event-bus.js'
// Свой файл состояния на весь набор: иначе обход читает живые сессии машины и
// «сработало один раз» становится «сработало сколько-то».
process.env.PROXY_BLOCKED_STATE_PATH = '/tmp/__test_blocked_sessions.json'
const { startLocalAlert, _setAlertDelivery, _stuckState } = await import('../src/local-alert.js')

let stop: (() => void) | null = null
let fired: Array<{ subject: string; body: string }> = []
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

beforeEach(() => {
  try { require('node:fs').unlinkSync('/tmp/__test_blocked_sessions.json') } catch { /* нет — и хорошо */ }
  fired = []
  _stuckState.clear()
  _setAlertDelivery((subject, body) => { fired.push({ subject, body }) })
  stop = startLocalAlert()
  _stuckState.clear()          // startLocalAlert поднимает состояние с диска — начинаем с чистого
})
afterEach(() => {
  try { stop?.() } catch { /* already stopped */ }
  _setAlertDelivery(null)
  _stuckState.clear()
})

function block(sessionId: string, streak = 2) {
  emit({
    level: 'error', kind: 'CACHE_REWRITE_BLOCKED', sessionId,
    rewriteClass: 'avoidable:ttl-expiry', spendKind: 'rewrite',
    predictedTokens: 437_582, consecutiveBlocks: streak,
  } as never)
}

describe('тревога по состоянию, а не по событию', () => {
  test('замолчавший агент напоминает о себе снова — молчание не гасит тревогу', () => {
    block('s-quiet')
    fired = []                       // первое уведомление уже прозвучало на отказе
    _stuckState.sweep(Date.now() + 20 * 60_000)
    expect(fired.length).toBe(1)
    expect(fired[0].subject).toContain('стоит у сторожа кэша уже')
  })

  test('в напоминании назван СРОК — иначе человек не отличит минуту от недели', () => {
    block('s-old')
    const st = _stuckState.get('s-old')!
    st.since = Date.now() - 6.7 * DAY   // тот самый photo3d
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    expect(fired[0].subject).toContain('суток')
    expect(fired[0].subject).toMatch(/6[.,]\d суток/)
  })

  test('шаг напоминаний растёт — сутки стояния не дают сутки уведомлений', () => {
    block('s-step')
    const t0 = Date.now()
    fired = []
    _stuckState.sweep(t0 + 20 * 60_000)      // первый шаг: 15 мин — сработает
    const afterFirst = fired.length
    _stuckState.sweep(t0 + 25 * 60_000)      // следующий шаг час — ещё рано
    expect(fired.length).toBe(afterFirst)
    _stuckState.sweep(t0 + 2 * HOUR)         // час прошёл — снова зовёт
    expect(fired.length).toBe(afterFirst + 1)
  })

  test('агент ПОШЁЛ — снимается с учёта, напоминаний больше нет', () => {
    block('s-went')
    emit({ level: 'info', kind: 'REAL_REQUEST_COMPLETE', sessionId: 's-went' } as never)
    expect(_stuckState.get('s-went')).toBeUndefined()
    fired = []
    _stuckState.sweep(Date.now() + DAY)
    expect(fired.length).toBe(0)
  })

  test('процесса больше нет — о покойнике не напоминают', () => {
    block('s-dead')
    emit({ level: 'info', kind: 'SESSION_DEAD', sessionId: 's-dead', reason: 'pid_gone' } as never)
    expect(_stuckState.get('s-dead')).toBeUndefined()
    fired = []
    _stuckState.sweep(Date.now() + DAY)
    expect(fired.length).toBe(0)
  })

  test('повторный отказ не сбрасывает отсчёт — стоит она с ПЕРВОГО раза', () => {
    block('s-again')
    const since = _stuckState.get('s-again')!.since
    block('s-again', 3)
    expect(_stuckState.get('s-again')!.since).toBe(since)
  })

  test('в теле сказано главное: она больше НЕ ПЫТАЕТСЯ, и что с этим делать', () => {
    block('s-body')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    const b = fired[0].body
    expect(b).toContain('БОЛЬШЕ НЕ ПЫТАЕТСЯ')
    expect(b).toContain('context cache-rewrite-ok s-body --until-consumed')
    expect(b).toContain('437 582')     // цена хода, разрядами — для человека
  })
})
