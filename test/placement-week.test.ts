/**
 * Недельная цель с ритмом дня (слово фаундера 17.11.2026, TG 89200/89208): успеть выбрать неделю к
 * сбросу, не упираясь в стену, и не оставлять на ночь то, что ночью не потратится.
 */
import { describe, test, expect } from 'bun:test'
import { activityMass, forecastWeek, activityWeightAt, WEEK_MS, type ActivityProfile } from '../src/placement-week.js'
import { planPlacement, type PlacementOrg } from '../src/placement.js'

const H = 3_600_000
const FLAT: ActivityProfile = { hourly: new Array(24).fill(1), weekday: new Array(7).fill(1) }
/** День — 1.5, ночь (00–08 UTC) — 0.25: ритм заметный, чтобы ловить ошибку знака. */
const DAYNIGHT: ActivityProfile = { hourly: Array.from({ length: 24 }, (_, h) => (h < 8 ? 0.25 : 1.5)), weekday: new Array(7).fill(1) }
const at = (iso: string) => Date.parse(iso)

describe('activityMass', () => {
  test('плоский профиль: масса равна часам', () => {
    expect(activityMass(0, 10 * H, FLAT)).toBeCloseTo(10, 6)
  })
  test('ночь весит меньше дня: 8 ночных часов против 8 дневных', () => {
    const night = activityMass(at('2026-11-17T00:00:00Z'), at('2026-11-17T08:00:00Z'), DAYNIGHT)
    const day = activityMass(at('2026-11-17T08:00:00Z'), at('2026-11-17T16:00:00Z'), DAYNIGHT)
    expect(night).toBeCloseTo(2, 3)
    expect(day).toBeCloseTo(12, 3)
  })
  test('обратный или нулевой интервал — 0', () => {
    expect(activityMass(5 * H, 5 * H, FLAT)).toBe(0)
    expect(activityMass(6 * H, 5 * H, FLAT)).toBe(0)
  })
})

describe('forecastWeek', () => {
  const reset = at('2026-11-22T18:00:00Z')
  test('нет измерения или срока — «не знаю», а не ноль', () => {
    expect(forecastWeek(null, reset, at('2026-11-17T12:00:00Z'), 0.99, FLAT)).toBeNull()
    expect(forecastWeek(0.3, null, at('2026-11-17T12:00:00Z'), 0.99, FLAT)).toBeNull()
  })
  test('сброс уже прошёл — считать нечего', () => {
    expect(forecastWeek(0.5, reset, reset + H, 0.99, FLAT)).toBeNull()
  })
  test('окно только началось — делить не на что', () => {
    expect(forecastWeek(0.01, reset, reset - WEEK_MS + 10 * 60_000, 0.99, FLAT)).toBeNull()
  })
  test('плоский профиль: ровный темп даёт линейный прогноз и нужду к цели', () => {
    const now = reset - WEEK_MS / 2   // середина окна
    const f = forecastWeek(0.4, reset, now, 0.99, FLAT)!
    expect(f.forecast).toBeCloseTo(0.8, 3)          // 0.4 за половину → 0.8 к сбросу
    expect(f.deficit).toBeCloseTo(0.19, 3)
    expect(f.need).toBeCloseTo(0.19 / 84, 4)
  })
  test('прогноз выше цели — недобора нет', () => {
    const f = forecastWeek(0.9, reset, reset - WEEK_MS / 2, 0.99, FLAT)!
    expect(f.forecast).toBeGreaterThan(0.99)
    expect(f.deficit).toBe(0)
    expect(f.need).toBe(0)
  })
  test('ночь до сброса удешевляет остаток: тот же util, но до сброса одна ночь — недобор больше, чем до сброса день', () => {
    // Одинаковая доля окна использована, одинаковое число часов до сброса (10 ч),
    // но у одной эти 10 часов — ночь+утро, у другой — день.
    const resetNight = at('2026-11-18T08:00:00Z')     // последние 10 ч — 22:00..08:00 UTC, в основном ночь
    const resetDay = at('2026-11-18T18:00:00Z')       // последние 10 ч — 08:00..18:00 UTC, день
    const fNight = forecastWeek(0.5, resetNight, resetNight - 10 * H, 0.99, DAYNIGHT)!
    const fDay = forecastWeek(0.5, resetDay, resetDay - 10 * H, 0.99, DAYNIGHT)!
    expect(fNight.remainingMass).toBeLessThan(fDay.remainingMass)
  })
})

