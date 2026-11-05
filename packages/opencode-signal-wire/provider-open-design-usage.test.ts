/**
 * Подвал для OpenDesign: числа + ЧЕСТНАЯ подпись организации.
 * Провайдер не даёт org-uid SynqTask, поэтому подпись — имя workspace и его id,
 * а не выдуманная связь с членом организации.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readOpenDesignQuota, pickOpenDesignAccount, describeOpenDesignQuota } from './provider-open-design-usage.js'

const dir = mkdtempSync(join(tmpdir(), 'od-quota-'))
const p = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f }

describe('open-design quota for the footer', () => {
  test('читает аккаунты, отдаёт имя workspace и его id — не выдумывает uid', () => {
    const f = p('a.json', {
      provider: 'open-design', measured_at: '2026-11-05T10:00:00.000Z', plan: 'go',
      accounts: {
        'Личный': { org: 'Личный', workspaceId: 'w-1', workspaceType: 'personal', plan: 'go', util5h: 0.053, util7d: 0.018 },
        'Команда': { org: 'Команда', workspaceId: 'w-2', workspaceType: 'team', absent: 'no_active_subscription' },
      },
    })
    const v = readOpenDesignQuota(f)!
    expect(v.accounts).toHaveLength(2)
    expect(v.accounts[0].workspaceId).toBe('w-1')
    expect(v.accounts[0].util5h).toBeCloseTo(0.053)
    expect(v.accounts[1].absent).toBe('no_active_subscription')
    expect((v.accounts[0] as any).orgUid).toBeUndefined()
  })

  test('годный аккаунт важнее пустого, пустой объясняет причину', () => {
    const f = p('b.json', { provider: 'open-design', accounts: {
      empty: { org: 'empty', absent: 'no_active_subscription' },
      live: { org: 'live', util5h: 0.1, util7d: 0.2 },
    } })
    expect(pickOpenDesignAccount(readOpenDesignQuota(f))!.org).toBe('live')
    expect(describeOpenDesignQuota(readOpenDesignQuota(f))).toContain('live')
  })

  test('нет файла, битый файл, чужой провайдер — null, а не нули', () => {
    expect(readOpenDesignQuota(join(dir, 'missing.json'))).toBeNull()
    expect(readOpenDesignQuota(p('bad.json', { provider: 'opencode-go' }))).toBeNull()
    expect(describeOpenDesignQuota(null)).toBeNull()
  })

  test('строка подвала округляет до десятых и не врёт про отсутствие', () => {
    const f = p('c.json', { provider: 'open-design', accounts: { x: { org: 'Work', util5h: 0.0538, util7d: 0.018 } } })
    expect(describeOpenDesignQuota(readOpenDesignQuota(f))).toBe('Work · 5ч 5.4% · нед 1.8%')
    const g = p('d.json', { provider: 'open-design', accounts: { x: { org: 'Team', absent: 'no_active_subscription' } } })
    expect(describeOpenDesignQuota(readOpenDesignQuota(g))).toBe('Team · нет подписки (no_active_subscription)')
  })
})

test('cleanup', () => rmSync(dir, { recursive: true, force: true }))
