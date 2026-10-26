/**
 * Выбор организации по ЗАПАСУ (не по `active:` реестра). Главный полюс — тот, что уронил бы окно
 * перевода: свежая организация должна выигрывать у почти исчерпанной, даже если в реестре активна она.
 */
import { describe, expect, test } from 'bun:test'
import { pickOrgByHeadroom, readOrgQuotas, readStoreOrgNames, type OrgQuotaView } from './go-org-pick.js'
import type { GoOrg } from './go-registry.js'

const org = (name: string, over: Partial<GoOrg> = {}): GoOrg => ({
  name, workspace: 'w_' + name, auth: 'console', baseUrl: 'https://g.invalid', accountUrl: 'https://c.invalid',
  synqtaskOrgUid: null, env: null, priority: 1, ...over,
})
const q = (name: string, h5: number | null, h7: number | null, status = 'active'): OrgQuotaView => ({
  name, util5h: h5, util7d: h7, utilMonth: 0, status,
})
const all = (names: string[]) => () => true

describe('выбор организации по запасу', () => {
  test('свежая выигрывает у почти исчерпанной — даже если исчерпанная помечена active', () => {
    const orgs = [org('hello'), org('hello@kiberos.app')]
    const quotas = [q('hello', 0.29, 0.91), q('hello@kiberos.app', 0.02, 0)]
    const r = pickOrgByHeadroom(orgs, quotas, all(['hello', 'hello@kiberos.app']))
    expect(r.org?.name).toBe('hello@kiberos.app')
  })

  test('исчерпанное окно исключает организацию из кандидатов', () => {
    const orgs = [org('a'), org('b')]
    const quotas = [q('a', 0.1, 1), q('b', 0.5, 0.5)]
    expect(pickOrgByHeadroom(orgs, quotas, all(['a', 'b'])).org?.name).toBe('b')
  })

  test('restricted и retired не выбираются, даже при лучшем запасе', () => {
    const orgs = [org('a'), org('b'), org('c')]
    const quotas = [q('a', 0.01, 0, 'restricted'), q('b', 0.01, 0, 'retired'), q('c', 0.6, 0.6)]
    expect(pickOrgByHeadroom(orgs, quotas, all(['a', 'b', 'c'])).org?.name).toBe('c')
  })

  test('нет пропуска в хранилище — не кандидат (иначе выберем и получим 401)', () => {
    const orgs = [org('a'), org('b')]
    const quotas = [q('a', 0.01, 0), q('b', 0.6, 0.6)]
    expect(pickOrgByHeadroom(orgs, quotas, (n) => n === 'b').org?.name).toBe('b')
  })

  test('при равном 5ч решает неделя, затем порядок реестра', () => {
    const orgs = [org('a'), org('b'), org('c')]
    const quotas = [q('a', 0.5, 0.9), q('b', 0.5, 0.2), q('c', 0.5, 0.2)]
    expect(pickOrgByHeadroom(orgs, quotas, all(['a', 'b', 'c'])).org?.name).toBe('b')
  })

  test('замеров нет вовсе → null (вызывающий откатывается на active:)', () => {
    expect(pickOrgByHeadroom([org('a')], [], all(['a'])).org).toBeNull()
  })

  test('у организации нет пятичасового окна — о запасе судить нечем, не берём', () => {
    const quotas = [q('a', null, 0.1)]
    expect(pickOrgByHeadroom([org('a')], quotas, all(['a'])).org).toBeNull()
  })

  test('api_key организации не участвуют (у них нет окна подписки)', () => {
    const orgs = [org('key', { auth: 'api_key' })]
    expect(pickOrgByHeadroom(orgs, [q('key', 0, 0)], all(['key'])).org).toBeNull()
  })
})