describe('planPlacement: недельная нужда решает между равными', () => {
  const NOW = at('2026-11-17T10:00:00Z')
  const org = (name: string, util7: number, reset7: string): PlacementOrg => ({
    name, activeAgents: 3, weekGoal: true,
    windows: [
      { name: '5h', util: 0.05, resetAt: NOW + 4 * H },
      { name: 'week', util: util7, resetAt: at(reset7) },
    ],
  })
  test('кормим ту, у которой остаток больше при том же сроке: нужда выше', () => {
    // Обе без стены до сброса. У A недели израсходовано мало при том же сбросе — дефицит больше.
    const A = org('A', 0.30, '2026-11-19T20:00:00Z')
    const B = org('B', 0.60, '2026-11-19T20:00:00Z')
    const p = planPlacement([A, B], NOW, 's1')
    expect(p.org?.name).toBe('A')
    expect(p.ranked[0]!.weekNeed!).toBeGreaterThan(p.ranked[1]!.weekNeed!)
  })
  test('дальний сброс уходит «на последок»: у него рабочего времени много, нужда ниже', () => {
    // Одинаковый util недели; у A сброс через ~2 дня, у B через ~5.
    const A = org('A', 0.40, '2026-11-19T20:00:00Z')
    const B = org('B', 0.40, '2026-11-22T18:00:00Z')
    const p = planPlacement([A, B], NOW, 's2')
    expect(p.org?.name).toBe('A')
  })
  test('нет недельного окна — прежний порядок по сроку сброса, и это не падение', () => {
    const only5h = (name: string, resetH: number): PlacementOrg => ({
      name, activeAgents: 1, windows: [{ name: '5h', util: 0.1, resetAt: NOW + resetH * H }],
    })
    const p = planPlacement([only5h('far', 4), only5h('near', 1)], NOW, 's3')
    expect(p.org?.name).toBe('near')
    expect(p.ranked[0]!.weekNeed).toBeNull()
  })
  test('без weekGoal чужой маршрут (Go/OpenDesign) считает как раньше: нужда не считается', () => {
    const plain = (name: string): PlacementOrg => ({ name, activeAgents: 1, windows: [
      { name: '5h', util: 0.05, resetAt: NOW + 4 * H }, { name: 'week', util: 0.3, resetAt: at('2026-11-19T20:00:00Z') },
    ] })
    const p = planPlacement([plain('A'), plain('B')], NOW, 's5')
    expect(p.ranked[0]!.weekNeed).toBeNull()
    expect(p.ranked[0]!.weekForecast).toBeNull()
  })
  test('рельс «стена до сброса» важнее нужды: упирающаяся организация не получает приток из-за большой нужды', () => {
    const wall: PlacementOrg = { name: 'wall', activeAgents: 5, windows: [
      { name: '5h', util: 0.96, resetAt: NOW + 4 * H },
      { name: 'week', util: 0.2, resetAt: at('2026-11-22T18:00:00Z') },
    ] }
    const calm = org('calm', 0.6, '2026-11-19T20:00:00Z')
    const p = planPlacement([wall, calm], NOW, 's4')
    expect(p.org?.name).toBe('calm')
  })
})

describe('activityWeightAt', () => {
  test('вес — произведение часового и недельного', () => {
    const p: ActivityProfile = { hourly: new Array(24).fill(2), weekday: new Array(7).fill(3) }
    expect(activityWeightAt(at('2026-11-17T10:00:00Z'), p)).toBe(6)
  })
})
