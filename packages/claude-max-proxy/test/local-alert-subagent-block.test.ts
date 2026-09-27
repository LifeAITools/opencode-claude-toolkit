/**
 * Помощник (субагент), отбитый сторожем кэша, — НЕ повод звать человека.
 *
 * 🔴 ЗАМЕР, КУПИВШИЙ ЭТИ ТЕСТЫ (владелец телеграм-службы, 27.09.2026). Сессия
 * 4a635bf3 — помощник агента myfamily-quest (agentId a2e5b826614f73d58), ход
 * 52 387 токенов после 1 ч 48 мин простоя, пока главный поток работал на тёплом
 * кэше. Карточка ушла с одним номером сессии; сурфейс опознал процесс по клейму
 * как самого агента и предложил «перезапустить не спрашивая» — стереть живую
 * работу ради кэша помощника. Отказ помощника получает его родитель, у которого
 * ходы есть; через ~46 с всё пошло само.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { emit } from '../src/event-bus.js'
import { _setCardSender, type StuckCardAsk } from '../src/surface-card.js'
const { startLocalAlert, _setAlertDelivery, _stuckState, stuckSessionReport } = await import('../src/local-alert.js')

let stop: (() => void) | null = null
let fired: Array<{ subject: string; journalOnly: boolean }> = []
let cards: StuckCardAsk[] = []
const STATE = '/tmp/__test_blocked_subagent.json'

beforeEach(() => {
  try { require('node:fs').unlinkSync(STATE) } catch { /* нет — и хорошо */ }
  fired = []; cards = []
  _setAlertDelivery((subject, _body, journalOnly) => { fired.push({ subject, journalOnly: !!journalOnly }) })
  _setCardSender(async (ask) => { cards.push(ask); return { raised: true } })
  stop = startLocalAlert(undefined, { statePath: STATE })
  _stuckState.clear()
})
afterEach(() => {
  try { stop?.() } catch { /* already stopped */ }
  _setAlertDelivery(null)
  _setCardSender(null)
  _stuckState.clear()
})

function block(sessionId: string, agentId: string | null) {
  emit({
    level: 'error', kind: 'CACHE_REWRITE_BLOCKED', sessionId,
    rewriteClass: 'avoidable:ttl-expiry', spendKind: 'rewrite',
    predictedTokens: 52_387, idleMs: 6_469_065, consecutiveBlocks: 2, agentId,
  } as never)
}

describe('помощник у сторожа кэша', () => {
  test('карточки и всплывашки нет — только строка в журнале', async () => {
    block('s-helper', 'a2e5b826614f73d58')
    await Bun.sleep(0)
    expect(cards.length).toBe(0)
    expect(fired.length).toBe(1)
    expect(fired[0]!.journalOnly).toBe(true)
  })

  test('главный поток по-прежнему зовёт человека карточкой', async () => {
    block('s-main', null)
    await Bun.sleep(0)
    expect(cards.length).toBe(1)
  })

  test('отчёт называет помощника, а у главного потока поле пустое', () => {
    block('s-helper', 'a2e5b826614f73d58')
    block('s-main', null)
    expect(stuckSessionReport('s-helper')!.subagentId).toBe('a2e5b826614f73d58')
    expect(stuckSessionReport('s-main')!.subagentId).toBeNull()
  })

  test('напоминаний нет, а затихший помощник снимается с учёта', async () => {
    block('s-helper', 'a2e5b826614f73d58')
    await Bun.sleep(0)
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    expect(fired.length).toBe(0)
    expect(cards.length).toBe(0)
    expect(_stuckState.get('s-helper')).toBeDefined()
    _stuckState.sweep(Date.now() + 61 * 60_000)
    expect(_stuckState.get('s-helper')).toBeUndefined()
    expect(fired.every(f => f.journalOnly)).toBe(true)
  })
})
