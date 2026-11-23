/** Зеркало отчёта квоты: у отчёта два читателя в двух разных каталогах (см. QUOTA_STATUS_OPENCODE_GO_MIRROR). */
import { describe, expect, test } from 'bun:test'
import { mirrorReport, buildGoQuotaStatus } from './opencode-go-quota.js'


describe('зеркало отчёта квоты для посредника', () => {
  test('пусто — зеркала нет, и это не ошибка', () => {
    expect(mirrorReport(undefined, { a: 1 })).toBeNull()
    expect(mirrorReport('   ', { a: 1 })).toBeNull()
  })

  test('пишет тот же самый отчёт по второму адресу', () => {
    const written: Array<{ path: string; body: unknown }> = []
    const out = mirrorReport('/mirror/out.json', { orgs: [] }, (path, body) => { written.push({ path, body }) })
    expect(out).toBeNull()
    expect(written).toEqual([{ path: '/mirror/out.json', body: { orgs: [] } }])
  })

  test('провал зеркала назван, но отчёт для подвала этим не отменяется', () => {
    const out = mirrorReport('/mirror/out.json', { orgs: [] }, () => { throw new Error('EROFS') })
    expect(out).toContain('EROFS')
  })
})

describe('организация с отвергнутым входом не читается зелёной (23.11.2026)', () => {
  test('credential rejected + окон нет: status unreadable и level null', () => {
    const s: any = buildGoQuotaStatus({
      usage: null, error: null, accountHint: 'h', org: 'h', models: [], modelsSource: '',
      measuredAt: new Date('2026-11-23T22:00:00Z'),
      orgs: [{ name: 'k@x', auth: 'api_key', status: 'active', usage_error: '401 authentication_error', usage: {} }],
    } as any)
    const o = s.orgs.find((x: any) => x.name === 'k@x')
    expect(o.credential).toBe('rejected')
    expect(o.status).toBe('unreadable')
    expect(o.level).toBeNull()
  })
})

describe('чьи числа едут в плоские поля при расхождении источников (23.11.2026)', () => {
  const LIVE = { rolling: { percent: 10, resetsAt: '2099-01-01T00:00:00Z' }, weekly: { percent: 20, resetsAt: '2099-01-02T00:00:00Z' } }
  const dead = { name: 'reg@x', auth: 'api_key', usage: {}, usage_error: '401 authentication_error', active: true } as any
  const live = { name: 'used@x', auth: 'api_key', usage: LIVE } as any
  const disagree: any = { name: null, basis: 'workspace_id', reason: 'sources_disagree', sources: { registry: 'reg@x', registryWorkspace: 'w1', accountState: 'used@x', accountId: 'a', accountOrgId: 'w2' } }

  test('реестровая слепа, названная opencode измерена → числа берутся у неё, обе названы в причине', async () => {
    const { pickFlatOrg } = await import('./opencode-go-quota.js')
    const r = pickFlatOrg({ registryActive: dead, accountEmail: 'used@x', orgs: [dead, live], resolution: disagree })
    expect(r.org?.name).toBe('used@x')
    expect(r.substituted).toBe(true)
    expect(r.reasonSuffix).toBe(';registry=reg@x;used=used@x;why=registry_credential_rejected')
  })

  test('реестровая измерена → остаёмся на ней, даже если источники разошлись', async () => {
    const { pickFlatOrg } = await import('./opencode-go-quota.js')
    const r = pickFlatOrg({ registryActive: { ...dead, usage: LIVE }, accountEmail: 'used@x', orgs: [dead, live], resolution: disagree })
    expect(r.substituted).toBe(false)
    expect(r.org?.name).toBe('reg@x')
  })

  test('источники согласны или названная не измерена → не подменяем', async () => {
    const { pickFlatOrg } = await import('./opencode-go-quota.js')
    expect(pickFlatOrg({ registryActive: dead, accountEmail: 'used@x', orgs: [dead, live], resolution: { ...disagree, reason: 'agreed' } }).substituted).toBe(false)
    expect(pickFlatOrg({ registryActive: dead, accountEmail: 'used@x', orgs: [dead, { ...live, usage: {} }], resolution: disagree }).substituted).toBe(false)
  })

  test('в файле: верхнее org остаётся решением реестра, flatOrg называет чьи окна', () => {
    const s: any = buildGoQuotaStatus({
      usage: LIVE as any, error: null, org: 'used@x', registryOrg: 'reg@x', accountHint: 'used@x',
      activeOrg: { ...disagree, reason: 'sources_disagree;registry=reg@x;used=used@x;why=registry_credential_rejected' },
      models: [], modelsSource: '', measuredAt: new Date('2026-11-23T22:00:00Z'), orgs: [dead, live],
    } as any)
    expect(s.org).toBe('reg@x')
    expect(s.flatOrg).toBe('used@x')
    expect(s.activeReason).toContain('used=used@x')
    expect(s.accounts['used@x'].util5h).toBeCloseTo(0.1)
  })
})
