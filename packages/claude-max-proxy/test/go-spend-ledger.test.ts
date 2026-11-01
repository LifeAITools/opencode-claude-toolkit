/**
 * Журнал денег двери Go: одна строка на вызов, деньги из `usage.opencode.list_cost`.
 *
 * Почему эти испытания вообще нужны: журнал становится ЕДИНСТВЕННЫМ источником расхода
 * для ступеней и биллинга (SpendLogs на стриме пишет `spend=0`). Ошибка здесь — не
 * «неточность отчёта», а неверные лимиты у живых людей.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendGoSpendRecord, extractDoorMoney, responseIdFromSseText, type GoSpendEntry,
} from '../src/go-spend-ledger.js'

const entry = (over: Partial<GoSpendEntry> = {}): GoSpendEntry => ({
  ts: '2026-11-01T22:00:00.000Z',
  responseId: 'chatcmpl-1',
  sessionId: 'ses_x',
  org: 'hello@lifeaitools.com',
  model: 'deepseek-v4.1-flash',
  input: 31,
  output: 1,
  cacheRead: 0,
  cacheWrite: null,
  listCost: 5.25e-6,
  allowance: 3.15e-6,
  callKind: 'real',
  ...over,
})

describe('extractDoorMoney — деньги берутся из opencode, а не из usage.cost', () => {
  test('живой ответ двери: list_cost и allowance на месте', () => {
    const usage = { total_tokens: 32, cost: 0, opencode: { billing_source: 'go', list_cost: 5.25e-6, allowance: 3.15e-6 } }
    expect(extractDoorMoney(usage)).toEqual({ listCost: 5.25e-6, allowance: 3.15e-6 })
  })

  test('нет блока opencode — NULL, а не ноль', () => {
    expect(extractDoorMoney({ total_tokens: 32, cost: 0 })).toEqual({ listCost: null, allowance: null })
  })

  test('null/мусор вместо usage — тоже NULL', () => {
    expect(extractDoorMoney(null)).toEqual({ listCost: null, allowance: null })
    expect(extractDoorMoney({ opencode: { list_cost: 'x' } })).toEqual({ listCost: null, allowance: null })
  })
})

describe('responseIdFromSseText — id нужен для сцепки с SpendLogs', () => {
  test('берёт id из первого data-чанка', () => {
    const sse = 'data: {"id":"chatcmpl-a9f3","choices":[]}\n\ndata: {"id":"chatcmpl-a9f3","choices":[]}\n\ndata: [DONE]\n'
    expect(responseIdFromSseText(sse)).toBe('chatcmpl-a9f3')
  })

  test('мусорные чанки пропускает, [DONE] не считает id', () => {
    expect(responseIdFromSseText('data: not-json\n\ndata: [DONE]\n')).toBeNull()
  })

  test('пустой поток — NULL (деньги без сцепки лучше не выдумывать)', () => {
    expect(responseIdFromSseText('')).toBeNull()
  })
})

describe('appendGoSpendRecord — дописывает строку и никогда не бросает', () => {
  test('строка ложится в файл целиком, JSON-ом', () => {
    const dir = mkdtempSync(join(tmpdir(), 'go-spend-'))
    const path = join(dir, 'ledger.jsonl')
    expect(appendGoSpendRecord(entry(), { path })).toBe(true)
    expect(appendGoSpendRecord(entry({ responseId: 'chatcmpl-2' }), { path })).toBe(true)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).listCost).toBe(5.25e-6)
    expect(JSON.parse(lines[1]!).responseId).toBe('chatcmpl-2')
  })

  test('недоступный путь — false, а не исключение (журнал не срывает ход)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'go-spend-'))
    const asFile = join(dir, 'not-a-dir')
    writeFileSync(asFile, 'x')
    expect(appendGoSpendRecord(entry(), { path: join(asFile, 'ledger.jsonl') })).toBe(false)
  })
})
