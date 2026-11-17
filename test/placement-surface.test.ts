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

// ── 17.11.2026, слово фаундера TG 89257: пятичасовое — лишь сигнал «упрёмся или нет». Нагрузка
// регулятора считается по РАБОТАЮЩИМ сессиям, а не по закреплённым: стоячая держит кэш и почти не жжёт.
import { activeLoadByOrg } from '../src/placement-control.js'
describe('activeLoadByOrg', () => {
  const NOW = Date.parse('2026-11-17T13:00:00Z'), MIN = 60_000
  const pins = new Map<string, { orgId: string | null }>([
    ['a', { orgId: 'oel' }], ['b', { orgId: 'oel' }], ['c', { orgId: 'oel' }], ['d', { orgId: 'rel' }], ['e', { orgId: null }],
  ])
  const cls = (sid: string) => (sid === 'c' ? 'anthropic/sonnet' : 'anthropic/opus')
  test('стоячие не считаются: работали только a и d', () => {
    const turns = new Map([['a', NOW - 2 * MIN], ['b', NOW - 40 * MIN], ['c', NOW - 3 * 60 * MIN], ['d', NOW - 14 * MIN]])
    const r = activeLoadByOrg(pins, turns, cls, NOW, 15 * MIN)
    expect(r.get('oel')).toEqual({ 'anthropic/opus': 1 })
    expect(r.get('rel')).toEqual({ 'anthropic/opus': 1 })
  })
  test('без отметки хода — стоячая, а не работающая', () => {
    expect(activeLoadByOrg(pins, new Map(), cls, NOW, 15 * MIN).size).toBe(0)
  })
  test('класс модели сохраняется: Sonnet и Opus считаются раздельно', () => {
    const turns = new Map([['a', NOW - MIN], ['c', NOW - MIN]])
    expect(activeLoadByOrg(pins, turns, cls, NOW, 15 * MIN).get('oel')).toEqual({ 'anthropic/opus': 1, 'anthropic/sonnet': 1 })
  })
  test('закреплена без организации — не считается', () => {
    expect(activeLoadByOrg(pins, new Map([['e', NOW]]), cls, NOW, 15 * MIN).size).toBe(0)
  })
  test('граница: ровно на краю окна ещё работает, чуть дальше — нет', () => {
    const r1 = activeLoadByOrg(pins, new Map([['a', NOW - 15 * MIN]]), cls, NOW, 15 * MIN)
    const r2 = activeLoadByOrg(pins, new Map([['a', NOW - 15 * MIN - 1]]), cls, NOW, 15 * MIN)
    expect(r1.get('oel')).toEqual({ 'anthropic/opus': 1 })
    expect(r2.size).toBe(0)
  })
})

describe('PlacementController.snapshot: возраст записи', () => {
  test('свежий шаг — не устарел; через 30 минут — устарел, возраст назван числом', () => {
    const c = new PlacementController(), t0 = Date.parse('2026-11-17T10:00:00Z')
    c.weight(cfg, 'org-z', win(0.2, t0), {}, t0, true)
    const fresh = c.snapshot(cfg, t0 + 60_000)[0] as any
    const old = c.snapshot(cfg, t0 + 30 * 60_000)[0] as any
    expect(fresh.stale).toBe(false)
    expect(fresh.lastStepAgeSec).toBe(60)
    expect(old.stale).toBe(true)
    expect(old.lastStepAgeSec).toBe(1800)
  })
})

describe('activeLoadByOrg после перезапуска прокси', () => {
  test('восстановленные сессии без отметки настоящего хода не считаются работающими (иначе 94 сразу «работают»)', () => {
    const NOW = Date.parse('2026-11-17T16:00:00Z')
    const pins = new Map<string, { orgId: string }>()
    for (let i = 0; i < 94; i++) pins.set(`s${i}`, { orgId: i % 2 ? 'oel' : 'rel' })
    expect(activeLoadByOrg(pins, new Map(), () => 'anthropic/opus', NOW, 15 * 60_000).size).toBe(0)
  })
  test('после настоящего хода сессия сразу считается', () => {
    const NOW = Date.parse('2026-11-17T16:00:00Z')
    const pins = new Map([['s1', { orgId: 'oel' }]])
    const r = activeLoadByOrg(pins, new Map([['s1', NOW - 1000]]), () => 'anthropic/opus', NOW, 15 * 60_000)
    expect(r.get('oel')).toEqual({ 'anthropic/opus': 1 })
  })
})
