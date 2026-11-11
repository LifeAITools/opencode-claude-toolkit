/**
 * Расход в реальном времени — испытания.
 *
 * Слово фаундера 11.11.2026: «у нас через прокси проходит куча запросов… можем в реальном
 * времени писать журнал и понимать решение на базе записанного». Пять минут — шаг ОПРОСА
 * квоты у поставщика; токены каждого вызова дверь видит сама, сразу.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  compactSpend, fractionPerToken, realtimeFractionPerHour, spendTokensOfUsage, tokensInWindow, tokensPerHour,
} from './spend-ledger.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const MIN = 60_000

describe('скользящее окно токенов', () => {
  test('токены в окне считаются по времени, а не по порядку записей', () => {
    const e = [{ at: NOW - 30 * MIN, tokens: 100 }, { at: NOW - 9 * MIN, tokens: 200 }, { at: NOW - 1 * MIN, tokens: 300 }]
    expect(tokensInWindow(e, NOW, 10 * MIN)).toBe(500)
    expect(tokensInWindow(e, NOW, 60 * MIN)).toBe(600)
  })

  test('нет записей — это НЕ ноль расхода, а «не измерено»', () => {
    expect(tokensPerHour([], NOW, 10 * MIN)).toBeNull()
  })

  test('токены в час: сумма за окно / длина окна', () => {
    const e = [{ at: NOW - 5 * MIN, tokens: 50_000 }]
    expect(tokensPerHour(e, NOW, 10 * MIN)).toBeCloseTo(300_000, 6)
  })

  test('старое отбрасывается и не тянет окно назад', () => {
    const e = [{ at: NOW - 90 * MIN, tokens: 999 }, { at: NOW - 5 * MIN, tokens: 10 }]
    expect(compactSpend(e, NOW).length).toBe(1)
  })

  test('токены вызова = input + output, кэш-чтение уже внутри input', () => {
    expect(spendTokensOfUsage({ input: 1000, output: 200 })).toBe(1200)
    expect(spendTokensOfUsage({ input: null, output: 300 })).toBe(300)
    expect(spendTokensOfUsage({})).toBeNull()
  })
})

describe('проставка «доля окна на токен»', () => {
  test('доля и токены за один промежуток → курс', () => {
    // 0.30 доли окна на 400 000 токенов/час = 7.5e-7 доли на токен.
    expect(fractionPerToken(0.30, 400_000)).toBeCloseTo(7.5e-7, 12)
  })

  test('нет одного из чисел — курс не выдумывается', () => {
    expect(fractionPerToken(null, 100)).toBeNull()
    expect(fractionPerToken(0.2, null)).toBeNull()
    expect(fractionPerToken(0.2, 0)).toBeNull()
    expect(fractionPerToken(Number.NaN, 100)).toBeNull()
  })

  test('реальная доля в час = токены × курс; без курса — null', () => {
    expect(realtimeFractionPerHour(1_800_000, 7.5e-7)).toBeCloseTo(1.35, 9)
    expect(realtimeFractionPerHour(null, 7.5e-7)).toBeNull()
    expect(realtimeFractionPerHour(1_000_000, null)).toBeNull()
    expect(realtimeFractionPerHour(0, 7.5e-7)).toBeNull()
  })
})
