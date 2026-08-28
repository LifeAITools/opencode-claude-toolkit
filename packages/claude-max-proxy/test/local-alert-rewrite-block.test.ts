/**
 * Сессия, остановленная сторожем перезаписи кэша, обязана поднять человека —
 * потому что сама она этого сделать не может.
 *
 * 🔴 ЗАМЕР, КУПИВШИЙ ЭТИ ТЕСТЫ (28.08.2026, ~/.claude-local/claude-max-proxy.jsonl,
 * окно 25.08T15:10Z–28.08T12:41Z). Сторож остановил 71 ход у 10 сессий; 61 отказ
 * был вторым и далее подряд. Девять сессий из десяти после своего последнего
 * отказа не сделали НИ ОДНОГО успешного запроса: ddcd5f88 билась 29 раз за 22.5
 * минуты, 4304d202 возвращалась 11 раз за 28 часов, d91694bb — 6 раз за 30 часов
 * с ходом в 1.32 млн токенов. Файл согласий за всё окно держит одно разрешение,
 * и оно не для них.
 *
 * Корень терминальности: отказ уходит как HTTP 400 ДО того, как ход дойдёт до
 * модели, поэтому заблокированный агент физически не может выполнить названную
 * ему же команду согласия — её набирает человек. У сессии, поднятой побудкой,
 * человека рядом нет по определению, и она умирает молча: SESSION_STUCK её тоже
 * не видит, потому что считает только отказы с числовым статусом из
 * REAL_REQUEST_ERROR, а блок сторожа этого события не порождает вовсе.
 *
 * Отсюда два требования, которые здесь и проверяются: первый отказ — это вопрос,
 * на который вызывающий ещё может ответить сам, поэтому он молчит; второй подряд
 * означает стену, и вот тогда человека зовут — ОДИН раз на сессию за окно, иначе
 * 29 отказов дадут 29 уведомлений и следующее будет выключено вместе с нужным.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { emit } from '../src/event-bus.js'
import { startLocalAlert, _setAlertDelivery } from '../src/local-alert.js'

let stop: (() => void) | null = null
let fired: Array<{ subject: string; body: string }> = []

function arm() {
  fired = []
  _setAlertDelivery((subject, body) => { fired.push({ subject, body }) })
  stop = startLocalAlert()
}

afterEach(() => {
  try { stop?.() } catch { /* already stopped */ }
  stop = null
  _setAlertDelivery(null)
})

const SID = '34842111-9bc1-46e5-87ee-89e182669c62'

const block = (over: Record<string, unknown> = {}) => emit({
  level: 'error',
  kind: 'CACHE_REWRITE_BLOCKED',
  sessionId: SID,
  rewriteClass: 'avoidable:ttl-expiry',
  spendKind: 'rewrite',
  predictedTokens: 352954,
  consecutiveBlocks: 2,
  ...over,
} as never)

describe('сторож перезаписи кэша зовёт человека', () => {
  test('первый отказ молчит — на него вызывающий ещё может ответить сам', () => {
    arm()
    block({ consecutiveBlocks: 1 })
    expect(fired.length).toBe(0)
  })

  test('второй отказ подряд поднимает человека', () => {
    arm()
    block({ consecutiveBlocks: 2 })
    expect(fired.length).toBe(1)
  })

  test('в тревоге стоит ПОЛНЫЙ номер сессии и готовая команда согласия', () => {
    arm()
    block()
    const { body } = fired[0]!
    // Обрезанный номер нельзя ни найти, ни подставить в команду.
    expect(body).toContain(SID)
    expect(body).toContain(`context cache-rewrite-ok ${SID}`)
    // Цена хода — то, ради чего человека и спрашивают.
    expect(body).toContain('352 954')
  })

  test('причина названа словами, а не именем класса', () => {
    arm()
    block({ rewriteClass: 'avoidable:ttl-expiry' })
    expect(fired[0]!.body).toContain('кэш остыл')
    stop?.(); arm()
    block({ rewriteClass: 'expected:cold-start', spendKind: 'first-write' })
    expect(fired[0]!.body).toContain('первая запись')
    stop?.(); arm()
    block({ rewriteClass: 'anomalous:org-switch' })
    expect(fired[0]!.body).toContain('сменился аккаунт')
  })

  test('29 отказов подряд дают ОДНО уведомление, а не 29', () => {
    arm()
    for (let i = 2; i <= 30; i++) block({ consecutiveBlocks: i })
    expect(fired.length).toBe(1)
  })

  test('другая сессия — своя тревога: молчание про неё было бы потерей', () => {
    arm()
    block()
    block({ sessionId: 'd91694bb-9643-461c-ac5d-8cafdef7f512', predictedTokens: 1324745 })
    expect(fired.length).toBe(2)
    expect(fired[1]!.body).toContain('d91694bb-9643-461c-ac5d-8cafdef7f512')
  })

  test('после остановки наблюдателя тревоги не идут, и счёт сессий сброшен', () => {
    arm()
    block()
    expect(fired.length).toBe(1)
    stop?.()
    block({ consecutiveBlocks: 3 })
    expect(fired.length).toBe(1)
    // Заново поднятый наблюдатель не помнит прежнего окна тишины —
    // иначе перезапуск службы молча съел бы первую тревогу.
    arm()
    block()
    expect(fired.length).toBe(1)
  })
})
