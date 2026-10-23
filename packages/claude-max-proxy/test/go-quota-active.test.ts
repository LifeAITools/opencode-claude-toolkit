/**
 * «Какая пара в работе» — сверка реестра с account_state opencode.
 *
 * Прошлый отчёт ХРАНИЛ утверждение, скопированное из реестра (`orgs[].active`), и
 * 22.10 источники разошлись: агент работал на одной организации, а файл говорил
 * «активна другая». Здесь проверяется, что расхождение даёт `неизвестно` с причиной,
 * а не «активна старая».
 */
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildGoQuotaStatus,
  readActiveAccountEmail,
  resolveActiveOrg,
  type ActiveOrgResolution,
} from '../src/opencode-go-quota.js'

const AT = new Date('2026-10-22T12:00:00Z')
const LIVE = {
  rolling: { status: 'ok', percent: 11, resetsAt: '2026-10-22T15:40:49.000Z' },
  weekly: { status: 'ok', percent: 53, resetsAt: '2026-10-27T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 26, resetsAt: '2026-11-05T12:27:21.000Z' },
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Временная база opencode: account_state (+ account, если задан email). */
function tempDb(opts: { accountId: string; orgId: string; email?: string | null }): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-go-active-'))
  dirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  try {
    db.run('create table account_state (id integer primary key, active_account_id text, active_org_id text)')
    db.run('create table account (id text primary key, email text)')
    db.run('insert into account_state (id, active_account_id, active_org_id) values (1, ?, ?)', [
      opts.accountId,
      opts.orgId,
    ])
    if (opts.email) db.run('insert into account (id, email) values (?, ?)', [opts.accountId, opts.email])
  } finally {
    db.close()
  }
  return path
}

const agreed = (): ActiveOrgResolution => resolveActiveOrg({
  registryActive: 'hello@sealform.dev',
  accountEmail: 'hello@sealform.dev',
  registryOrgNames: ['hello@sealform.dev', 'hello@torqhub.net'],
})

const disagreed = (): ActiveOrgResolution => resolveActiveOrg({
  registryActive: 'hello@sealform.dev',
  accountEmail: 'hello@torqhub.net',
  registryOrgNames: ['hello@sealform.dev', 'hello@torqhub.net'],
})

const build = (activeOrg: ActiveOrgResolution, org = 'hello@sealform.dev') => buildGoQuotaStatus({
  usage: LIVE,
  error: null,
  org,
  activeOrg,
  accountHint: org,
  models: [],
  modelsSource: '',
  measuredAt: AT,
  orgs: [
    { name: 'hello@sealform.dev', active: true, usage: LIVE },
    { name: 'hello@torqhub.net', active: false, usage: LIVE },
  ],
}) as any

describe('resolveActiveOrg — чистая сверка двух источников', () => {
  test('источники сошлись → имя подтверждено, reason=agreed', () => {
    const r = resolveActiveOrg({
      registryActive: 'hello@sealform.dev',
      accountEmail: 'hello@sealform.dev',
      registryOrgNames: ['hello@sealform.dev', 'hello@torqhub.net'],
    })
    expect(r.name).toBe('hello@sealform.dev')
    expect(r.reason).toBe('agreed')
    expect(r.sources).toEqual({ registry: 'hello@sealform.dev', accountState: 'hello@sealform.dev' })
  })

  test('источники разошлись → name null, sources несёт ОБА значения', () => {
    const r = disagreed()
    expect(r.name).toBeNull()
    expect(r.reason).toBe('sources_disagree')
    expect(r.sources.registry).toBe('hello@sealform.dev')
    expect(r.sources.accountState).toBe('hello@torqhub.net')
  })

  test('account_state не прочитан → названная причина, значение реестра видно', () => {
    const r = resolveActiveOrg({
      registryActive: 'hello@sealform.dev',
      accountEmail: null,
      registryOrgNames: ['hello@sealform.dev'],
    })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('account_state_unreadable')
    expect(r.sources.registry).toBe('hello@sealform.dev')
    expect(r.sources.accountState).toBeNull()
  })

  test('account_state называет почту вне реестра → отдельная причина', () => {
    const r = resolveActiveOrg({
      registryActive: 'hello@sealform.dev',
      accountEmail: 'stranger@example.com',
      registryOrgNames: ['hello@sealform.dev'],
    })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('account_email_not_in_registry')
    expect(r.sources.accountState).toBe('stranger@example.com')
  })

  test('пустые строки — это отсутствие, а не имя', () => {
    const r = resolveActiveOrg({ registryActive: '  ', accountEmail: '', registryOrgNames: ['x'] })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('account_state_unreadable')
    expect(r.sources).toEqual({ registry: null, accountState: null })
  })
})

describe('readActiveAccountEmail — база opencode, никогда не бросает', () => {
  test('account_state + account → email и orgId', () => {
    const path = tempDb({ accountId: 'acc-1', orgId: 'org-1', email: 'hello@torqhub.net' })
    const r = readActiveAccountEmail(path)
    expect(r.email).toBe('hello@torqhub.net')
    expect(r.orgId).toBe('org-1')
    expect(r.error).toBeNull()
  })

  test('account_state ссылается на несуществующий account → email null + причина', () => {
    const path = tempDb({ accountId: 'missing', orgId: 'org-1', email: null })
    const r = readActiveAccountEmail(path)
    expect(r.email).toBeNull()
    expect(r.error).not.toBeNull()
    expect(r.error).toContain('account row not found')
  })

  test('таблицы account_state нет → ошибка, не исключение', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-go-noschema-'))
    dirs.push(dir)
    const path = join(dir, 'opencode.db')
    new Database(path).close()
    const r = readActiveAccountEmail(path)
    expect(r.email).toBeNull()
    expect(r.error).not.toBeNull()
  })

  test('файла нет → email null + ошибка, никогда не бросает', () => {
    let r: ReturnType<typeof readActiveAccountEmail> | null = null
    expect(() => { r = readActiveAccountEmail('/nonexistent/opencode.db') }).not.toThrow()
    expect(r!.email).toBeNull()
    expect(r!.error).not.toBeNull()
  })

  test('в account_state нет строки → названная причина', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-go-empty-'))
    dirs.push(dir)
    const path = join(dir, 'opencode.db')
    const db = new Database(path)
    db.run('create table account_state (id integer primary key, active_account_id text, active_org_id text)')
    db.run('create table account (id text primary key, email text)')
    db.close()
    const r = readActiveAccountEmail(path)
    expect(r.email).toBeNull()
    expect(r.error).toBe('no account_state row')
  })
})

