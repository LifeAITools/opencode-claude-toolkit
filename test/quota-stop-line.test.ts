/**
 * Линия стены запаса — по времени до сброса (src/quota-stop-line.ts).
 *
 * Числа — замер 30.09.2026 по аккаунту 02b4bfd1: стена 0.95 в 16:39:25Z, сброс 17:40Z, за час
 * прогрев 44 сессий прочитал 87 483 344 токена кэша, записал 0, настоящих ходов 4 — счётчик
 * 0.95 → 0.97. Фаундер в тот день: «почему она так жёстко отрубает? … 98-99%, чтобы оставить для
 * keep alive».
 */
import { describe, expect, test } from 'bun:test'
import { KaSpendMeter, quotaStopLine } from '../src/quota-stop-line.js'

const RATES = { readTokensPerPoint: 44_000_000, writeTokensPerPoint: 493_672, outputTokensPerPoint: 75_278 }
const H = 3_600_000
const base = { floor: 0.95, ceiling: 0.98, lagMargin: 0.01 }

describe('линия сторожа запаса', () => {
  test('30.09: час до сброса, прогрев ~2 пункта в час — стена 0.97, а не 0.95', () => {
    const r = quotaStopLine({ ...base, resetInMs: 61 * 60_000, kaUtilPerHour: 0.02 })
    expect(r.line).toBeCloseTo(0.9697, 3)   // 1 − 0.0203 − 0.01
    expect(r.basis).toBe('measured')
    // Счётчик отдаёт сотые: 0.96 ещё проходит, 0.97 уже стена.
    expect(0.96 >= r.line).toBe(false)
    expect(0.97 >= r.line).toBe(true)
  })

  test('за три часа до сброса прогрев не прокормить — линия не опускается ниже прежней', () => {
    const r = quotaStopLine({ ...base, resetInMs: 3 * H, kaUtilPerHour: 0.02 })
    expect(r.line).toBe(0.95)
    expect(r.basis).toBe('floor:clamped')
  })

  test('за минуты до сброса — не выше верхней границы: край окна не отдаётся', () => {
    const r = quotaStopLine({ ...base, resetInMs: 5 * 60_000, kaUtilPerHour: 0.02 })
    expect(r.line).toBe(0.98)
    expect(r.basis).toBe('ceiling:clamped')
  })

  test('расход не измерен или сброс неизвестен — ровно прежний порог', () => {
    expect(quotaStopLine({ ...base, resetInMs: 30 * 60_000, kaUtilPerHour: null })).toMatchObject({ line: 0.95, basis: 'floor:unmeasured' })
    expect(quotaStopLine({ ...base, resetInMs: null, kaUtilPerHour: 0.02 })).toMatchObject({ line: 0.95, basis: 'floor:unmeasured' })
  })

  test('верхняя равна нижней — прежнее поведение одним числом', () => {
    expect(quotaStopLine({ floor: 0.95, ceiling: 0.95, lagMargin: 0.01, resetInMs: 60_000, kaUtilPerHour: 0.001 }).line).toBe(0.95)
  })
})

describe('расход прогрева по аккаунту', () => {
  test('час у стены 30.09: 87,5 млн чтения — около двух пунктов в час', () => {
    const m = new KaSpendMeter()
    const t0 = 1_000_000
    for (let i = 0; i < 266; i++) m.record('02b4bfd1', { atMs: t0 + i * (H / 266), read: 87_483_344 / 266, write: 0, output: 1 })
    const rate = m.utilPerHour('02b4bfd1', t0 + H, RATES)!
    expect(rate).toBeGreaterThan(0.019)
    expect(rate).toBeLessThan(0.021)
  })

  test('меньше получаса наблюдения — расход не называется', () => {
    const m = new KaSpendMeter()
    m.record('a', { atMs: 0, read: 50_000_000, write: 0, output: 0 })
    expect(m.utilPerHour('a', 10 * 60_000, RATES)).toBeNull()
  })

  test('старше часа не считается, чужой аккаунт — отдельно', () => {
    const m = new KaSpendMeter()
    m.record('a', { atMs: 0, read: 440_000_000, write: 0, output: 0 })     // 10 пунктов, но давно
    m.record('a', { atMs: 2 * H, read: 44_000_000, write: 0, output: 0 })  // 1 пункт за последний час
    m.record('b', { atMs: 2 * H, read: 440_000_000, write: 0, output: 0 })
    expect(m.utilPerHour('a', 2 * H + 1, RATES)).toBeCloseTo(0.01, 5)
    expect(m.utilPerHour(null, 2 * H, RATES)).toBeNull()
  })

  test('запись на прогреве (мёртвый префикс) весит как запись', () => {
    const m = new KaSpendMeter()
    m.record('a', { atMs: 0, read: 0, write: 493_672, output: 0 })
    m.record('a', { atMs: H, read: 0, write: 0, output: 0 })
    expect(m.utilPerHour('a', H, RATES)).toBeCloseTo(0.01, 5)
  })
})
