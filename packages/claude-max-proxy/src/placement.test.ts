import { describe, expect, test } from 'bun:test'
import { assessOrg, planPlacement, placementInputs, NEAR_WALL_HOURS, type PlacementOrg } from './placement.js'

const H = 3_600_000
const NOW = Date.parse('2026-11-05T12:00:00.000Z')
const win = (name: string, util: number, resetsInHours: number) =>
  ({ name, util, resetAt: NOW + resetsInHours * H })

const org = (name: string, windows: PlacementOrg['windows'], activeAgents = 0, blockedReason?: string): PlacementOrg =>
  ({ name, windows, activeAgents, blockedReason })

describe('оценка организации: запас + динамика + маргинальная нагрузка', () => {
  test('окно, которое сбросится раньше стены, НЕ связывает — и не пугает', () => {
    // 5ч, прошло 4ч, израсходовано 0.5 → скорость 0.125/ч, до стены 4ч, сброс через 1ч.
    // Стена (4ч) позже сброса (1ч) → окно не связывает.
    const a = assessOrg(org('x', [win('5h', 0.5, 1)]), NOW)
    expect(a.score).toBe(Infinity)
    expect(a.verdict).toBe('place')
    expect(a.reason).toContain('не связывает')
  })

  test('связывающее окно называется с числом часов до стены', () => {
    // 5ч, прошло 1ч, израсходовано 0.5 → скорость 0.5/ч, до стены 1ч, сброс через 4ч → связывает.
    const a = assessOrg(org('x', [win('5h', 0.5, 4)]), NOW)
    expect(a.score).toBeCloseTo(1, 1)
    expect(a.binding.map(b => b.window)).toEqual(['5h'])
  })

  test('ПОСАДКА ЕЩЁ ОДНОГО АГЕНТА приближает стену пропорционально', () => {
    const solo = assessOrg(org('x', [win('5h', 0.5, 4)], 0), NOW)
    const crowded = assessOrg(org('x', [win('5h', 0.5, 4)], 3), NOW)
    expect(solo.score).toBeCloseTo(1, 1)
    // на трёх агентах четвёртый добавляет четверть скорости: 1ч × 3/4
    expect(crowded.score).toBeCloseTo(0.75, 2)
    expect(crowded.score).toBeLessThan(solo.score)
  })

  test('ВСПЛЕСК учитывается: текущая скорость перебивает среднюю', () => {
    // 5ч: прошло 1ч, занято 0.5 → средняя 0.5/ч, до стены 1ч.
    const calm = assessOrg(org('x', [win('5h', 0.5, 4)], 0), NOW)
    const burst = assessOrg({ ...org('x', [win('5h', 0.5, 4)], 0), recentRates: { '5h': 2 } }, NOW)
    expect(calm.score).toBeCloseTo(1, 1)
    expect(burst.score).toBeCloseTo(0.25, 2)
    expect(burst.reason).toContain('по текущей скорости')
  })

  test('спокойный ряд НЕ улучшает оценку — меньшая скорость не берётся', () => {
    const calm = assessOrg(org('x', [win('5h', 0.5, 4)], 0), NOW)
    const slow = assessOrg({ ...org('x', [win('5h', 0.5, 4)], 0), recentRates: { '5h': 0.01 } }, NOW)
    expect(slow.score).toBeCloseTo(calm.score, 5)
  })

  test('исчерпанное окно — стена, организация не кандидат', () => {
    const a = assessOrg(org('x', [win('month', 1, 100)]), NOW)
    expect(a.verdict).toBe('walled')
    expect(a.score).toBe(0)
  })

  test('запрещённая организация не оценивается числами', () => {
    const a = assessOrg(org('x', [win('5h', 0.1, 4)], 2, 'организация без подписки'), NOW)
    expect(a.verdict).toBe('walled')
    expect(a.reason).toContain('без подписки')
  })

  test('неизмеренный запас — null, а не «полный»', () => {
    const a = assessOrg(org('x', [{ name: '5h', util: null, resetAt: NOW + 4 * H }]), NOW)
    expect(a.worstHeadroom).toBeNull()
    expect(a.reason).toContain('не измерен')
  })

  test('короткое прошедшее время не даёт скорости — окно пропускается, а не выдумывается', () => {
    // Прошло 6 минут (< 15) — скорость неизвестна.
    const a = assessOrg(org('x', [win('5h', 0.9, 4.9)]), NOW)
    expect(a.score).toBe(Infinity)
  })
})

