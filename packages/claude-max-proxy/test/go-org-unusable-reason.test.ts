/**
 * ПОЧЕМУ ВЫДАННАЯ ОРГАНИЗАЦИЯ ОТВЕРГНУТА — причина, а не «нет» (30.10.2026).
 *
 * Повод: фаундер спросил «почему pin уезжает внутри одной сессии». Ответить было нечем:
 * `isOrgUsable` отдавала только `false`, в журнале оставался `source: quota`, и три разных
 * явления — стена окна, отозванный пропуск, потерянная строка замера — выглядели одинаково.
 */
import { describe, expect, test } from 'bun:test'
import { orgUnusableReason, type GoOrg, type OrgQuotaView } from '../src/go-org-pick.js'

const org = (name: string, auth: 'console' | 'api_key' = 'console'): GoOrg =>
  ({ name, auth, workspace: 'w', baseUrl: 'u' }) as GoOrg
const q = (name: string, v: Partial<OrgQuotaView>): OrgQuotaView =>
  ({ name, util5h: 0.1, util7d: 0.2, utilMonth: 0.3, status: 'active', ...v }) as OrgQuotaView
const has = (n: string) => n !== 'no-cred'

describe('orgUnusableReason — причина отвержения выдачи', () => {
  test('годная организация — null', () => {
    expect(orgUnusableReason([org('a')], [q('a', {})], has, 'a')).toBeNull()
  })

  test('нет в реестре / не console / нет пропуска / нет строки замера', () => {
    expect(orgUnusableReason([], [], has, 'a')).toBe('no-org')
    expect(orgUnusableReason([org('a', 'api_key')], [q('a', {})], has, 'a')).toBe('not-console')
    expect(orgUnusableReason([org('no-cred')], [q('no-cred', {})], has, 'no-cred')).toBe('no-credential')
    expect(orgUnusableReason([org('a')], [], has, 'a')).toBe('no-quota-row')
  })

  test('стена называет ОКНО и долю — иначе не понять, когда отпустит', () => {
    expect(orgUnusableReason([org('a')], [q('a', { util7d: 1 })], has, 'a')).toBe('exhausted:7d=1')
    expect(orgUnusableReason([org('a')], [q('a', { utilMonth: 1 })], has, 'a')).toBe('exhausted:month=1')
    expect(orgUnusableReason([org('a')], [q('a', { util5h: 1 })], has, 'a')).toBe('exhausted:5h=1')
  })

  test('закрытая организация — отдельным кодом', () => {
    expect(orgUnusableReason([org('a')], [q('a', { status: 'retired' })], has, 'a')).toBe('status:retired')
  })

  test('неизвестная доля 5ч — не «годна» и не «исчерпана», а честное «судить нельзя»', () => {
    expect(orgUnusableReason([org('a')], [q('a', { util5h: null })], has, 'a')).toBe('util5h-unknown')
  })

  test('неизвестное 7д НЕ считается стеной (неизмеренное ≠ ноль и ≠ стена)', () => {
    expect(orgUnusableReason([org('a')], [q('a', { util7d: null })], has, 'a')).toBeNull()
  })
})
