/**
 * Тесты сборщика квоты OpenDesign.
 *
 * Главное, что здесь защищается: ОТСУТСТВИЕ ПОДПИСКИ — это `absent` с причиной, а не
 * «0% использовано». Живой случай 05.11.2026: у аккаунта два workspace, личный (план go,
 * окна 5ч/нед) и командный (`eligible:false`, окон нет, кошелёк 0). Если бы второе стало
 * нулём, балансировщик считал бы организацию годной и отправлял туда ходы.
 */
import { describe, expect, test } from 'bun:test'
import { windowOf, accountFrom, snapshotFromWorkspaces } from './open-design-quota.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')

describe('open-design-quota', () => {
  test('окно опознаётся по durationSeconds, а не по порядку', () => {
    expect(windowOf({ durationSeconds: 18000, usedCredits: '500', limitCredits: '1000', resetsAt: '2026-11-05T14:00:00.000Z' })!.window).toBe('5h')
    expect(windowOf({ durationSeconds: 604800, usedCredits: '1', limitCredits: '2' })!.window).toBe('week')
    expect(windowOf({ durationSeconds: 3600 } as any)).toBeNull()
  })

  test('доля считается из кредитов; отсутствие любого слагаемого даёт null, не 0', () => {
    const w = windowOf({ durationSeconds: 18000, usedCredits: '250', limitCredits: '1000' })!
    expect(w.util).toBeCloseTo(0.25)
    expect(windowOf({ durationSeconds: 18000, usedCredits: '250' } as any)!.util).toBeNull()
  })

  test('eligible:false — это absent с причиной, а не ноль процентов', () => {
    const acc = accountFrom({ codingPlan: { eligible: false } } as any, { id: 'w1', name: 'team', type: 'team' }, 'a@b.c', NOW)
    expect(acc.absent).toBe('no_active_subscription')
    expect(acc.util5h).toBeNull()
    expect(acc.windows).toEqual([])
  })

  test('несколько workspace аккаунта: каждая организация — своя запись', () => {
    const snap = snapshotFromWorkspaces([
      { workspace: { id: 'w1', name: 'team', type: 'team', isDefault: false }, preflight: { codingPlan: { eligible: false }, balanceUsd: '0.0000' } as any },
      { workspace: { id: 'w2', name: 'personal', type: 'personal', isDefault: true }, preflight: {
        balanceUsd: '1.5000',
        codingPlan: { eligible: true, tier: 'go', windows: [
          { durationSeconds: 18000, usedCredits: '100', limitCredits: '1000', resetsAt: '2026-11-05T14:22:03.000Z' },
          { durationSeconds: 604800, usedCredits: '100', limitCredits: '5000', resetsAt: '2026-11-12T09:22:03.000Z' },
        ] },
      } as any },
    ], 'a@b.c', NOW)

    expect(Object.keys(snap.accounts).sort()).toEqual(['personal', 'team'])
    expect(snap.accounts.team.absent).toBe('no_active_subscription')
    expect(snap.accounts.personal.util5h).toBeCloseTo(0.1)
    // Сводка берёт ГОДНУЮ организацию, а не первую попавшуюся.
    expect(snap.plan).toBe('go')
    expect(snap.balanceUsd).toBe('1.5000')
    expect(snap.orgs.find(o => o.name === 'team')!.status).toBe('absent')
    expect(snap.orgs.find(o => o.name === 'personal')!.status).toBe('active')
  })

  test('одна организация не прочиталась — остальные всё равно в отчёте', () => {
    const snap = snapshotFromWorkspaces([
      { workspace: { id: 'w1', name: 'broken', type: 'team', isDefault: false }, preflight: { codingPlan: { eligible: false } } as any },
      { workspace: { id: 'w2', name: 'ok', type: 'personal', isDefault: true }, preflight: { codingPlan: { eligible: true, tier: 'go', windows: [{ durationSeconds: 18000, usedCredits: '1', limitCredits: '10' }] } } as any },
    ], null, NOW)
    expect(Object.keys(snap.accounts).length).toBe(2)
  })
})
