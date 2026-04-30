/**
 * SDK-level KA regression — public API surface only.
 *
 * After the KeepaliveEngine extraction (src/keepalive-engine.ts), the 7-layer
 * defense-stack invariants are tested directly against the engine in
 * test/keepalive-engine.test.ts (16 tests — heaviest-wins, rewrite guard,
 * interval clamp, lifecycle).
 *
 * This file ensures the SDK's PUBLIC API contract stays intact, so existing
 * consumers (opencode-claude plugin, claude-max-provider, etc.) keep working
 * without changes.
 */

// Test isolation via bunfig.toml preload (see test/_setup-keepalive-fixture.ts).

import { describe, test, expect } from 'bun:test'
import { ClaudeCodeSDK, MemoryCredentialStore } from '../src/sdk.js'
import { CacheRewriteBlockedError } from '../src/types.js'

function mkSDK(overrides: Parameters<typeof ClaudeCodeSDK>[0] = {}) {
  const store = new MemoryCredentialStore({
    accessToken: 'fake-access-token',
    refreshToken: 'fake-refresh-token',
    expiresAt: Date.now() + 8 * 3600_000,
  })
  return new ClaudeCodeSDK({
    credentialStore: store,
    accountUuid: 'test-uuid',
    deviceId: 'test-device',
    ...overrides,
  })
}

describe('SDK KA public API surface', () => {
  test('constructor accepts all documented KeepaliveConfig callbacks', () => {
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

  test('stopKeepalive() is public and callable', () => {
    const sdk = mkSDK()
    expect(typeof sdk.stopKeepalive).toBe('function')
    expect(() => sdk.stopKeepalive()).not.toThrow()
  })

  test('getRateLimitInfo() returns RateLimitInfo shape', () => {
    const sdk = mkSDK()
    const info = sdk.getRateLimitInfo()
    expect(info).toBeDefined()
    expect(info).toHaveProperty('status')
    expect(info).toHaveProperty('utilization5h')
    expect(info).toHaveProperty('utilization7d')
    sdk.stopKeepalive()
  })

  test('CacheRewriteBlockedError still exported from types.ts', () => {
    const err = new CacheRewriteBlockedError(5000, 50000, 'claude-opus-4-7')
    expect(err.name).toBe('CacheRewriteBlockedError')
    expect(err.code).toBe('CACHE_REWRITE_BLOCKED')
    expect(err.idleMs).toBe(5000)
    expect(err.estimatedTokens).toBe(50000)
    expect(err.model).toBe('claude-opus-4-7')
  })

  test('SDK with keepalive=undefined still constructs (engine uses defaults)', () => {
    expect(() => mkSDK()).not.toThrow()
  })

  test('SDK with clamped intervals does not throw', () => {
    expect(() => mkSDK({ keepalive: { intervalMs: 30_000 } })).not.toThrow()   // clamps to 60s
    expect(() => mkSDK({ keepalive: { intervalMs: 500_000 } })).not.toThrow()  // clamps to 240s
  })
})
