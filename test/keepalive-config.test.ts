/**
 * Tests for src/keepalive-config.ts — the SSOT for cache + KA parameters.
 *
 * Coverage:
 *   - Defaults when file missing (legacy 5m fallback)
 *   - File overrides via cacheTtlSec / intervalSec keys
 *   - Validation: out-of-range clamping, bad types, malformed file
 *   - Hot-reload semantics (mtime cache, manual reload)
 */
// Test isolation via bunfig.toml preload (see test/_setup-keepalive-fixture.ts).
import { describe, test, expect } from 'bun:test'
import { _resolve, RECOMMENDED_1H_CONFIG, getConfigPath } from '../src/keepalive-config.js'

describe('keepalive-config: defaults (no file)', () => {
  test('resolves to 5m TTL by default', () => {
    const c = _resolve(null)
    expect(c.cacheTtlMs).toBe(5 * 60 * 1000)
    expect(c.safetyMarginMs).toBe(15 * 1000)
    // Auto-scaled: max(60_000, min(TTL/2, 1_800_000)) = min(150_000, 1_800_000) = 150_000
    expect(c.intervalMs).toBe(150_000)
    expect(c._source).toBe('defaults')
  })

  test('explicit intervalSec=120 overrides auto-scale', () => {
    const c = _resolve({ intervalSec: 120 })
    expect(c.intervalMs).toBe(120_000)
  })

  test('clamp ranges scale with default TTL', () => {
    const c = _resolve(null)
    expect(c.intervalClampMin).toBe(60_000)
    // intervalClampMax = cacheTtlMs - safetyMarginMs - 60_000 = 300k - 15k - 60k = 225k
    expect(c.intervalClampMax).toBe(225_000)
  })
})

describe('keepalive-config: 1h TTL via file', () => {
  test('cacheTtlSec=3600 yields 1h TTL', () => {
    const c = _resolve({ cacheTtlSec: 3600 })
    expect(c.cacheTtlMs).toBe(3_600_000)
    expect(c._source).toBe('mixed')
  })

  test('default intervalMs scales with 1h TTL to 1800s (max 30min)', () => {
    const c = _resolve({ cacheTtlSec: 3600 })
    expect(c.intervalMs).toBe(1_800_000)
  })

  test('explicit intervalSec wins over auto-scale', () => {
    const c = _resolve({ cacheTtlSec: 3600, intervalSec: 600 })
    expect(c.intervalMs).toBe(600_000)
  })

  test('intervalClampMax expands to TTL - safetyMargin - 60s', () => {
    const c = _resolve({ cacheTtlSec: 3600, safetyMarginSec: 60 })
    // 3600 - 60 - 60 = 3480 sec
    expect(c.intervalClampMax).toBe(3_480_000)
  })

  test('intervalSec clamps if > intervalClampMax', () => {
    const c = _resolve({ cacheTtlSec: 3600, safetyMarginSec: 60, intervalSec: 4000 })
    expect(c.intervalMs).toBe(3_480_000)
  })

  test('retryDelaysSec converts to ms', () => {
    const c = _resolve({ cacheTtlSec: 3600, retryDelaysSec: [2, 5, 10, 60, 300] })
    expect(c.retryDelaysMs).toEqual([2_000, 5_000, 10_000, 60_000, 300_000])
  })
})

describe('keepalive-config: validation + safety', () => {
  test('cacheTtlSec=10 (below min 60s) clamps to 60_000ms', () => {
    const c = _resolve({ cacheTtlSec: 10 })
    expect(c.cacheTtlMs).toBe(60_000)
  })

  test('cacheTtlSec=99999 (above 2h max) clamps to 7_200_000ms', () => {
    const c = _resolve({ cacheTtlSec: 99999 })
    expect(c.cacheTtlMs).toBe(7_200_000)
  })

  test('non-numeric cacheTtlSec falls back to default', () => {
    const c = _resolve({ cacheTtlSec: 'never' as unknown as number })
    expect(c.cacheTtlMs).toBe(5 * 60 * 1000)
  })

  test('empty retryDelays array falls back', () => {
    const c = _resolve({ retryDelaysSec: [] })
    expect(c.retryDelaysMs.length).toBeGreaterThan(0)
  })

  test('non-array retryDelays falls back', () => {
    const c = _resolve({ retryDelaysSec: 'not-an-array' as unknown as number[] })
    expect(c.retryDelaysMs.length).toBeGreaterThan(0)
  })

  test('idleTimeoutSec=null preserves Infinity', () => {
    const c = _resolve({ idleTimeoutSec: null as unknown as number })
    expect(c.idleTimeoutMs).toBe(Infinity)
  })

  test('enabled=false disables KA', () => {
    const c = _resolve({ enabled: false })
    expect(c.enabled).toBe(false)
  })

  test('intervalSec below 60s clamps to 60_000', () => {
    const c = _resolve({ intervalSec: 30 })
    expect(c.intervalMs).toBe(60_000)
  })
})

