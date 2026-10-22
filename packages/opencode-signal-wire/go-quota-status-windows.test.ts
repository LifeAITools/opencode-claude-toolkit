/**
 * Окна подписки Go из файла квоты — АКТИВНАЯ организация, форма provider-quota.
 *
 * Замер 16.10.2026 (просьба владельца signal-wire-core): адаптер файл
 * `quota-status-opencode-go.json` не читал вовсе — `computeGoWindows` считает
 * окна лишь по моделям с известным лимитом (Spark), а флотские (`deepseek-*-go`)
 * оставались без окон, и ядро не могло судить паузу по квоте Go.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGoQuotaStatusWindows } from './provider-go-usage'

function writeQuota(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'go-quota-'))
  const p = join(dir, 'quota-status-opencode-go.json')
  writeFileSync(p, JSON.stringify(body))
  return p
}

describe('окна Go из файла квоты (активная организация)', () => {
  test('активная орг → окна 5h/7d/30d, util 0..1, measuredAt из файла', () => {
    const p = writeQuota({
      measured_at: '2026-10-16T13:59:41.197Z',
      org: 'console-oeliseva',
      accounts: {
        'console-oeliseva': {
          active: true,
          windows: [
            { window: '5h', util: 0.98, resetIso: '2026-10-16T18:53:12.000Z' },
            { window: 'week', util: 0.39 },
            { window: 'month', util: 0.19 },
          ],
        },
      },
    })
    const r = readGoQuotaStatusWindows(p)!
    expect(r.measuredAt).toBe('2026-10-16T13:59:41.197Z')
    expect(r.windows.map((w) => w.kind)).toEqual(['5h', '7d', '30d'])
    expect(r.windows[0]).toEqual({
      kind: '5h', util: 0.98, resetAt: '2026-10-16T18:53:12.000Z', measuredAt: '2026-10-16T13:59:41.197Z',
    })
    expect(r.windows[1].util).toBe(0.39)
    expect(r.windows[2].kind).toBe('30d')
  })

  test('нет top-level org — берётся запись с active:true', () => {
    const p = writeQuota({
      updatedAt: '2026-10-16T13:59:41.197Z',
      accounts: { 'console-x': { active: true, windows: [{ window: '5h', util: 0.5 }] } },
    })
    const r = readGoQuotaStatusWindows(p)!
    expect(r.windows[0]).toEqual({ kind: '5h', util: 0.5, measuredAt: '2026-10-16T13:59:41.197Z' })
  })

  test('нет файла / нет окон / нет measured_at / битый JSON — null, а не нули', () => {
    expect(readGoQuotaStatusWindows('/nonexistent/go-quota.json')).toBeNull()
    expect(readGoQuotaStatusWindows(writeQuota({ measured_at: 'x', accounts: {} }))).toBeNull()
    expect(readGoQuotaStatusWindows(writeQuota({ accounts: { a: { active: true, windows: [] } } }))).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'go-quota-bad-'))
    const bad = join(dir, 'q.json')
    writeFileSync(bad, '{not json')
    expect(readGoQuotaStatusWindows(bad)).toBeNull()
  })
})

describe('организация ЭТОГО агента, а не активная в файле', () => {
  // Живой замер 22.10.2026 (владелец signal-wire): в `accounts` файла лежит РОВНО ОДНА запись —
  // активная, а окна КАЖДОЙ организации — в `orgs[]`. Два агента на разных орг видели одни числа.
  const body = {
    measured_at: '2026-10-22T11:53:14.484Z',
    org: 'hello@uniclowd.com',
    accounts: {
      'hello@uniclowd.com': { active: true, windows: [{ window: '5h', util: 0.22 }, { window: 'week', util: 0.08 }] },
    },
    orgs: [
      { name: 'hello@kiberos.app', windows: [{ window: '5h', util: 0.8 }, { window: 'week', util: 0.9 }] },
      { name: 'hello@uniclowd.com', windows: [{ window: '5h', util: 0.22 }, { window: 'week', util: 0.08 }] },
    ],
  }

  test('названа орг агента → берём ЕЁ окна и говорим basis=agent_org', () => {
    const got = readGoQuotaStatusWindows(writeQuota(body), { org: 'hello@kiberos.app' })!
    expect(got.basis).toBe('agent_org')
    expect(got.windows.find((w) => w.kind === '7d')!.util).toBeCloseTo(0.9, 5)
  })

  test('орг не названа → активная, и basis ЧЕСТНО говорит active_fallback', () => {
    const got = readGoQuotaStatusWindows(writeQuota(body))!
    expect(got.basis).toBe('active_fallback')
    expect(got.windows.find((w) => w.kind === '7d')!.util).toBeCloseTo(0.08, 5)
  })

  test('названа орг, которой в файле нет → не выдумываем: активная + fallback', () => {
    const got = readGoQuotaStatusWindows(writeQuota(body), { org: 'nope@example.com' })!
    expect(got.basis).toBe('active_fallback')
    expect(got.windows.find((w) => w.kind === '5h')!.util).toBeCloseTo(0.22, 5)
  })
})
