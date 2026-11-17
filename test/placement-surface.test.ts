/**
 * Живое состояние регулятора для человека (слово фаундера 17.11.2026, TG 89220): что он ответил,
 * сколько у него наблюдений, подстроено ли усиление. Только чтение — на выбор не влияет.
 */
import { describe, test, expect } from 'bun:test'
import { PlacementController, parsePlacementControl } from '../src/placement-control.js'

const H = 3_600_000
const cfg = parsePlacementControl({ enabled: true })
// Срок окна НЕПОДВИЖЕН внутри окна (как в бою): ключ траектории регулятора включает срок, и срок,
// плывущий вместе со временем, каждый шаг начинал бы новую траекторию.
const RESET5 = Date.parse('2026-11-17T14:00:00Z'), RESET7 = Date.parse('2026-11-22T18:00:00Z')
const win = (util5: number, _now: number) => [
  { name: '5h', util: util5, resetAt: RESET5 },
  { name: 'week', util: 0.3, resetAt: RESET7 },
]

describe('PlacementController.snapshot', () => {
  test('пустой регулятор — пустой снимок, не падение', () => {
    expect(new PlacementController().snapshot(cfg)).toEqual([])
  })
  test('после шага: последний ответ, вес и «усиление не подстроено» названы', () => {
    const c = new PlacementController(), now = Date.parse('2026-11-17T10:00:00Z')
    c.weight(cfg, 'org-a', win(0.2, now), { 'anthropic/opus': 3 }, now, true)
    const [row] = c.snapshot(cfg) as any[]
    expect(row.org).toBe('org-a')
    expect(row.adaptTrusted).toBe(false)         // наблюдений меньше порога — множитель честно 1
    expect(row.thetaEstimate).toBeNull()
    expect(row.last.mode).toBe('balance')
    expect(typeof row.last.weight).toBe('number')
    expect(row.last.terms).toBeDefined()
  })
  test('набрались наблюдения — оценка θ показана числом', () => {
    const c = new PlacementController(), t0 = Date.parse('2026-11-17T10:00:00Z')
    for (let i = 0; i < 12; i++) {
      const now = t0 + i * 10 * 60_000
      c.weight(cfg, 'org-b', win(0.1 + 0.01 * i, now), { 'anthropic/opus': 4 }, now, true)
    }
    const [row] = c.snapshot(cfg) as any[]
    expect(row.observations).toBeGreaterThanOrEqual(cfg.adapt.minObservations)
    expect(row.adaptTrusted).toBe(true)
    expect(typeof row.thetaEstimate).toBe('number')
  })
  test('снимок ничего не меняет: два чтения подряд одинаковы', () => {
    const c = new PlacementController(), now = Date.parse('2026-11-17T10:00:00Z')
    c.weight(cfg, 'org-c', win(0.5, now), {}, now, false)
    expect(JSON.stringify(c.snapshot(cfg))).toBe(JSON.stringify(c.snapshot(cfg)))
  })
})