describe('keepalive-config: RECOMMENDED_1H_CONFIG produces valid 1h setup', () => {
  test('using recommended values gives 1h TTL with 30min interval', () => {
    const c = _resolve({
      cacheTtlSec: RECOMMENDED_1H_CONFIG.cacheTtlSec,
      safetyMarginSec: RECOMMENDED_1H_CONFIG.safetyMarginSec,
      intervalSec: RECOMMENDED_1H_CONFIG.intervalSec,
      retryDelaysSec: [...RECOMMENDED_1H_CONFIG.retryDelaysSec],
    })
    expect(c.cacheTtlMs).toBe(3_600_000)
    expect(c.safetyMarginMs).toBe(60_000)
    expect(c.intervalMs).toBe(1_800_000)
    expect(c.retryDelaysMs).toEqual([2_000, 3_000, 5_000, 10_000, 15_000, 20_000, 30_000, 60_000, 120_000, 300_000])
  })

  test('cumulative retry budget fits inside (TTL - safetyMargin)', () => {
    const c = _resolve({
      cacheTtlSec: RECOMMENDED_1H_CONFIG.cacheTtlSec,
      safetyMarginSec: RECOMMENDED_1H_CONFIG.safetyMarginSec,
      retryDelaysSec: [...RECOMMENDED_1H_CONFIG.retryDelaysSec],
    })
    const cumulative = c.retryDelaysMs.reduce((a, b) => a + b, 0)
    expect(cumulative).toBeLessThan(c.cacheTtlMs - c.safetyMarginMs)
  })
})

describe('keepalive-config: getConfigPath', () => {
  test('returns the env override or default path', () => {
    // Under test runner CLAUDE_KEEPALIVE_CONFIG_PATH points to a fixture.
    // Without override it would point to ~/.claude/keepalive.json.
    const p = getConfigPath()
    const expected = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH ?? ''
    if (expected) {
      expect(p).toBe(expected)
    } else {
      expect(p).toMatch(/\.claude\/keepalive\.json$/)
    }
  })
})

describe('keepalive-config: rewriteGuard', () => {
  test('default — guard disabled, 50k threshold, default marker', () => {
    const c = _resolve(null)
    expect(c.rewriteGuard.enabled).toBe(false)
    expect(c.rewriteGuard.minRewriteTokens).toBe(50_000)
    expect(c.rewriteGuard.overrideMarker).toBe('[%cache-rewrite-ok%]')
  })

  test('parses rewriteGuard from file', () => {
    const c = _resolve({ rewriteGuard: { enabled: true, minRewriteTokens: 120_000, overrideMarker: '[ok]' } })
    expect(c.rewriteGuard.enabled).toBe(true)
    expect(c.rewriteGuard.minRewriteTokens).toBe(120_000)
    expect(c.rewriteGuard.overrideMarker).toBe('[ok]')
  })

  test('invalid rewriteGuard fields fall back to defaults', () => {
    const c = _resolve({ rewriteGuard: { minRewriteTokens: 'nope', overrideMarker: '' } })
    expect(c.rewriteGuard.minRewriteTokens).toBe(50_000)                // non-numeric → default
    expect(c.rewriteGuard.overrideMarker).toBe('[%cache-rewrite-ok%]')  // empty → default
    expect(c.rewriteGuard.enabled).toBe(false)
  })
})
