import { describe, test, expect } from 'bun:test'
import { buildReport, classify, costOf, formatReport, type RegistryPrices } from '../src/provider-turns.js'
import { newRecord, type DumpRecord } from '../src/provider-dump.js'

const PRICES: RegistryPrices = { source: 'тест', date: '2026-10-15', perMtok: { in: 0.15, out: 0.6, cache_read: 0.003 } }

function rec(sid: string, minute: number, input: number, cacheRead: number, over: Partial<DumpRecord> = {}): DumpRecord {
  const r = newRecord({ door: 'proxy:opencode-go', provider: 'opencode-go', call_kind: 'real' })
  r.ts = new Date(Date.UTC(2026, 9, 15, 12, minute, 0)).toISOString()
  r.session_id = sid
  r.org_id = 'org-x'
  r.response.status = 200
  r.usage_norm = { input, output: 100, reasoning: null, cache_read: cacheRead, cache_write: null, cache_write_1h: null }
  r.timing.total_ms = 1000
  return Object.assign(r, over)
}

describe('classify', () => {
  test('первый ход — не холодный', () => expect(classify(true, 1000, 0).cls).toBe('first'))
  test('<20% — холодный, >=90% — тёплый, между — смешанный', () => {
    expect(classify(false, 1000, 100).cls).toBe('cold')
    expect(classify(false, 1000, 950).cls).toBe('warm')
    expect(classify(false, 1000, 500).cls).toBe('mixed')
  })
  test('нет usage — unknown, а не холодный', () => {
    expect(classify(false, null, null).cls).toBe('unknown')
    expect(classify(false, 0, 0).cls).toBe('unknown')
  })
})

describe('buildReport', () => {
  test('пауза считается от конца прошлого хода; холодный после долгой паузы', () => {
    const rep = buildReport([
      rec('s1', 0, 100_000, 0),          // первый
      rec('s1', 2, 100_000, 99_000),     // тёплый, пауза ~2 мин
      rec('s1', 62, 100_000, 1_000),     // холодный, пауза ~60 мин
    ], PRICES)
    expect(rep.byClass).toMatchObject({ first: 1, warm: 1, cold: 1 })
    const t = rep.turns
    expect(Math.round(t[1]!.idle_before_ms! / 60_000)).toBe(2)
    // старт хода в минуту 62, прошлый закончился в минуту 2 + 1 с → пауза чуть меньше 60 мин
    expect(t[2]!.idle_before_ms!).toBe(60 * 60_000 - 1000)
    const b = rep.gaps.find(g => g.label === '45–60 мин')!
    expect(b).toMatchObject({ turns: 1, cold: 1, coldShare: 1 })
  })
  test('отказы квоты, пробы и чужие вызовы ходами не считаются', () => {
    const rep = buildReport([
      rec('s1', 0, 100, 0),
      rec('s1', 1, 100, 0, { response: { ...rec('s1', 1, 1, 1).response, status: 429 } }),
      rec('s1', 2, 100, 0, { call_kind: 'probe' }),
    ])
    expect(rep.turns.length).toBe(1)
  })
  test('разговоры не смешиваются', () => {
    const rep = buildReport([rec('a', 0, 100, 0), rec('b', 1, 100, 0), rec('a', 5, 100, 99)])
    expect(rep.sessions).toBe(2)
    expect(rep.byClass.first).toBe(2)
    expect(rep.byClass.warm).toBe(1)
  })
  test('без цен денег не придумываем', () => {
    const rep = buildReport([rec('a', 0, 100, 0)])
    expect(rep.totalCostUsd).toBeNull()
    expect(formatReport(rep)).not.toContain('Деньги')
  })
  test('деньги: холодный дороже тёплого в десятки раз на тех же токенах', () => {
    const cold = costOf(1_000_000, 0, 0, PRICES)!
    const warm = costOf(1_000_000, 0, 1_000_000, PRICES)!
    expect(cold / warm).toBeCloseTo(50, 0)
  })
})
