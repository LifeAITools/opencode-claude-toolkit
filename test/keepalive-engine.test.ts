/**
 * KeepaliveEngine — standalone tests (no SDK, no network).
 *
 * These validate the engine as a self-contained unit with DI callbacks.
 * Proves the engine is usable by both SDK and claude-max-proxy.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { CacheRewriteBlockedError } from '../src/types.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

// ─── Helpers ────────────────────────────────────────────────────

function mkEngine(cfg: Parameters<typeof KeepaliveEngine>[0]['config'] = {}) {
  // Minimal DI — engine never fires in tests (we don't call tick)
  const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1 }, stopReason: 'end_turn' }
  }
  const fakeRateLimit: RateLimitInfo = {
    status: 'allowed', resetAt: null, claim: null, retryAfter: null,
    utilization5h: 0, utilization7d: 0,
  }
  return new KeepaliveEngine({
    config: cfg,
    getToken: async () => 'fake-token',
    doFetch: fakeFetch,
    getRateLimitInfo: () => fakeRateLimit,
  })
}

// ─── Layer 1: Interval clamp ─────────────────────────────────────

describe('KeepaliveEngine Layer 1: intervalMs safety clamp', () => {
  test('clamps below-min (<60s) to 60_000', () => {
    const e = mkEngine({ intervalMs: 30_000 })
    expect(e._config.intervalMs).toBe(60_000)
  })

  test('clamps above-max (>240s) to 240_000', () => {
    const e = mkEngine({ intervalMs: 300_000 })
    expect(e._config.intervalMs).toBe(240_000)
  })

  test('accepts valid interval as-is', () => {
    const e = mkEngine({ intervalMs: 120_000 })
    expect(e._config.intervalMs).toBe(120_000)
  })

  test('default is 120_000', () => {
    const e = mkEngine()
    expect(e._config.intervalMs).toBe(120_000)
  })
})

// ─── Layer 2: Heaviest-snapshot registry ─────────────────────────

describe('KeepaliveEngine Layer 2: heaviest-wins snapshot registry', () => {
  test('first snapshot registers', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('claude-opus-4-7',
      { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }] },
      { Authorization: 'Bearer x' })
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 50 })

    expect(e._registry.size).toBe(1)
    expect(e._registry.get('claude-opus-4-7')?.inputTokens).toBe(5000)
    e.stop()
  })

  test('larger snapshot overwrites smaller', () => {
    const e = mkEngine({ minTokens: 100 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'small' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 10 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'large' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 10000, outputTokens: 10 })

    expect(e._registry.get('claude-opus-4-7')?.inputTokens).toBe(10000)
    e.stop()
  })

  test('smaller snapshot does NOT overwrite larger (subagent protection)', () => {
    const e = mkEngine({ minTokens: 100 })

    // Heavy main conversation: 50k input + 40k cacheRead = 90k total
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'main' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 100, cacheReadInputTokens: 40000 })

    // Tiny subagent call: 200 tokens — MUST NOT overwrite
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'sub' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 200, outputTokens: 10 })

    expect(e._registry.get('claude-opus-4-7')?.inputTokens).toBe(90000)
    e.stop()
  })

  test('below minTokens threshold — not registered at all', () => {
    const e = mkEngine({ minTokens: 5000 })
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 100, outputTokens: 10 })

    expect(e._registry.size).toBe(0)
    e.stop()
  })

  test('lastKnownCacheTokensByModel tracks max, never downgrades', () => {
    const e = mkEngine({ minTokens: 100 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    expect(e._lastKnownCacheTokensByModel.get('claude-opus-4-7')).toBe(50000)

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 200, outputTokens: 10 })
    expect(e._lastKnownCacheTokensByModel.get('claude-opus-4-7')).toBe(50000)  // unchanged
    e.stop()
  })
})

// ─── Layer 3: Rewrite guard ──────────────────────────────────────

describe('KeepaliveEngine Layer 3: rewrite-burst guard', () => {
  test('warn fires on long idle with large estimated cache', () => {
    let warn: { idleMs: number; estimatedTokens: number; blocked: boolean } | null = null
    const e = mkEngine({
      rewriteWarnIdleMs: 1000,
      rewriteWarnTokens: 10000,
      onRewriteWarning: (info) => { warn = info },
    })

    // Seed heavy cache baseline + idle time
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setLastRealActivityAt(Date.now() - 2000)

    e.checkRewriteGuard('claude-opus-4-7')

    expect(warn).not.toBeNull()
    expect(warn!.estimatedTokens).toBe(50000)
    expect(warn!.blocked).toBe(false)
    e.stop()
  })

  test('no warn when idle < warnIdleMs', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5000,
      rewriteWarnTokens: 1000,
      onRewriteWarning: () => { fired = true },
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    // lastRealActivityAt just set by notifyRealRequestComplete — idle is small

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)
    e.stop()
  })

  test('no warn on first-ever request (no baseline)', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 1,
      rewriteWarnTokens: 1,
      onRewriteWarning: () => { fired = true },
    })
    // lastRealActivityAt = 0 (never called notifyRealRequestComplete)
    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)
    e.stop()
  })

  test('throws CacheRewriteBlockedError when blockEnabled + idle > blockIdleMs', () => {
    const e = mkEngine({
      rewriteWarnIdleMs: 500,
      rewriteWarnTokens: 1000,
      rewriteBlockIdleMs: 1000,
      rewriteBlockEnabled: true,
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setLastRealActivityAt(Date.now() - 2000)

    expect(() => e.checkRewriteGuard('claude-opus-4-7')).toThrow(CacheRewriteBlockedError)
    e.stop()
  })

  test('no throw when blockEnabled=false even on long idle', () => {
    const e = mkEngine({
      rewriteWarnIdleMs: 500,
      rewriteWarnTokens: 1000,
      rewriteBlockIdleMs: 1000,
      rewriteBlockEnabled: false,
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setLastRealActivityAt(Date.now() - 2000)

    expect(() => e.checkRewriteGuard('claude-opus-4-7')).not.toThrow()
    e.stop()
  })
})

// ─── Public API surface ──────────────────────────────────────────

describe('KeepaliveEngine public API', () => {
  test('stop() clears timers and registry', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    expect(e._registry.size).toBe(1)
    expect(e._timer).not.toBeNull()

    e.stop()

    expect(e._registry.size).toBe(0)
    expect(e._timer).toBeNull()
  })

  test('accepts all documented KeepaliveConfig callbacks', () => {
    expect(() => mkEngine({
      enabled: true,
      intervalMs: 120_000,
      idleTimeoutMs: Infinity,
      minTokens: 2000,
      rewriteWarnIdleMs: 300_000,
      rewriteWarnTokens: 50_000,
      rewriteBlockIdleMs: Infinity,
      rewriteBlockEnabled: false,
      onHeartbeat: () => {},
      onTick: () => {},
      onDisarmed: () => {},
      onRewriteWarning: () => {},
      onNetworkStateChange: () => {},
    })).not.toThrow()
  })
})
