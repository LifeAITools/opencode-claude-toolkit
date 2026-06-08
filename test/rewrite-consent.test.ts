/**
 * Unit tests for the session-scoped cache-rewrite consent store.
 * Verifies grant/consume/has, single-use semantics, TTL expiry, and that a
 * missing/corrupt file never throws.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { grantConsent, consumeConsent, hasConsent, loadConsentGrants } from '../src/rewrite-consent.js'

const DIR = mkdtempSync(join(tmpdir(), 'rewrite-consent-'))
let seq = 0
const freshPath = () => join(DIR, `grants-${seq++}.json`)

describe('rewrite-consent store', () => {
  test('grant → consume returns true once, then false (single-use)', () => {
    const p = freshPath()
    grantConsent(p, 'sess-A', 180_000)
    expect(consumeConsent(p, 'sess-A')).toBe(true)
    expect(consumeConsent(p, 'sess-A')).toBe(false)
  })

  test('consume on a session with no grant → false', () => {
    expect(consumeConsent(freshPath(), 'nobody')).toBe(false)
  })

  test('expired grant is not consumable (TTL respected)', () => {
    const p = freshPath()
    grantConsent(p, 'sess-B', 1, Date.now() - 10_000)  // granted 10s ago, ttl 1ms
    expect(hasConsent(p, 'sess-B')).toBe(false)
    expect(consumeConsent(p, 'sess-B')).toBe(false)
  })

  test('grants are per-session — consuming one leaves the other', () => {
    const p = freshPath()
    grantConsent(p, 'sess-C', 180_000)
    grantConsent(p, 'sess-D', 180_000)
    expect(consumeConsent(p, 'sess-C')).toBe(true)
    expect(hasConsent(p, 'sess-D')).toBe(true)
  })

  test('load prunes expired entries', () => {
    const p = freshPath()
    const now = Date.now()
    writeFileSync(p, JSON.stringify({
      live: { grantedAt: now, ttlMs: 180_000 },
      dead: { grantedAt: now - 10_000, ttlMs: 1 },
    }))
    const grants = loadConsentGrants(p, now)
    expect(Object.keys(grants)).toEqual(['live'])
  })

  test('missing file → empty, never throws', () => {
    expect(loadConsentGrants(join(DIR, 'does-not-exist.json'))).toEqual({})
    expect(consumeConsent(join(DIR, 'does-not-exist.json'), 'x')).toBe(false)
  })

  test('corrupt file → empty, never throws', () => {
    const p = freshPath()
    writeFileSync(p, 'not json {{{')
    expect(loadConsentGrants(p)).toEqual({})
  })
})
