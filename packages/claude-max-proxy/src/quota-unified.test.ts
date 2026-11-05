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

describe('годность по всем окнам (замер 05.11.2026)', () => {
  // Фаундер/home-general: 10 организаций с МЕСЯЦЕМ 100% показывались зелёными, потому что
  // срок пропуска живой. «Есть квота» и «можно работать» — разные вещи, и подвал не имеет
  // права их путать: балансировщик поведёт флот на мёртвую организацию.
  test('месяц 100% — это exhausted с названным окном и датой, а не active', () => {
    const doc = { measured_at: '2026-11-05T09:59:00.000Z', accounts: { 'a@b': {
      org: 'a@b', util5h: 0, util7d: 0.4, utilMonth: 1, resetMonthAt: '2026-11-11T09:00:00.000Z',
    } } }
    const [acc] = unifyProviderFile('opencode-go', doc, NOW)
    expect(acc.status).toBe('exhausted')
    expect(acc.exhaustedWindow?.name).toBe('month')
    expect(acc.exhaustedWindow?.resetsAt).toBe('2026-11-11T09:00:00.000Z')
    expect(acc.reason).toContain('month_exhausted')
  })

  test('явный признак поставщика rate-limited тоже даёт exhausted', () => {
    const doc = { measured_at: '2026-11-05T09:59:00.000Z', accounts: { a: {
      org: 'a', windows: [{ window: 'week', util: 0.99, status: 'rate-limited', resetIso: '2026-11-09T00:00:00.000Z' }],
    } } }
    const [acc] = unifyProviderFile('p', doc, NOW)
    expect(acc.status).toBe('exhausted')
    expect(acc.exhaustedWindow?.name).toBe('week')
  })

  test('все окна ниже предела — active', () => {
    const doc = { measured_at: '2026-11-05T09:59:00.000Z', accounts: { a: { org: 'a', util5h: 0.5, util7d: 0.99, utilMonth: 0.8 } } }
    expect(unifyProviderFile('p', doc, NOW)[0].status).toBe('active')
  })

  test('провайдер: одна упёршаяся организация важнее десяти живых', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-exh-'))
    try {
      writeFileSync(join(dir, 'quota-status-x.json'), JSON.stringify({
        measured_at: '2026-11-05T09:59:00.000Z',
        accounts: {
          alive: { org: 'alive', util5h: 0.1, util7d: 0.1, utilMonth: 0.1 },
          dead: { org: 'dead', util5h: 0, util7d: 0, utilMonth: 1, resetMonthAt: '2026-11-11T00:00:00.000Z' },
        },
      }))
      const snap = unifyAll(dir, NOW)
      expect(snap.providers.x.status).toBe('exhausted')
      expect(snap.providers.x.reason).toContain('month_exhausted')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test('active не тащит на себе чужую причину отсутствия', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quota-reason-'))
    try {
      writeFileSync(join(dir, 'quota-status-y.json'), JSON.stringify({
        measured_at: '2026-11-05T09:59:00.000Z',
        accounts: {
          empty: { org: 'empty', absent: 'no_active_subscription' },
          live: { org: 'live', util5h: 0.1, util7d: 0.1 },
        },
      }))
      const snap = unifyAll(dir, NOW)
      expect(snap.providers.y.status).toBe('active')
      expect(snap.providers.y.reason).toBeUndefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('orgs[] не теряется (замер 05.11.2026)', () => {
  // Сборщик Go кладёт в `accounts` ТОЛЬКО активную организацию, все 18 — в `orgs[]`.
  // Пока единый формат читал только `accounts`, семнадцать организаций исчезали, и
  // организация с МЕСЯЦЕМ 100% не показывалась вообще.
  test('читаются оба источника: orgs[] + accounts поверх', () => {
    const doc = {
      measured_at: '2026-11-05T09:59:00.000Z',
      accounts: { 'a@b': { org: 'a@b', util5h: 0.1, util7d: 0.1, utilMonth: 0.1 } },
      orgs: [
        { name: 'a@b', util5h: 0.1, util7d: 0.1, utilMonth: 0.1 },
        { name: 'c@d', util5h: 0, util7d: 0, utilMonth: 1, resetMonthAt: '2026-11-11T00:00:00.000Z' },
      ],
    }
    const list = unifyProviderFile('opencode-go', doc, NOW)
    expect(list.map(a => a.account).sort()).toEqual(['a@b', 'c@d'])
    expect(list.find(a => a.account === 'c@d')!.status).toBe('exhausted')
    expect(list.find(a => a.account === 'c@d')!.exhaustedWindow?.name).toBe('month')
  })
})
