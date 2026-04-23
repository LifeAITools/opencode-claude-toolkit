/**
 * Keepalive regression tests — pins behavior of the 7-layer KA defense stack.
 *
 * These tests MUST keep passing through any refactor of KA internals
 * (including the planned extraction into KeepaliveEngine).
 *
 * Strategy: inject a MemoryCredentialStore so the SDK never hits disk auth,
 * then use fetch-mocking + TypeScript `as unknown as` casts to poke at
 * private fields. Not clean, but pins the contract.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { ClaudeCodeSDK, MemoryCredentialStore } from '../src/sdk.js'
import { CacheRewriteBlockedError } from '../src/types.js'

// ─── Helpers ────────────────────────────────────────────────────

function mkSDK(overrides: Parameters<typeof ClaudeCodeSDK['prototype']['constructor']>[0] = {}) {
  // MemoryCredentialStore with valid-looking token (far-future expiry)
  const store = new MemoryCredentialStore({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresAt: Date.now() + 8 * 3600_000, // 8h ahead
  })
  return new ClaudeCodeSDK({
    credentialStore: store,
    accountUuid: 'test-uuid',
    deviceId: 'test-device',
    ...overrides,
  })
}

// Access private members via cast — pins current layout but acceptable for regression tests
function priv<T = any>(sdk: ClaudeCodeSDK, field: string): T {
  return (sdk as unknown as Record<string, unknown>)[field] as T
}
function setPriv(sdk: ClaudeCodeSDK, field: string, value: unknown): void {
  (sdk as unknown as Record<string, unknown>)[field] = value
}

// ─── Layer 1: Interval clamp ─────────────────────────────────────

describe('KA Layer 1: intervalMs safety clamp', () => {
  test('clamps below-min (<60s) to 60_000', () => {
    const sdk = mkSDK({ keepalive: { intervalMs: 30_000 } })
    const cfg = priv(sdk, 'keepaliveConfig') as { intervalMs: number }
    expect(cfg.intervalMs).toBe(60_000)
  })

  test('clamps above-max (>240s) to 240_000', () => {
    const sdk = mkSDK({ keepalive: { intervalMs: 300_000 } })
    const cfg = priv(sdk, 'keepaliveConfig') as { intervalMs: number }
    expect(cfg.intervalMs).toBe(240_000)
  })

  test('accepts valid interval as-is', () => {
    const sdk = mkSDK({ keepalive: { intervalMs: 120_000 } })
    const cfg = priv(sdk, 'keepaliveConfig') as { intervalMs: number }
    expect(cfg.intervalMs).toBe(120_000)
  })

  test('default is 120_000', () => {
    const sdk = mkSDK()
    const cfg = priv(sdk, 'keepaliveConfig') as { intervalMs: number }
    expect(cfg.intervalMs).toBe(120_000)
  })
})

// ─── Layer 2: Heaviest-snapshot registry ─────────────────────────

describe('KA Layer 2: heaviest-wins snapshot registry', () => {
  test('first snapshot registers', () => {
    const sdk = mkSDK({ keepalive: { minTokens: 100 } })

    // Simulate a real stream completion
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })

    // Call onStreamComplete via prototype
    const onStreamComplete = Object.getPrototypeOf(sdk).onStreamComplete.bind(sdk)
    onStreamComplete({ inputTokens: 5000, outputTokens: 50 })

    const reg = priv<Map<string, { inputTokens: number }>>(sdk, 'keepaliveRegistry')
    expect(reg.size).toBe(1)
    expect(reg.get('claude-opus-4-7')?.inputTokens).toBe(5000)
  })

  test('larger snapshot overwrites smaller', () => {
    const sdk = mkSDK({ keepalive: { minTokens: 100 } })
    const onStreamComplete = Object.getPrototypeOf(sdk).onStreamComplete.bind(sdk)

    // First: 5000 tokens
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [{ role: 'user', content: 'small' }] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })
    onStreamComplete({ inputTokens: 5000, outputTokens: 10 })

    // Second: 10000 tokens (heavier)
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [{ role: 'user', content: 'large' }] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })
    onStreamComplete({ inputTokens: 10000, outputTokens: 10 })

    const reg = priv<Map<string, { inputTokens: number }>>(sdk, 'keepaliveRegistry')
    expect(reg.get('claude-opus-4-7')?.inputTokens).toBe(10000)
  })

  test('smaller snapshot does NOT overwrite larger (subagent protection)', () => {
    const sdk = mkSDK({ keepalive: { minTokens: 100 } })
    const onStreamComplete = Object.getPrototypeOf(sdk).onStreamComplete.bind(sdk)

    // First: heavy main conversation
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [{ role: 'user', content: 'main' }] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })
    onStreamComplete({ inputTokens: 50000, outputTokens: 100, cacheReadInputTokens: 40000 })

    // Second: tiny subagent call — must NOT overwrite
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [{ role: 'user', content: 'sub' }] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })
    onStreamComplete({ inputTokens: 200, outputTokens: 10 })

    const reg = priv<Map<string, { inputTokens: number }>>(sdk, 'keepaliveRegistry')
    // Registry keeps the heaviest (90000 = 50000 + 40000 cacheRead)
    expect(reg.get('claude-opus-4-7')?.inputTokens).toBe(90000)
  })

  test('below minTokens threshold — not registered at all', () => {
    const sdk = mkSDK({ keepalive: { minTokens: 5000 } })
    const onStreamComplete = Object.getPrototypeOf(sdk).onStreamComplete.bind(sdk)

    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [] })
    setPriv(sdk, '_pendingSnapshotHeaders', { Authorization: 'Bearer x' })
    onStreamComplete({ inputTokens: 100, outputTokens: 10 })

    const reg = priv<Map<string, { inputTokens: number }>>(sdk, 'keepaliveRegistry')
    expect(reg.size).toBe(0)
  })

  test('tracks lastKnownCacheTokensByModel for rewrite cost estimation (never downgrades)', () => {
    const sdk = mkSDK({ keepalive: { minTokens: 100 } })
    const onStreamComplete = Object.getPrototypeOf(sdk).onStreamComplete.bind(sdk)

    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [] })
    setPriv(sdk, '_pendingSnapshotHeaders', {})
    onStreamComplete({ inputTokens: 50000, outputTokens: 10 })

    const max = priv<Map<string, number>>(sdk, 'lastKnownCacheTokensByModel')
    expect(max.get('claude-opus-4-7')).toBe(50000)

    // Smaller real request — max must not go down
    setPriv(sdk, '_pendingSnapshotModel', 'claude-opus-4-7')
    setPriv(sdk, '_pendingSnapshotBody', { messages: [] })
    setPriv(sdk, '_pendingSnapshotHeaders', {})
    onStreamComplete({ inputTokens: 200, outputTokens: 10 })

    expect(max.get('claude-opus-4-7')).toBe(50000) // unchanged
  })
})

// ─── Layer 3: Rewrite guard ──────────────────────────────────────

describe('KA Layer 3: rewrite-burst guard', () => {
  test('warn callback fires when idle > warnIdleMs AND estimatedTokens >= warnTokens', () => {
    let warnFired: { idleMs: number; estimatedTokens: number; blocked: boolean } | null = null
    const sdk = mkSDK({
      keepalive: {
        rewriteWarnIdleMs: 1000,
        rewriteWarnTokens: 10000,
        onRewriteWarning: (info) => { warnFired = info },
      },
    })

    // Seed state: recent real activity far in past, heavy cache tracked
    setPriv(sdk, 'keepaliveLastRealActivityAt', Date.now() - 2000) // 2s ago > 1000ms
    const max = priv<Map<string, number>>(sdk, 'lastKnownCacheTokensByModel')
    max.set('claude-opus-4-7', 50000)

    // Call checkRewriteGuard
    const check = Object.getPrototypeOf(sdk).checkRewriteGuard.bind(sdk)
    check('claude-opus-4-7')

    expect(warnFired).not.toBeNull()
    expect(warnFired!.idleMs).toBeGreaterThanOrEqual(1500)
    expect(warnFired!.estimatedTokens).toBe(50000)
    expect(warnFired!.blocked).toBe(false)
  })

  test('does NOT warn when idle < warnIdleMs (normal cadence)', () => {
    let warnFired = false
    const sdk = mkSDK({
      keepalive: {
        rewriteWarnIdleMs: 5000,
        rewriteWarnTokens: 1000,
        onRewriteWarning: () => { warnFired = true },
      },
    })

    setPriv(sdk, 'keepaliveLastRealActivityAt', Date.now() - 500) // well within normal cadence
    const max = priv<Map<string, number>>(sdk, 'lastKnownCacheTokensByModel')
    max.set('claude-opus-4-7', 50000)

    const check = Object.getPrototypeOf(sdk).checkRewriteGuard.bind(sdk)
    check('claude-opus-4-7')

    expect(warnFired).toBe(false)
  })

  test('does NOT warn on first-ever request (no baseline yet)', () => {
    let warnFired = false
    const sdk = mkSDK({
      keepalive: {
        rewriteWarnIdleMs: 1,
        rewriteWarnTokens: 1,
        onRewriteWarning: () => { warnFired = true },
      },
    })

    // keepaliveLastRealActivityAt = 0 (never set) — first request bypass
    const check = Object.getPrototypeOf(sdk).checkRewriteGuard.bind(sdk)
    check('claude-opus-4-7')

    expect(warnFired).toBe(false)
  })

  test('throws CacheRewriteBlockedError when rewriteBlockEnabled=true and idle > blockIdleMs', () => {
    const sdk = mkSDK({
      keepalive: {
        rewriteWarnIdleMs: 500,
        rewriteWarnTokens: 1000,
        rewriteBlockIdleMs: 1000,
        rewriteBlockEnabled: true,
      },
    })

    setPriv(sdk, 'keepaliveLastRealActivityAt', Date.now() - 2000)
    const max = priv<Map<string, number>>(sdk, 'lastKnownCacheTokensByModel')
    max.set('claude-opus-4-7', 50000)

    const check = Object.getPrototypeOf(sdk).checkRewriteGuard.bind(sdk)
    expect(() => check('claude-opus-4-7')).toThrow(CacheRewriteBlockedError)
  })

  test('does NOT throw when rewriteBlockEnabled=false (even if idle exceeds threshold)', () => {
    const sdk = mkSDK({
      keepalive: {
        rewriteWarnIdleMs: 500,
        rewriteWarnTokens: 1000,
        rewriteBlockIdleMs: 1000,
        rewriteBlockEnabled: false,
      },
    })

    setPriv(sdk, 'keepaliveLastRealActivityAt', Date.now() - 2000)
    const max = priv<Map<string, number>>(sdk, 'lastKnownCacheTokensByModel')
    max.set('claude-opus-4-7', 50000)

    const check = Object.getPrototypeOf(sdk).checkRewriteGuard.bind(sdk)
    expect(() => check('claude-opus-4-7')).not.toThrow()
  })
})

// ─── Layer 4: Disarm not kill ────────────────────────────────────

describe('KA Layer 4: disarm-not-kill lifecycle', () => {
  test('onKeepaliveDisarmed keeps timer alive and fires onDisarmed callback', () => {
    // Contract: onKeepaliveDisarmed aborts in-flight + clears retry timer + fires callback.
    // Registry-clearing is caller responsibility (keepaliveTick / keepaliveRetryChain),
    // so this test verifies only what onKeepaliveDisarmed itself guarantees.
    let disarmedInfo: { reason: string; at: number } | null = null
    const sdk = mkSDK({
      keepalive: { onDisarmed: (info) => { disarmedInfo = info } },
    })

    // Start KA timer — pre-seed registry so startKeepaliveTimer doesn't no-op
    const reg = priv<Map<string, any>>(sdk, 'keepaliveRegistry')
    reg.set('test', { body: {}, headers: {}, model: 'test', inputTokens: 5000 })
    const start = Object.getPrototypeOf(sdk).startKeepaliveTimer.bind(sdk)
    start()
    const timerBefore = priv(sdk, 'keepaliveTimer')
    expect(timerBefore).not.toBeNull()

    // Simulate the caller pattern: caller clears registry FIRST, then invokes disarm
    reg.clear()
    const disarm = Object.getPrototypeOf(sdk).onKeepaliveDisarmed.bind(sdk)
    disarm('retry_exhausted')

    // Timer still alive — this is the "disarm not kill" contract
    const timerAfter = priv(sdk, 'keepaliveTimer')
    expect(timerAfter).toBe(timerBefore)
    // Callback fired with reason
    expect(disarmedInfo).not.toBeNull()
    expect(disarmedInfo!.reason).toBe('retry_exhausted')
    // In-flight state cleaned
    expect(priv(sdk, 'keepaliveInFlight')).toBe(false)
    expect(priv(sdk, 'keepaliveAbortController')).toBeNull()

    // Cleanup
    sdk.stopKeepalive()
  })

  test('stopKeepalive() fully clears timer (explicit shutdown)', () => {
    const sdk = mkSDK()
    const reg = priv<Map<string, any>>(sdk, 'keepaliveRegistry')
    reg.set('x', { body: {}, headers: {}, model: 'x', inputTokens: 5000 })

    const start = Object.getPrototypeOf(sdk).startKeepaliveTimer.bind(sdk)
    start()
    expect(priv(sdk, 'keepaliveTimer')).not.toBeNull()

    sdk.stopKeepalive()
    expect(priv(sdk, 'keepaliveTimer')).toBeNull()
    expect(reg.size).toBe(0)
  })
})

// ─── Public API surface (refactor must preserve) ─────────────────

describe('KA public API surface (for opencode-claude plugin compatibility)', () => {
  test('stopKeepalive() is a public method', () => {
    const sdk = mkSDK()
    expect(typeof sdk.stopKeepalive).toBe('function')
  })

  test('getRateLimitInfo() returns RateLimitInfo', () => {
    const sdk = mkSDK()
    const info = sdk.getRateLimitInfo()
    expect(info).toBeDefined()
    expect(info).toHaveProperty('status')
  })

  test('CacheRewriteBlockedError exists and has expected shape', () => {
    const err = new CacheRewriteBlockedError(5000, 50000, 'claude-opus-4-7')
    expect(err.name).toBe('CacheRewriteBlockedError')
    expect(err.code).toBe('CACHE_REWRITE_BLOCKED')
    expect(err.idleMs).toBe(5000)
    expect(err.estimatedTokens).toBe(50000)
    expect(err.model).toBe('claude-opus-4-7')
  })

  test('keepalive config accepts all documented callbacks without throwing', () => {
    expect(() => mkSDK({
      keepalive: {
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
      },
    })).not.toThrow()
  })
})
