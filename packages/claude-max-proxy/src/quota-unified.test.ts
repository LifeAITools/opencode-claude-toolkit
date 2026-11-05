/**
 * Тесты единого формата квоты.
 *
 * Смысл файла — не «функция работает», а «контракт не врёт». Три свойства, которые
 * ломаются тихо и дорого: отсутствующее число приходит как null (а не 0), у каждого
 * числа есть возраст и источник, сломавшийся провайдер виден, а не исчезает из списка.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { unifyProviderFile, unifyAll, writeUnified, STALE_AFTER_SEC } from './quota-unified.js'

const NOW = new Date('2026-11-05T10:00:00.000Z')

describe('unifyProviderFile', () => {
  test('окна OpenDesign: 5h и week, доля из util, источник назван', () => {
    const doc = {
      provider: 'open-design',
      measured_at: '2026-11-05T09:59:00.000Z',
      plan: 'go',
      accounts: {
        'a@b.c': {
          org: 'a@b.c', plan: 'go', balanceUsd: '1.50', util5h: 0.05, util7d: 0.02,
          reset5hAt: '2026-11-05T14:22:03.000Z', reset7dAt: '2026-11-12T09:22:03.000Z',
        },
      },
    }
    const [acc] = unifyProviderFile('open-design', doc, NOW)
    expect(acc.provider).toBe('open-design')
    expect(acc.account).toBe('a@b.c')
    expect(acc.status).toBe('active')
    expect(acc.level).toBe('ok')
    expect(acc.ageSec).toBe(60)
    expect(acc.stale).toBe(false)
    expect(acc.windows.map(w => w.name)).toEqual(['5h', 'week'])
    expect(acc.windows[0]).toMatchObject({ usedFraction: 0.05, source: 'provider-api' })
  })

  test('окна OpenCode Go: массив windows главнее плоских полей', () => {
    const doc = {
      measured_at: '2026-11-05T09:59:00.000Z',
      accounts: {
        'x@y.z': {
          org: 'x@y.z', util5h: 0.99, util7d: 0.5,
          windows: [
            { window: '5h', util: 0.11, resetIso: '2026-11-05T14:00:00.000Z' },
            { window: 'week', util: 0.22, resetIso: '2026-11-09T00:00:00.000Z' },
            { window: 'month', util: 1, resetIso: '2026-11-11T00:00:00.000Z' },
          ],
        },
      },
    }
    const [acc] = unifyProviderFile('opencode-go', doc, NOW)
    expect(acc.windows.map(w => [w.name, w.usedFraction])).toEqual([['5h', 0.11], ['week', 0.22], ['month', 1]])
    expect(acc.level).toBe('ok')
  })

  test('отсутствующее число — null, а НЕ ноль', () => {
    const doc = { measured_at: '2026-11-05T09:59:00.000Z', accounts: { 'a@b': { org: 'a@b', util7d: 0.3 } } }
    const [acc] = unifyProviderFile('p', doc, NOW)
    const five = acc.windows.find(w => w.name === '5h')
    expect(five).toBeUndefined()            // окна нет вовсе, а не «ноль процентов»
    expect(acc.windows.find(w => w.name === 'week')?.usedFraction).toBe(0.3)
    expect(acc.level).toBeNull()
  })

  test('провайдер объявил «чисел нет»: status absent + причина, окон нет', () => {
    const doc = { measured_at: '2026-11-05T09:59:00.000Z', quotaAbsent: { reason: 'console_login_expired' }, accounts: {} }
    const [acc] = unifyProviderFile('alibaba', doc, NOW)
    expect(acc.status).toBe('absent')
    expect(acc.reason).toBe('console_login_expired')
    expect(acc.windows).toEqual([])
  })

  test('сломавшийся сборщик виден как unreadable, а не исчезает', () => {
    const [acc] = unifyProviderFile('broken', { error: 'boom', accounts: {} }, NOW)
    expect(acc.status).toBe('unreadable')
    expect(acc.reason).toBe('boom')
  })

  test('старое измерение помечается stale', () => {
    const old = new Date(NOW.getTime() - (STALE_AFTER_SEC + 60) * 1000).toISOString()
    const doc = { measured_at: old, accounts: { a: { org: 'a', util5h: 0.1 } } }
    const [acc] = unifyProviderFile('p', doc, NOW)
    expect(acc.stale).toBe(true)
    expect(acc.ageSec).toBe(STALE_AFTER_SEC + 60)
  })

  test('битый файл — unreadable, без падения', () => {
    const [acc] = unifyProviderFile('p', null, NOW)
    expect(acc.status).toBe('unreadable')
    expect(acc.reason).toBe('file_unreadable')
  })
})

describe('unifyAll + writeUnified', () => {
  test('собирает все провайдерные файлы и пишет один', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-unified-'))
    try {
      writeFileSync(join(dir, 'quota-status-alpha.json'), JSON.stringify({
        measured_at: '2026-11-05T09:59:00.000Z', accounts: { a: { org: 'a', util5h: 0.2 } },
      }))
      writeFileSync(join(dir, 'quota-status-beta.json'), JSON.stringify({
        measured_at: '2026-11-05T09:59:00.000Z', quotaAbsent: 'expired', accounts: {},
      }))
      const snap = unifyAll(dir, NOW)
      expect(Object.keys(snap.providers).sort()).toEqual(['alpha', 'beta'])
      expect(snap.providers.beta.status).toBe('absent')
      expect(snap.accounts.length).toBe(2)
      const out = join(dir, 'quota-status.json')
      writeUnified(snap, out)
      const back = JSON.parse(readFileSync(out, 'utf8'))
      expect(back.schemaVersion).toBe(1)
      expect(back.unit.used).toBe('fraction')
      expect(back.accounts.length).toBe(2)
      // Сам себя не читает повторно: quota-status.json исключён из перечня.
      expect(unifyAll(dir, NOW).providers.alpha).toBeDefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
