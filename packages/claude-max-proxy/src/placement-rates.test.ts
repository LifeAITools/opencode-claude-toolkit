/**
 * Производная расхода квоты — испытания.
 *
 * Основание — слово фаундера 11.11.2026: «в моменте может быть, она ещё не занята, но если
 * мы сейчас опять у всех агентов на неё повесим, то через пять-десять минут она будет
 * самой занята». Средняя с начала окна этого не видит; разность двух замеров — видит.
 */
import { describe, expect, test } from 'bun:test'
import { parseRateSamples, recentRatesFromSamples } from './placement-rates.js'

const NOW = Date.parse('2026-11-11T12:00:00Z')
const MIN = 60_000

const line = (minutesAgo: number, orgs: Array<{ name: string; w: Record<string, number> }>, provider = 'open-design') =>
  JSON.stringify({
    ts: new Date(NOW - minutesAgo * MIN).toISOString(),
    ms: NOW - minutesAgo * MIN,
    provider,
    orgs: orgs.map(o => ({ name: o.name, windows: Object.entries(o.w).map(([window, util]) => ({ window, util })) })),
  })

describe('производная из ряда', () => {
  test('разность двух замеров → доля окна в час', () => {
    // 0.10 → 0.15 за 10 минут = 0.05 за 1/6 часа = 0.3/час.
    const text = [
      line(20, [{ name: 'a', w: { '5h': 0.10 } }]),
      line(10, [{ name: 'a', w: { '5h': 0.15 } }]),
    ].join('\n')
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW })
    expect(rates.get('a')?.['5h']).toBeCloseTo(0.3, 6)
  })

  test('сброс окна (util упал) — НЕ отрицательная скорость, а ноль', () => {
    const text = [
      line(20, [{ name: 'a', w: { '5h': 0.60 } }]),
      line(10, [{ name: 'a', w: { '5h': 0.05 } }]),
    ].join('\n')
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW })
    expect(rates.get('a')?.['5h']).toBe(0)
  })

  test('один замер — скорости нет (не выдумываем ноль)', () => {
    const text = line(10, [{ name: 'a', w: { '5h': 0.4 } }])
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW })
    expect(rates.has('a')).toBe(false)
  })

  test('замеры вне окна не учитываются — старый ряд не задаёт сегодняшний темп', () => {
    const text = [
      line(120, [{ name: 'a', w: { '5h': 0.10 } }]),
      line(10, [{ name: 'a', w: { '5h': 0.50 } }]),
    ].join('\n')
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW, windowMs: 30 * MIN })
    expect(rates.has('a')).toBe(false)
  })

  test('чужой провайдер не смешивается с нашим', () => {
    const text = [
      line(20, [{ name: 'a', w: { '5h': 0.10 } }], 'opencode-go'),
      line(10, [{ name: 'a', w: { '5h': 0.15 } }], 'opencode-go'),
    ].join('\n')
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW })
    expect(rates.has('a')).toBe(false)
  })

  test('битая строка не роняет ряд', () => {
    const text = ['{not json', line(20, [{ name: 'a', w: { '5h': 0.10 } }]), line(10, [{ name: 'a', w: { '5h': 0.20 } }])].join('\n')
    expect(parseRateSamples(text).length).toBe(2)
    expect(recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW }).get('a')?.['5h']).toBeCloseTo(0.6, 6)
  })

  test('окна считаются раздельно', () => {
    const text = [
      line(30, [{ name: 'a', w: { '5h': 0.10, week: 0.20 } }]),
      line(10, [{ name: 'a', w: { '5h': 0.20, week: 0.21 } }]),
    ].join('\n')
    const rates = recentRatesFromSamples(text, { provider: 'open-design', nowMs: NOW })
    expect(rates.get('a')?.['5h']).toBeCloseTo(0.3, 6)   // 0.10 за 1/3 часа
    expect(rates.get('a')?.week).toBeCloseTo(0.03, 6)    // 0.01 за 1/3 часа
  })
})