describe('buildGoQuotaStatus — подтверждение вместо копии из реестра', () => {
  test('сверка сошлась: top-level active=true, ровно одна запись orgs[] помечена', () => {
    const s = build(agreed())
    expect(s.active).toBe(true)
    expect(s.activeReason).toBe('agreed')
    expect(s.activeSources).toEqual({ registry: 'hello@sealform.dev', accountState: 'hello@sealform.dev' })
    const marked = s.orgs.filter((o: any) => o.active === true)
    expect(marked.length).toBe(1)
    expect(marked[0].name).toBe('hello@sealform.dev')
    expect(s.orgs.find((o: any) => o.name === 'hello@torqhub.net').active).toBe(false)
  })

  test('сверка разошлась: active=null, поля active НЕТ ни у одной организации', () => {
    const s = build(disagreed())
    expect(s.active).toBeNull()
    expect(s.activeReason).toBe('sources_disagree')
    expect(s.activeSources).toEqual({ registry: 'hello@sealform.dev', accountState: 'hello@torqhub.net' })
    for (const entry of s.orgs) expect('active' in entry).toBe(false)
  })

  test('база не прочитана: тоже null и причина — но org остаётся предметом чисел', () => {
    const s = build(resolveActiveOrg({
      registryActive: 'hello@sealform.dev',
      accountEmail: null,
      registryOrgNames: ['hello@sealform.dev', 'hello@torqhub.net'],
    }))
    expect(s.active).toBeNull()
    expect(s.activeReason).toBe('account_state_unreadable')
    expect('active' in s.orgs[0]).toBe(false)
  })

  test('top-level org НЕ зависит от сверки: предмет чисел не меняется', () => {
    expect(build(agreed()).org).toBe('hello@sealform.dev')
    expect(build(disagreed()).org).toBe('hello@sealform.dev')
  })
})
