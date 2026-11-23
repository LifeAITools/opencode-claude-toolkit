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
