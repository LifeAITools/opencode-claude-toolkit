import { describe, expect, test } from 'bun:test'
import { odAccountSource, odCallKind, odPlacementInputs, pickOpenDesignAccount, upstreamModel, type OdAccountView } from './modules/open-design-door.js'

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

describe('вид вызова — тот же контракт, что у двери Go', () => {
  test('названный вид проходит, неизвестный и пустой — real', () => {
    expect(odCallKind('warm')).toBe('warm')
    expect(odCallKind('probe')).toBe('probe')
    expect(odCallKind(null)).toBe('real')
    expect(odCallKind('что-то')).toBe('real')
  })
})

describe('источник выбора — код, а не фраза', () => {
  test('в заголовок и журнал едет код; русская причина остаётся в событии', () => {
    expect(odAccountSource(true)).toBe('pin')
    expect(odAccountSource(false)).toBe('quota')
    // Регрессия 06.11: свободный текст причины в header давал TypeError → 500.
    expect(() => new Response('', { headers: { 'x-open-design-account-source': odAccountSource(false) } })).not.toThrow()
  })
})

describe('привязки переживают перезапуск двери', () => {
  test('файл читается обратно после «перезапуска»', async () => {
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const m = await import('./modules/open-design-door.js')
    const dir = mkdtempSync(join(tmpdir(), 'odpins-'))
    const path = join(dir, 'pins.json')
    const now = Date.now()
    m.resetOpenDesignPins()
    m.restoreOpenDesignPinsForTest([['ses_a', { email: 'hello@kiberos.com', at: now }]])
    m.saveOpenDesignPins(path)
    m.resetOpenDesignPins()          // память обнулена, как при выкатке
    m.loadOpenDesignPins(path)       // дверь перезапустилась
    expect(m.odPinsSnapshot().ses_a).toEqual({ email: 'hello@kiberos.com', at: now })
  })

  test('просроченная привязка не читается — срок тот же, что у выдачи', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const m = await import('./modules/open-design-door.js')
    const dir = mkdtempSync(join(tmpdir(), 'odpins-'))
    const path = join(dir, 'pins.json')
    writeFileSync(path, JSON.stringify({ version: 1, pins: { ses_old: { email: 'x@y', at: Date.now() - 13 * 3600 * 1000 } } }))
    m.resetOpenDesignPins()
    m.loadOpenDesignPins(path)
    expect(m.odPinsSnapshot().ses_old).toBeUndefined()
  })
})
