import { describe, expect, test } from 'bun:test'
import { odPlacementInputs, pickOpenDesignAccount, upstreamModel, type OdAccountView } from './modules/open-design-door.js'

const H = 3_600_000
const NOW = Date.parse('2026-11-05T12:00:00.000Z')

const KEY = (email: string | null) =>
  email === 'relishev@gmail.com' ? 'OPEN_DESIGN_API_KEY'
    : email === 'hello@kiberos.app' ? 'OPEN_DESIGN_API_KEY_2'
      : null

const acc = (
  account: string,
  status: OdAccountView['status'],
  windows: OdAccountView['windows'],
  headroomFraction: number | null = null,
): OdAccountView => ({ account, status, headroomFraction, windows })

const iso = (hours: number) => new Date(NOW + hours * H).toISOString()

describe('выбор аккаунта OpenDesign — через анализатор размещения', () => {
  test('берёт ту, где ДОЛЬШЕ до стены, а не где просто больше запас', () => {
    // A: 5ч занято 50%, но сброс через 4ч и темп высокий → стена ~1ч.
    // B: 5ч занято 60%, но сброс через полчаса → окно не связывает, стены нет.
    const pick = pickOpenDesignAccount([
      acc('relishev@gmail.com', 'active', [{ name: '5h', usedFraction: 0.5, resetsAt: iso(4) }], 0.5),
      acc('hello@kiberos.app', 'active', [{ name: '5h', usedFraction: 0.6, resetsAt: iso(0.5) }], 0.4),
    ], KEY, { nowMs: NOW, seed: 's1' })
    expect(pick?.email).toBe('hello@kiberos.app')
  })

  test('исчерпанная и нечитаемая не выбираются', () => {
    const pick = pickOpenDesignAccount([
      acc('relishev@gmail.com', 'exhausted', [{ name: 'month', usedFraction: 1, resetsAt: iso(100) }], 0),
      acc('hello@kiberos.app', 'unreadable', [], null),
    ], KEY, { nowMs: NOW })
    expect(pick).toBeNull()
  })

  test('без объявленного ключа аккаунт не выбирается — ключом соседа не ходим', () => {
    const pick = pickOpenDesignAccount([
      acc('unknown@x', 'active', [{ name: '5h', usedFraction: 0.01, resetsAt: iso(4) }], 0.99),
      acc('hello@kiberos.app', 'active', [{ name: '5h', usedFraction: 0.2, resetsAt: iso(4) }], 0.8),
    ], KEY, { nowMs: NOW })
    expect(pick?.email).toBe('hello@kiberos.app')
  })

  test('посаженные агенты опускают привлекательность аккаунта', () => {
    const accounts = [acc('relishev@gmail.com', 'active', [{ name: '5h', usedFraction: 0.6, resetsAt: iso(4) }], 0.4)]
    const free = pickOpenDesignAccount(accounts, KEY, { nowMs: NOW, activeAgentsByEmail: new Map() })
    const crowded = pickOpenDesignAccount(accounts, KEY, {
      nowMs: NOW, activeAgentsByEmail: new Map([['relishev@gmail.com', 30]]),
    })
    expect(free?.email).toBe('relishev@gmail.com')
    expect(crowded?.why ?? '').toContain('агентов 30')
  })
})

describe('отчёт квоты → вход анализатора', () => {
  test('окна, статус и число агентов переносятся как есть', () => {
    const orgs = odPlacementInputs([
      acc('a@x', 'active', [{ name: '5h', usedFraction: 0.3, resetsAt: iso(4) }]),
      acc('b@x', 'absent', []),
    ], new Map([['a@x', 7]]))
    expect(orgs[0].windows[0]).toEqual({ name: '5h', util: 0.3, resetAt: NOW + 4 * H })
    expect(orgs[0].activeAgents).toBe(7)
    expect(orgs[1].blockedReason).toContain('подписки')
  })

  test('неизмеренный запас — null, а не ноль', () => {
    const orgs = odPlacementInputs([acc('a@x', 'active', [{ name: '5h', usedFraction: null, resetsAt: null }])])
    expect(orgs[0].windows[0].util).toBeNull()
    expect(orgs[0].windows[0].resetAt).toBeNull()
  })
})

describe('имя модели наверх', () => {
  test('-od снимается: у поставщика такого суффикса нет', () => {
    expect(upstreamModel('deepseek-v4.1-flash-od')).toBe('deepseek-v4.1-flash')
  })
  test('прочие имена не трогаем', () => {
    expect(upstreamModel('deepseek-v4.1-flash')).toBe('deepseek-v4.1-flash')
    expect(upstreamModel('qwen3.8-flash')).toBe('qwen3.8-flash')
  })
})
