/**
 * Цена вызова в ответе двери: ставим `usage.cost = opencode.list_cost`, а если цены нет —
 * убираем ключ (никогда не оставляем ноль, который читается как «бесплатно»).
 *
 * Полюс из живого: 02.11.2026 дверь отдавала `cost: 0` при `list_cost: 5.25e-06`, и LiteLLM
 * брал ноль как есть — из-за этого у ВСЕГО Go-трафика был `spend=0` и не росли лимиты.
 */

import { describe, expect, test } from 'bun:test'
import { listCostOf, withCostInBody, withCostInSse } from './go-usage-cost.js'

const body = (cost: number | undefined, list: number | undefined) => {
  const usage: Record<string, unknown> = { prompt_tokens: 35, completion_tokens: 8 }
  if (cost !== undefined) usage.cost = cost
  if (list !== undefined) usage.opencode = { billing_source: 'go', list_cost: list }
  return JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion', usage })
}

describe('цена вызова в теле ответа', () => {
  test('ноль ЗАМЕНЯЕТСЯ настоящей ценой (это и был дефект)', () => {
    const out = JSON.parse(withCostInBody(body(0, 5.25e-6)))
    expect(out.usage.cost).toBe(5.25e-6)
  })

  test('цены нет — ключ cost УБИРАЕТСЯ, а не остаётся нулём', () => {
    const out = JSON.parse(withCostInBody(body(0, undefined)))
    expect('cost' in out.usage).toBe(false)
  })

  test('ноль без цены у не-usage объекта не трогаем (нечего править)', () => {
    const t = JSON.stringify({ id: 'x', other: { cost: 0 } })
    expect(withCostInBody(t)).toBe(t)
  })

  test('уже правильная цена — текст не переписывается', () => {
    const t = body(5.25e-6, 5.25e-6)
    expect(withCostInBody(t)).toBe(t)
  })

  test('не-JSON (обрезанный поток) — возврат как есть', () => {
    expect(withCostInBody('data: {"usage":')).toBe('data: {"usage":')
  })
})

describe('цена вызова в SSE-потоке', () => {
  test('строка с usage переписывается, остальные не трогаются', () => {
    const chunk = `data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: ${body(0, 4e-6)}\n\n`
    const { out, rest } = withCostInSse(chunk)
    expect(rest).toBe('')
    expect(out).toContain('"content":"a"')
    expect(out).toContain(`"cost":${4e-6}`)
  })

  test('недописанный хвост придерживается до следующего куска', () => {
    const first = 'data: {"usage":{"prompt_tokens":1,"cost":0,"opencode":{"list_cost":2e-6'
    const { out, rest } = withCostInSse(first)
    expect(out).toBe('')
    expect(rest).toBe(first)
    const { out: out2, rest: rest2 } = withCostInSse(rest + '}}}\n\n')
    expect(rest2).toBe('')
    expect(out2).toContain(`"cost":${2e-6}`)
  })

  test('[DONE] и обычные строки проходят байт в байт', () => {
    const chunk = 'data: [DONE]\n\nevent: ping\n\n'
    const { out, rest } = withCostInSse(chunk)
    expect(out).toBe(chunk)
    expect(rest).toBe('')
  })
})

describe('listCostOf', () => {
  test('число — берём; отсутствие и мусор — null, а не ноль', () => {
    expect(listCostOf({ opencode: { list_cost: 3e-6 } })).toBe(3e-6)
    expect(listCostOf({ opencode: {} })).toBeNull()
    expect(listCostOf({})).toBeNull()
    expect(listCostOf(null)).toBeNull()
    expect(listCostOf({ opencode: { list_cost: 'x' } })).toBeNull()
  })
})
