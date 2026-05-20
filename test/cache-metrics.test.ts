/**
 * Tests for src/cache-metrics.ts — rolling-window cache metrics + regression detector.
 */
import { describe, test, expect } from 'bun:test'
import { CacheMetricsCollector } from '../src/cache-metrics.js'

describe('CacheMetricsCollector: basics', () => {
  test('empty collector returns zero summary', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    const s = c.summary()
    expect(s.total).toBe(0)
    expect(s.hitRate).toBe(0)
    c.stop()
  })

  test('records and summarizes single hit', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    c.recordRequest({ kind: 'real', cacheRead: 50_000, cacheWrite: 0, input: 1, sysHash: 'aaa' })
    const s = c.summary()
    expect(s.total).toBe(1)
    expect(s.hitRate).toBe(1.0)
    expect(s.avgCacheRead).toBe(50_000)
    expect(s.distinctSysHash).toBe(1)
    c.stop()
  })

  test('mixed hits and misses compute hit_rate', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1 })
    c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1 })
    c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 1000, input: 1 })
    c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 1000, input: 1 })
    const s = c.summary()
    expect(s.total).toBe(4)
    expect(s.hitRate).toBe(0.5)
    c.stop()
  })

  test('cold-start count tracks first-call misses', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 50_000, input: 1, firstCall: true })
    c.recordRequest({ kind: 'real', cacheRead: 50_000, cacheWrite: 0, input: 1, firstCall: false })
    c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 30_000, input: 1, firstCall: true })
    const s = c.summary()
    expect(s.coldStartCount).toBe(2)
    c.stop()
  })

  test('distinct sysHashes counted', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    for (const h of ['a', 'a', 'b', 'b', 'c']) {
      c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1, sysHash: h })
    }
    const s = c.summary()
    expect(s.distinctSysHash).toBe(3)
    c.stop()
  })

  test('saved tokens = 0.9 × cache_read', () => {
    const c = new CacheMetricsCollector({ reportIntervalMs: 0 })
    c.recordRequest({ kind: 'real', cacheRead: 1000, cacheWrite: 0, input: 1 })
    const s = c.summary()
    expect(s.estimatedSavedTokens).toBe(900)
    c.stop()
  })
})

describe('CacheMetricsCollector: window pruning', () => {
  test('old samples drop out of window', async () => {
    const c = new CacheMetricsCollector({ windowMs: 50, reportIntervalMs: 0 })
    c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1 })
    expect(c.summary().total).toBe(1)
    await new Promise(r => setTimeout(r, 70))
    expect(c.summary().total).toBe(0)
    c.stop()
  })
})

describe('CacheMetricsCollector: regression detector', () => {
  test('does not fire if no previous window', () => {
    let regressed = false
    const c = new CacheMetricsCollector({
      windowMs: 50,
      reportIntervalMs: 0,
      regressionMinSamples: 2,
      regressionThreshold: 0.5,
      regressionPreviousFloor: 0.8,
      onRegression: () => { regressed = true },
    })
    // Add some misses, but no prior healthy window — should NOT regress
    for (let i = 0; i < 5; i++) {
      c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 1000, input: 1 })
    }
    // Manually trigger report
    ;(c as any).report()
    expect(regressed).toBe(false)
    c.stop()
  })

  test('fires when hit-rate drops from healthy to bad', () => {
    let regressedInfo: any = null
    const c = new CacheMetricsCollector({
      windowMs: 60_000,
      reportIntervalMs: 0,
      regressionMinSamples: 2,
      regressionThreshold: 0.5,
      regressionPreviousFloor: 0.8,
      onRegression: (info) => { regressedInfo = info },
    })
    // Healthy window: 5 hits, no misses
    for (let i = 0; i < 5; i++) {
      c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1 })
    }
    ;(c as any).report()
    expect(regressedInfo).toBeNull()

    // Clear samples and add bad ones
    ;(c as any).samples.length = 0
    for (let i = 0; i < 5; i++) {
      c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 1000, input: 1 })
    }
    ;(c as any).report()
    expect(regressedInfo).not.toBeNull()
    expect(regressedInfo.currentHitRate).toBe(0)
    expect(regressedInfo.previousHitRate).toBe(1)
    expect(regressedInfo.drop).toBe(1)
    c.stop()
  })

  test('does not fire when not enough samples', () => {
    let regressed = false
    const c = new CacheMetricsCollector({
      reportIntervalMs: 0,
      regressionMinSamples: 100,
      regressionThreshold: 0.5,
      regressionPreviousFloor: 0.8,
      onRegression: () => { regressed = true },
    })
    for (let i = 0; i < 10; i++) {
      c.recordRequest({ kind: 'real', cacheRead: 100, cacheWrite: 0, input: 1 })
    }
    ;(c as any).report()
    ;(c as any).samples.length = 0
    for (let i = 0; i < 10; i++) {
      c.recordRequest({ kind: 'real', cacheRead: 0, cacheWrite: 1000, input: 1 })
    }
    ;(c as any).report()
    expect(regressed).toBe(false)  // 10 < min 100
    c.stop()
  })
})
