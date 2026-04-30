/**
 * KeepaliveEngine — standalone tests (no SDK, no network).
 *
 * Test isolation: the engine reads cache+KA params from SSOT (~/.claude/
 * keepalive.json by default). The bunfig.toml `preload` hook
 * (test/_setup-keepalive-fixture.ts) writes a fixture and sets
 * CLAUDE_KEEPALIVE_CONFIG_PATH so tests are stable regardless of host config.
 * Fixture: 5m TTL, 60s KA interval.
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

  test('clamps above-max to (cacheTtlMs - safetyMarginMs - 60s)', () => {
    // For default 5m TTL (300k) - 15k margin - 60k = 225_000
    // (was 240_000 hardcoded; now derived from SSOT keepalive-config)
    const e = mkEngine({ intervalMs: 300_000 })
    expect(e._config.intervalMs).toBe(225_000)
  })

  test('accepts valid interval as-is', () => {
    const e = mkEngine({ intervalMs: 120_000 })
    expect(e._config.intervalMs).toBe(120_000)
  })

  test('default reads intervalMs from SSOT fixture (60s)', () => {
    // Fixture has explicit intervalSec: 60 — engine reads that.
    const e = mkEngine()
    expect(e._config.intervalMs).toBe(60_000)
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

    // Seed heavy cache baseline + age the cacheWrittenAt timestamp.
    // Guard now measures against cacheWrittenAt (not lastRealActivityAt) so KA
    // fires correctly suppress the warning. Test simulates a stale cache by
    // backdating cacheWrittenAt directly.
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setCacheWrittenAt(Date.now() - 2000)

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
    // cacheWrittenAt just set by notifyRealRequestComplete — idle is small

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
    // cacheWrittenAt = 0 (never called notifyRealRequestComplete)
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
    e._setCacheWrittenAt(Date.now() - 2000)

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
    e._setCacheWrittenAt(Date.now() - 2000)

    expect(() => e.checkRewriteGuard('claude-opus-4-7')).not.toThrow()
    e.stop()
  })

  // ─── Regression: false-positive when KA keeps cache warm ───
  // Before this fix, guard measured idle against lastRealActivityAt — any user
  // idleness > 5min triggered a "Cache likely dead" warning even though KA fires
  // had refreshed cacheWrittenAt every 2min and the prompt cache was healthy on
  // the Anthropic side (RAW_USAGE: cache_creation_input_tokens < 2k confirmed).
  test('no warn when KA recently fired (cacheWrittenAt is fresh) even after long user idle', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5_000,
      rewriteWarnTokens: 1_000,
      onRewriteWarning: () => { fired = true },
    })

    // Step 1: real request 10 minutes ago — would trigger warning under old logic
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10 })
    e._setLastRealActivityAt(Date.now() - 600_000)  // 10 min ago

    // Step 2: KA fired 1 second ago, refreshing the cache.
    // (notifyRealRequestComplete updates cacheWrittenAt, then we backdate just
    //  lastRealActivityAt — leaving cacheWrittenAt fresh, mimicking what a
    //  successful KA fire does in the real engine.)
    e._setCacheWrittenAt(Date.now() - 1_000)

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)  // cache is warm — no warning, even though user is idle
    e.stop()
  })

  test('warn DOES fire when cacheWrittenAt is stale (KA broken or DISARMED)', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5_000,
      rewriteWarnTokens: 1_000,
      onRewriteWarning: () => { fired = true },
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10 })
    // Both timestamps stale — simulates KA broken/DISARMED + user idle
    e._setLastRealActivityAt(Date.now() - 600_000)
    e._setCacheWrittenAt(Date.now() - 600_000)

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(true)  // guard correctly detects truly dead cache
    e.stop()
  })
})

// ─── Layer 4: Error classification (regression for 18:44Z incident) ──
//
// On 2026-04-26 18:44Z, Anthropic API hung for 4 minutes on real requests.
// SDK's controller.abort() fired (timeout=600s), fetch threw AbortError, and
// classifyError fell through to 'server_transient' instead of 'network'.
// retryChain then disarmed with reason='cache_ttl_exhausted' — a lying reason
// that misled diagnosis into thinking the cache had silently aged out.
//
// These tests exercise classifyError indirectly via the disarm reason that
// surfaces from the engine. We can't import classifyError directly (it's not
// exported), so we wire a fake doFetch that throws specific shapes and observe
// which onDisarmed reason is emitted by tick().
describe('KeepaliveEngine Layer 4: error classification (regression: 2026-04-26 18:44Z)', () => {
  function mkEngineThatThrows(err: unknown, onDisarmed: (info: { reason: string; at: number }) => void) {
    const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
      throw err
      yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' } as StreamEvent
    }
    const fakeRateLimit: RateLimitInfo = {
      status: 'allowed', resetAt: null, claim: null, retryAfter: null,
      utilization5h: 0, utilization7d: 0,
    }
    return new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed },
      getToken: async () => 'fake-token',
      doFetch: fakeFetch,
      getRateLimitInfo: () => fakeRateLimit,
    })
  }

  // Helper: prime registry with a snapshot, age cache so tick() will fire,
  // then call tick() and capture the disarm reason.
  async function captureDisarmReasonAfterTickWith(err: unknown): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      let captured: string | null = null
      const e = mkEngineThatThrows(err, (info) => { captured = info.reason })
      e.notifyRealRequestStart('m', { messages: [] }, {})
      e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
      // Fresh cache: write was just now. Age it slightly so tick fires.
      e._setCacheWrittenAt(Date.now() - 1_000)
      // Force lastActivityAt back so tick() doesn't skip on jitter
      ;(e as any).lastActivityAt = Date.now() - 200_000
      ;(e as any).jitterMs = 0
      // Invoke tick directly
      void (e as any).tick().then(() => {
        // tick → catch → classify → either disarm immediately OR schedule retryChain.
        // Give microtask queue a beat for retryChain.setTimeout(2000) to register
        // the synchronous disarm decision. retryChain disarms synchronously when
        // ttlRemaining < nextDelay + safety, otherwise schedules — for fresh
        // cache it schedules, so we expect captured===null in 'server_transient' case.
        setTimeout(() => {
          e.stop()
          resolve(captured)
        }, 50)
      })
    })
  }

  test('AbortError (request timeout) → classified as network, NOT cache_ttl_exhausted', async () => {
    // Simulates: SDK timeoutId fires → controller.abort() → fetch throws AbortError
    const abortErr = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    })
    // SDK wraps it: throw new ClaudeCodeSDKError('Network error', err)
    const wrapped = Object.assign(new Error('Network error'), {
      cause: abortErr,
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    // Network classification → onDisarmed('network_error') in tick() catch.
    // MUST NOT be cache_ttl_exhausted (the lying reason from old behaviour).
    expect(reason).toBe('network_error')
  })

  test('"The operation timed out." message → classified as network', async () => {
    // The exact message that appears in production logs (sdk.ts API_ERROR).
    const wrapped = Object.assign(new Error('Network error'), {
      cause: new Error('The operation timed out.'),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
  })

  test('TimeoutError name → classified as network', async () => {
    const wrapped = Object.assign(new Error('Network error'), {
      cause: Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
  })

  test('plain "Network error" (SDK wrapper with no cause details) → classified as network', async () => {
    // Worst case: cause chain stripped, only the wrapper message survives.
    // We must still classify by message keyword 'network error'.
    const reason = await captureDisarmReasonAfterTickWith(new Error('Network error'))
    expect(reason).toBe('network_error')
  })

  test('ECONNRESET → still classified as network (regression guard)', async () => {
    const wrapped = Object.assign(new Error('Network error'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
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