describe('куда посадить нового агента', () => {
  test('выбирает ту, где стена дальше ПОСЛЕ посадки, а не где просто меньше занято', () => {
    // A: 5ч почти пусто, но сброс далеко, скорость высокая → стена близко.
    // B: 5ч занято на 60%, но сброс через 30 минут → окно не связывает, стены нет.
    const plan = planPlacement([
      org('A', [win('5h', 0.5, 4)], 5),   // связывает, 1ч до стены, тесно
      org('B', [win('5h', 0.6, 0.5)], 1), // сбросится через полчаса
    ], NOW, 'ses_new')
    expect(plan.org?.name).toBe('B')
  })

  test('«avoid» берётся только когда свободных нет, и это названо', () => {
    const plan = planPlacement([
      org('A', [win('5h', 0.8, 4)], 2), // стена ~0.5ч → avoid
      org('B', [win('month', 1, 100)], 0), // walled
    ], NOW, 'ses_new')
    expect(plan.org?.name).toBe('A')
    expect(plan.org?.verdict as string).toBe('avoid')
    expect(plan.reason).toContain('свободных нет')
  })

  test('все упёрлись — org: null с причиной, а не первый попавшийся', () => {
    const plan = planPlacement([org('A', [win('5h', 1, 4)]), org('B', [win('month', 1, 9)])], NOW)
    expect(plan.org).toBeNull()
    expect(plan.reason).toContain('сажать некуда')
  })

  test('НЕИЗМЕРЕННАЯ организация не выходит вперёд измеренной (незнание ≠ лучший выбор)', () => {
    const plan = planPlacement([
      org('blind', [{ name: '5h', util: null, resetAt: null }]),
      org('live', [win('5h', 0.2, 4)]),
    ], NOW, 'ses_x')
    expect(plan.ranked[0].name).toBe('live')
    expect(plan.org?.name).toBe('live')
    const blind = plan.ranked.find(r => r.name === 'blind')!
    expect(blind.verdict).toBe('unknown')
  })

  test('худший запас — по самому занятому окну, а не средний', () => {
    const a = assessOrg(org('x', [
      { name: '5h', util: 0.1, resetAt: NOW + 4 * H },
      { name: 'month', util: 1, resetAt: NOW + 100 * H },
    ]), NOW)
    expect(a.verdict).toBe('walled')
    expect(a.worstHeadroom).toBeCloseTo(0, 5)
  })

  test('равные организации не перекидываются между вызовами', () => {
    const orgs = [org('A', [win('5h', 0.2, 4)]), org('B', [win('5h', 0.2, 4)])]
    const one = planPlacement(orgs, NOW, 'ses_1').org?.name
    const two = planPlacement(orgs, NOW, 'ses_1').org?.name
    expect(one).toBe(two)
  })
})

describe('сбор входа из отчёта квоты и пинов', () => {
  test('считает посаженные сессии и отбрасывает просроченные', () => {
    const inputs = placementInputs(
      [{ name: 'A', status: 'active', windows: [{ window: '5h', util: 0.1, resetAt: NOW + 4 * H }] }],
      {
        s1: { org: 'A', at: NOW - H },
        s2: { org: 'A', at: NOW - 2 * H },
        old: { org: 'A', at: NOW - 13 * H },
      },
      { nowMs: NOW },
    )
    expect(inputs[0].activeAgents).toBe(2)
  })

  test('статус отчёта переводится в причину запрета', () => {
    const inputs = placementInputs(
      [{ name: 'A', status: 'exhausted' }, { name: 'B', status: 'absent' }, { name: 'C', status: 'active', util5h: 0.1 }],
      {},
      { nowMs: NOW },
    )
    expect(inputs[0].blockedReason).toContain('exhausted')
    expect(inputs[1].blockedReason).toContain('подписки')
    expect(inputs[2].blockedReason).toBeNull()
  })
})

describe('planPlacement — стена до сброса важнее давления (12.11.2026)', () => {
  test('неделя 95% упрётся через 7.6ч → проигрывает организации с горячим, но сбрасывающимся 5ч', () => {
    const H = 3_600_000
    const now = Date.UTC(2026, 10, 12, 10)
    const mk = (name: string, u5: number, uw: number) => ({
      name, activeAgents: 0,
      windows: [{ name: '5h', util: u5, resetAt: now + H }, { name: 'week', util: uw, resetAt: now + 24 * H }],
    })
    const plan = planPlacement([mk('weekly-hot', 0.05, 0.95), mk('calm', 0.40, 0.10)], now, 'ses')
    expect(plan.org?.name).toBe('calm')
  })
})
