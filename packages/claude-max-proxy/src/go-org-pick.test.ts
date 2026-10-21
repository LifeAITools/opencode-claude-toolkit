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
