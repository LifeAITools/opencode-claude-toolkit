/**
 * org-surface — overlay the quota roster (windows + status) onto the live org
 * surface, so /admin/orgs answers "all orgs, with windows and status" (S1/D1)
 * instead of identity + token expiry only.
 *
 * The roster is injected, so the merge is asserted as a rule — no disk, no
 * dependence on which orgs this machine happens to hold.
 */

import { describe, test, expect } from 'bun:test'
import { enrichOrgSurface, indexRoster } from '../src/org-surface.js'

const ORG_A = 'aaaa1111-0000'
const ORG_B = 'bbbb2222-0000'

function surface() {
  return {
    orgs: [
      { orgId: ORG_A, orgName: 'A Org', expiresAt: 123, hasRefreshToken: true },
      { orgId: ORG_B, orgName: 'B Org', expiresAt: 456, hasRefreshToken: true },
    ],
    sessions: [{ sessionId: 's1', pinnedOrg: ORG_A, servedOrg: ORG_A }],
  }
}

describe('enrichOrgSurface — roster overlay (S1/D1)', () => {
  test('every vault org gains windows + status from the roster', () => {
    const roster = indexRoster([
      { orgId: ORG_A, status: 'exhausted', windowsKnown: true, util5h: 0.13, util7d: 0.99, level: 'critical' },
      { orgId: ORG_B, status: 'active', windowsKnown: false, util5h: null, util7d: null, level: null },
    ])
    const out = enrichOrgSurface(surface(), roster)

    expect(out.orgs).toHaveLength(2)
    const a = out.orgs.find((o) => o.orgId === ORG_A)!
    expect(a.status).toBe('exhausted')
    expect(a.util7d).toBe(0.99)
    expect(a.level).toBe('critical')
    // Vault identity is preserved (roster supplies windows, not identity).
    expect(a.orgName).toBe('A Org')

    const b = out.orgs.find((o) => o.orgId === ORG_B)!
    expect(b.status).toBe('active')
    expect(b.windowsKnown).toBe(false)
    expect(b.util5h).toBeNull()
  })

  test('an org the roster knows but the vault does not is appended, not lost', () => {
    const roster = indexRoster([{ orgId: 'cccc3333-0000', status: 'token_expired' }])
    const out = enrichOrgSurface(surface(), roster)
    expect(out.orgs.map((o) => o.orgId)).toContain('cccc3333-0000')
  })

  test('an empty roster leaves the surface unchanged', () => {
    const s = surface()
    expect(enrichOrgSurface(s, new Map())).toBe(s)
  })

  test('sessions pass through untouched', () => {
    const roster = indexRoster([{ orgId: ORG_A, status: 'active' }])
    expect(enrichOrgSurface(surface(), roster).sessions).toEqual(surface().sessions)
  })
})