describe('чтение отчёта квоты и хранилища', () => {
  test('отчёт: терпим к отсутствию файла и к записи через accounts', () => {
    expect(readOrgQuotas('/nonexistent/q.json')).toEqual([])
    const { mkdtempSync, writeFileSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const d = mkdtempSync(join(tmpdir(), 'qp-'))
    const p = join(d, 'q.json')
    writeFileSync(p, JSON.stringify({ accounts: { 'org-a': { util5h: 0.1, util7d: 0.2 } } }))
    const rows = readOrgQuotas(p)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'org-a', util5h: 0.1, util7d: 0.2 })
  })

  test('хранилище: только записи с непустым access_token', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const d = mkdtempSync(join(tmpdir(), 'st-'))
    const p = join(d, 't.json')
    writeFileSync(p, JSON.stringify({ orgs: { a: { access_token: 'x' }, b: { access_token: '' }, c: {} } }))
    expect([...readStoreOrgNames(p)].sort()).toEqual(['a'])
    expect(readStoreOrgNames(null).size).toBe(0)
  })
})

/**
 * Липкость к сессии. Полюс тот же, что уронил бы перевод маршрута: кэш префикса принадлежит
 * АККАУНТУ, поэтому перескок организации посреди разговора = холодная перезапись.
 */
describe('выбор организации липок к сессии', () => {
  const band = () => {
    const orgs = [org('a'), org('b'), org('c'), org('d')]
    const quotas = [q('a', 0.02, 0.03), q('b', 0.03, 0.02), q('c', 0.04, 0.05), q('d', 0.05, 0.04)]
    return { orgs, quotas, has: all(['a', 'b', 'c', 'd']) }
  }

  test('один и тот же номер сессии даёт одну и ту же организацию при почти равных запасах', () => {
    const { orgs, quotas, has } = band()
    for (const sid of ['ses_1', 'ses_2', 'ses_3']) {
      const seen = new Set<string>()
      for (let i = 0; i < 50; i++) {
        const r = pickOrgByHeadroom(orgs, quotas, has, { stickyKey: sid })
        if (r.org) seen.add(r.org.name)
      }
      expect([...seen]).toHaveLength(1)
    }
  })

  test('разные сессии расходятся по полосе, а не садятся на одну организацию', () => {
    const { orgs, quotas, has } = band()
    const picked = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const r = pickOrgByHeadroom(orgs, quotas, has, { stickyKey: `ses_${i}` })
      if (r.org) picked.add(r.org.name)
    }
    expect(picked.size).toBeGreaterThan(1)
  })

  test('без номера сессии правило прежнее — побеждает лучший запас', () => {
    const { orgs, quotas, has } = band()
    const r = pickOrgByHeadroom(orgs, quotas, has)
    expect(r.org?.name).toBe('a')
  })

  test('отставшая сильнее полосы организация из выбора выходит', () => {
    const orgs = [org('fast'), org('slow')]
    const near = [q('fast', 0.10, 0), q('slow', 0.11, 0)]
    const keys = Array.from({ length: 40 }, (_, i) => `ses_${i}`)
    const before = keys.map((k) => pickOrgByHeadroom(orgs, near, all(['fast', 'slow']), { stickyKey: k }).org?.name)
    expect(new Set(before).size).toBe(2)
    // slow просел на 5% — это больше полосы 2%, значит он больше не кандидат ни для какой сессии
    const after = keys.map((k) => pickOrgByHeadroom(orgs, [q('fast', 0.10, 0), q('slow', 0.15, 0)], all(['fast', 'slow']), { stickyKey: k }).org?.name)
    expect(new Set(after)).toEqual(new Set(['fast']))
  })

  test('полоса настраивается: при нулевой полосе остаётся только лучший', () => {
    const { orgs, quotas, has } = band()
    const names = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const r = pickOrgByHeadroom(orgs, quotas, has, { stickyKey: `ses_${i}`, band: 0 })
      if (r.org) names.add(r.org.name)
    }
    expect([...names]).toEqual(['a'])
  })
})
