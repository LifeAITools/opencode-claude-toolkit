/**
 * «Какая пара в работе» — сверка реестра с account_state opencode.
 *
 * Прошлый отчёт ХРАНИЛ утверждение, скопированное из реестра (`orgs[].active`), и
 * 22.10 источники разошлись: агент работал на одной организации, а файл говорил
 * «активна другая». Здесь проверяется, что расхождение даёт `неизвестно` с причиной,
 * а не «активна старая».
 *
 * 🔴 ВТОРОЕ ПРАВИЛО (владелец реестра, 23.10): КАНОН — ИДЕНТИФИКАТОР, А НЕ ИМЯ.
 * Он джойнит `active_org_id → workspace`, я джойнил `active_account_id → email`: это
 * РАЗНЫЕ величины, и совпадают они лишь пока одна учётка = одна организация. Поэтому
 * сильная сверка идёт по паре идентификаторов, а имена — ярлыки. Отдельный исход
 * `labelMismatch` существует ровно чтобы «вход был в другую» и «мы по-разному назвали»
 * не склеивались в одно значение.
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
function tempDb(opts: { accountId: string; orgId: string; email?: string | null; rows?: number }): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-go-active-'))
  dirs.push(dir)
  const path = join(dir, 'opencode.db')
  const db = new Database(path)
  try {
    db.run('create table account_state (id integer primary key, active_account_id text, active_org_id text)')
    db.run('create table account (id text primary key, email text)')
    const rows = opts.rows ?? 1
    for (let i = 1; i <= rows; i++) {
      db.run('insert into account_state (id, active_account_id, active_org_id) values (?, ?, ?)', [
        i, opts.accountId, opts.orgId,
      ])
    }
    if (opts.email) db.run('insert into account (id, email) values (?, ?)', [opts.accountId, opts.email])
  } finally {
    db.close()
  }
  return path
}

const NAMES = ['hello@sealform.dev', 'hello@torqhub.net']

describe('resolveActiveOrg — сильная сверка по идентификаторам', () => {
  test('пара совпала и ярлыки тоже → agreed, basis=workspace_id', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
      accountEmail: 'hello@sealform.dev',
      accountId: 'acc-1',
      accountOrgId: 'org-1',
      registryOrgNames: NAMES,
    })
    expect(r.name).toBe('hello@sealform.dev')
    expect(r.basis).toBe('workspace_id')
    expect(r.reason).toBe('agreed')
    expect(r.sources.registryWorkspace).toBe('org-1')
    expect(r.sources.accountOrgId).toBe('org-1')
  })

  test('ПАРА совпала, ярлыки разные → labelMismatch: факт один, подписи разошлись', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'Организация «Силформ»', workspace: 'org-1' },
      accountEmail: 'hello@sealform.dev',
      accountId: 'acc-1',
      accountOrgId: 'org-1',
      registryOrgNames: NAMES,
    })
    // Подтверждение ЕСТЬ: сверялись идентификаторы, а не подписи.
    expect(r.name).toBe('Организация «Силформ»')
    expect(r.basis).toBe('workspace_id')
    expect(r.reason).toBe('labelMismatch')
  })

  test('идентификаторы разошлись → sources_disagree даже при одинаковых ярлыках', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
      accountEmail: 'hello@sealform.dev',
      accountOrgId: 'org-2',
      registryOrgNames: NAMES,
    })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('sources_disagree')
    expect(r.sources.registryWorkspace).toBe('org-1')
    expect(r.sources.accountOrgId).toBe('org-2')
  })
})

describe('resolveActiveOrg — слабая сверка по ярлыкам названа слабой', () => {
  test('идентификаторов нет, ярлыки совпали → agreed_by_label (НЕ agreed)', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: null },
      accountEmail: 'hello@sealform.dev',
      registryOrgNames: NAMES,
    })
    expect(r.name).toBe('hello@sealform.dev')
    expect(r.basis).toBe('label')
    expect(r.reason).toBe('agreed_by_label')
  })

  test('идентификаторов нет, ярлыки разошлись → sources_disagree', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
      accountEmail: 'hello@torqhub.net',
      registryOrgNames: NAMES,
    })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('sources_disagree')
    expect(r.sources.registry).toBe('hello@sealform.dev')
    expect(r.sources.accountState).toBe('hello@torqhub.net')
  })

  test('account_state не прочитан → названная причина, значение реестра видно', () => {
    const r = resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
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
      registryActive: { name: 'hello@sealform.dev', workspace: null },
      accountEmail: 'stranger@example.com',
      registryOrgNames: ['hello@sealform.dev'],
    })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('account_email_not_in_registry')
    expect(r.sources.accountState).toBe('stranger@example.com')
  })

  test('пустые строки — это отсутствие, а не имя', () => {
    const r = resolveActiveOrg({ registryActive: { name: '  ', workspace: '' }, accountEmail: '', registryOrgNames: ['x'] })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('account_state_unreadable')
    expect(r.sources.registry).toBeNull()
    expect(r.sources.accountState).toBeNull()
  })

  test('реестр не назвал активную орг, но почта известна и в реестре есть', () => {
    const r = resolveActiveOrg({ registryActive: null, accountEmail: 'hello@sealform.dev', registryOrgNames: NAMES })
    expect(r.name).toBeNull()
    expect(r.reason).toBe('sources_disagree')
  })
})

describe('readActiveAccountEmail — база opencode, никогда не бросает', () => {
  test('account_state + account → email, accountId и orgId', () => {
    const path = tempDb({ accountId: 'acc-1', orgId: 'org-1', email: 'hello@torqhub.net' })
    const r = readActiveAccountEmail(path)
    expect(r.email).toBe('hello@torqhub.net')
    expect(r.accountId).toBe('acc-1')
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

  test('ДВЕ строки account_state → «не знаем», а не «возьмём меньший id»', () => {
    const path = tempDb({ accountId: 'acc-1', orgId: 'org-1', email: 'a@x', rows: 2 })
    const r = readActiveAccountEmail(path)
    expect(r.email).toBeNull()
    expect(r.error).toContain('2 rows')
  })
})

describe('buildGoQuotaStatus — подтверждение вместо копии из реестра', () => {
  const build = (activeOrg: ActiveOrgResolution, org = 'hello@sealform.dev') => buildGoQuotaStatus({
    usage: LIVE, error: null, org, activeOrg, accountHint: org, models: [], modelsSource: '',
    measuredAt: AT,
    orgs: [
      { name: 'hello@sealform.dev', active: true, usage: LIVE },
      { name: 'hello@torqhub.net', active: false, usage: LIVE },
    ],
  }) as any

  const agreed = (): ActiveOrgResolution => resolveActiveOrg({
    registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
    accountEmail: 'hello@sealform.dev', accountId: 'acc-1', accountOrgId: 'org-1',
    registryOrgNames: NAMES,
  })
  const disagreed = (): ActiveOrgResolution => resolveActiveOrg({
    registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
    accountEmail: 'hello@torqhub.net', accountId: 'acc-9', accountOrgId: 'org-9',
    registryOrgNames: NAMES,
  })

  test('сверка сошлась: top-level active=true, ровно одна запись orgs[] помечена', () => {
    const s = build(agreed())
    expect(s.active).toBe(true)
    expect(s.activeReason).toBe('agreed')
    expect(s.activeBasis).toBe('workspace_id')
    const marked = s.orgs.filter((o: any) => o.active === true)
    expect(marked.length).toBe(1)
    expect(marked[0].name).toBe('hello@sealform.dev')
    expect(s.orgs.find((o: any) => o.name === 'hello@torqhub.net').active).toBe(false)
  })

  test('СЫРЫЕ ИДЕНТИФИКАТОРЫ едут в файл рядом с ярлыками', () => {
    const s = build(agreed())
    expect(s.activeAccountId).toBe('acc-1')
    expect(s.activeOrgId).toBe('org-1')
    expect(s.activeSources.accountOrgId).toBe('org-1')
    expect(s.orgSource).toBe('registry_decision')
  })

  test('сверка разошлась: active=null, поля active НЕТ ни у одной организации', () => {
    const s = build(disagreed())
    expect(s.active).toBeNull()
    expect(s.activeReason).toBe('sources_disagree')
    expect(s.activeSources.registry).toBe('hello@sealform.dev')
    expect(s.activeSources.accountState).toBe('hello@torqhub.net')
    for (const entry of s.orgs) expect('active' in entry).toBe(false)
  })

  test('база не прочитана: тоже null и причина — но org остаётся предметом чисел', () => {
    const s = build(resolveActiveOrg({
      registryActive: { name: 'hello@sealform.dev', workspace: 'org-1' },
      accountEmail: null,
      registryOrgNames: NAMES,
    }))
    expect(s.active).toBeNull()
    expect(s.activeReason).toBe('account_state_unreadable')
    expect(s.activeAccountId).toBeNull()
    expect(s.activeOrgId).toBeNull()
    expect('active' in s.orgs[0]).toBe(false)
  })

  test('top-level org НЕ зависит от сверки: предмет чисел не меняется', () => {
    expect(build(agreed()).org).toBe('hello@sealform.dev')
    expect(build(disagreed()).org).toBe('hello@sealform.dev')
  })
})
