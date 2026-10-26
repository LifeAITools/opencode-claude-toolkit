/** Зеркало отчёта квоты: у отчёта два читателя в двух разных каталогах (см. QUOTA_STATUS_OPENCODE_GO_MIRROR). */
import { describe, expect, test } from 'bun:test'
import { mirrorReport } from './opencode-go-quota.js'


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
