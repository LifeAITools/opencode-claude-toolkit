/**
 * OrgVault — persisted per-org credentials + session pins.
 *
 * Born from PRPs/per-org-tokens (2026-06-10): a cross-org login overwrites
 * the single system credential file, killing HOLDs at token expiry and on
 * proxy restart. The vault must never lose an org's credential line.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { OrgVault, type OrgVaultEntry } from '../src/org-vault.js'

const TMP = mkdtempSync(join(tmpdir(), 'org-vault-'))
let seq = 0
const vpath = () => join(TMP, `vault-${seq++}.json`)

const entry = (orgId: string, over: Partial<OrgVaultEntry> = {}): OrgVaultEntry => ({
  orgId,
  orgName: `org-${orgId}`,
  accessToken: `at-${orgId}`,
  refreshToken: `rt-${orgId}`,
  expiresAt: Date.now() + 3_600_000,
  capturedAt: Date.now(),
  ...over,
})

describe('OrgVault — persistence', () => {
  test('upsert + get + survives a new instance (restart)', () => {
    const p = vpath()
    const v1 = new OrgVault(p)
    v1.upsert(entry('org-A'))
    v1.upsert(entry('org-B'))
    const v2 = new OrgVault(p)   // simulated restart
    expect(v2.get('org-A')?.accessToken).toBe('at-org-A')
    expect(v2.list().length).toBe(2)
  })

  test('vault file is 0600', () => {
    const p = vpath()
    new OrgVault(p).upsert(entry('org-A'))
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  test('older capture never overwrites a newer credential', () => {
    const p = vpath()
    const v = new OrgVault(p)
    v.upsert(entry('org-A', { accessToken: 'newer', capturedAt: 2000 }))
    v.upsert(entry('org-A', { accessToken: 'older', capturedAt: 1000 }))
    expect(v.get('org-A')?.accessToken).toBe('newer')
  })

  test('corrupt file degrades to empty vault (fail-soft)', () => {
    const p = vpath()
    require('fs').writeFileSync(p, '{not json')
    const v = new OrgVault(p)
    expect(v.list()).toEqual([])
    v.upsert(entry('org-A'))            // and it recovers
    expect(JSON.parse(readFileSync(p, 'utf8')).orgs['org-A']).toBeDefined()
  })
})

describe('OrgVault — resolve (fuzzy)', () => {
  test('exact id, unique prefix, unique name substring', () => {
    const v = new OrgVault(vpath())
    v.upsert(entry('f9420373-aaaa', { orgName: 'personal-max' }))
    v.upsert(entry('11112222-bbbb', { orgName: 'team-acme' }))
    expect(v.resolve('f9420373-aaaa')?.orgName).toBe('personal-max')
    expect(v.resolve('f942')?.orgName).toBe('personal-max')
    expect(v.resolve('acme')?.orgName).toBe('team-acme')
    expect(v.resolve('zzz')).toBeNull()
    expect(v.resolve('1')).toBeTruthy()  // unique prefix '1111…'
  })

  test('unique account-email substring resolves even with a custom org name', () => {
    const v = new OrgVault(vpath())
    // Enterprise org: custom name carries NO email — email must still match.
    v.upsert(entry('aaaa1111-1111', { orgName: 'Acme Inc', accountEmail: 'ruslan@acme.com' }))
    v.upsert(entry('bbbb2222-2222', { orgName: 'Beta LLC', accountEmail: 'ops@beta.io' }))
    expect(v.resolve('ruslan@acme.com')?.orgId).toBe('aaaa1111-1111')
    expect(v.resolve('ruslan')?.orgId).toBe('aaaa1111-1111')      // partial email
    expect(v.resolve('beta.io')?.orgId).toBe('bbbb2222-2222')
    // ambiguous across email+name domains → null, never a guess
    v.upsert(entry('cccc3333-3333', { orgName: 'Gamma', accountEmail: 'ruslan@gamma.dev' }))
    expect(v.resolve('ruslan')).toBeNull()
  })

  test('upsert preserves accountEmail across credential refreshes', () => {
    const p = vpath()
    const v = new OrgVault(p)
    v.upsert(entry('org-A', { accountEmail: 'me@mail.com', capturedAt: 1000 }))
    v.upsert(entry('org-A', { accountEmail: undefined, capturedAt: 2000 }))  // refresh w/o email
    expect(new OrgVault(p).get('org-A')?.accountEmail).toBe('me@mail.com')
  })
})

describe('OrgVault — pins', () => {
  test('set/get/delete + persist across instances; pins carry ONLY orgId', () => {
    const p = vpath()
    const v = new OrgVault(p)
    v.setPin('sess-1', 'org-A')
    expect(new OrgVault(p).getPin('sess-1')).toEqual({ orgId: 'org-A' })
    expect(JSON.stringify(JSON.parse(readFileSync(p, 'utf8')).pins)).not.toContain('at-')  // no tokens in pins
    v.deletePin('sess-1')
    expect(new OrgVault(p).getPin('sess-1')).toBeNull()
  })

  test('markVerified updates only forward in time', () => {
    const v = new OrgVault(vpath())
    v.upsert(entry('org-A'))
    v.markVerified('org-A', 5000)
    v.markVerified('org-A', 3000)
    expect(v.get('org-A')?.lastVerifiedAt).toBe(5000)
  })
})
