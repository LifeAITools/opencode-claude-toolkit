/**
 * T16 — Bridge unit tests for token-rotation-bridge.
 *
 * Covers:
 *   - createContextTokensProvider: source/method shape, throw-safe, NaN guard.
 *   - createTokenRotationEmitter: CR-02 same-org filter; enrichment fields
 *     (`forcedReasonSuffix`, `actionHint`); per-mode actionHint via observed
 *     emitter output (the internal `actionHintFor` is NOT exported, so we
 *     verify its behavior through the emitter wrapper).
 *   - setBoundSdk / getBoundSdk: module-level registry roundtrip.
 *
 * No production code is modified; tests are self-contained and clean up
 * the SDK registry after each test.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import {
  createContextTokensProvider,
  createTokenRotationEmitter,
  setBoundSdk,
  getBoundSdk,
  type SignalWireEmitFn,
  type TokenRotationSdkSurface,
} from './token-rotation-bridge'
import type { TokenRotatedPayload } from '@kiberos/signal-wire-core'

/** Capture object for SignalWireEmit invocations. */
interface EmittedEvent {
  type: string
  payload: Record<string, unknown>
  sessionId: string | null
}

function makeSpy(): { emit: SignalWireEmitFn; calls: EmittedEvent[] } {
  const calls: EmittedEvent[] = []
  const emit: SignalWireEmitFn = (e) => {
    calls.push({ type: e.type, payload: e.payload, sessionId: e.sessionId })
  }
  return { emit, calls }
}

/** Base canonical payload — tests override fields per case. */
function basePayload(overrides: Partial<TokenRotatedPayload> = {}): TokenRotatedPayload {
  return {
    pid: 12345,
    spawnDepth: 0,
    sessionId: null,
    oldHint: 'OLDHINT_',
    newHint: 'NEWHINT_',
    oldOrgId: 'org-old',
    newOrgId: 'org-new',
    contextTokens: 50_000,
    mode: 'applied',
    appliedAt: 'immediate',
    forcedReason: null,
    detectedAt: '2026-05-09T12:00:00.000Z',
    ...overrides,
  }
}

// ──────────────────────────────────────────────────────────────
// createContextTokensProvider
// ──────────────────────────────────────────────────────────────

describe('createContextTokensProvider: source semantics', () => {
  test('valid number from source → returned as-is', () => {
    const provider = createContextTokensProvider({ getContextPosition: () => 12_345 })
    expect(provider()).toBe(12_345)
  })

  test('NaN return → null (Number.isFinite guard)', () => {
    const provider = createContextTokensProvider({ getContextPosition: () => Number.NaN })
    expect(provider()).toBeNull()
  })

  test('Infinity return → null (Number.isFinite guard)', () => {
    const provider = createContextTokensProvider({
      getContextPosition: () => Number.POSITIVE_INFINITY,
    })
    expect(provider()).toBeNull()
  })

  test('zero → null (treated as uninitialized snapshot)', () => {
    const provider = createContextTokensProvider({ getContextPosition: () => 0 })
    expect(provider()).toBeNull()
  })

  test('null source → null', () => {
    const provider = createContextTokensProvider(null)
    expect(provider()).toBeNull()
  })

  test('undefined source → null', () => {
    const provider = createContextTokensProvider(undefined)
    expect(provider()).toBeNull()
  })

  test('source missing getContextPosition method → null', () => {
    const provider = createContextTokensProvider({} as any)
    expect(provider()).toBeNull()
  })

  test('throwing source → null (NFR-08 fail-open)', () => {
    const provider = createContextTokensProvider({
      getContextPosition: () => {
        throw new Error('boom')
      },
    })
    expect(provider()).toBeNull()
  })
})

// ──────────────────────────────────────────────────────────────
// createTokenRotationEmitter
// ──────────────────────────────────────────────────────────────

describe('createTokenRotationEmitter: CR-02 same-org filter', () => {
  test('mode=same-org → signalWireEmit NOT called (silent at signal-wire level)', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-1', 0, emit)
    wrapped(basePayload({ mode: 'same-org', appliedAt: 'immediate' }))
    expect(calls).toHaveLength(0)
  })
})

describe('createTokenRotationEmitter: enrichment for non-same-org', () => {
  test('mode=deferred → emits once with empty forcedReasonSuffix + deferred hint', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-deferred', 2, emit)
    wrapped(
      basePayload({
        mode: 'deferred',
        appliedAt: null,
        forcedReason: null,
        contextTokens: 200_000,
      }),
    )
    expect(calls).toHaveLength(1)
    const ev = calls[0]!
    expect(ev.type).toBe('token.rotated')
    expect(ev.sessionId).toBe('sess-deferred')
    expect(ev.payload.forcedReasonSuffix).toBe('')
    expect(ev.payload.actionHint).toBe('Will apply on your next message or token expiry')
    // Original fields are preserved in enriched payload.
    expect(ev.payload.mode).toBe('deferred')
    expect(ev.payload.oldHint).toBe('OLDHINT_')
    expect(ev.payload.newHint).toBe('NEWHINT_')
    // Bridge overrides session/spawn from the SDK's defaults.
    expect(ev.payload.sessionId).toBe('sess-deferred')
    expect(ev.payload.spawnDepth).toBe(2)
  })

  test('mode=forced + forcedReason=old-token-expired → suffix ": old-token-expired" + forced hint', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-forced', 0, emit)
    wrapped(
      basePayload({
        mode: 'forced',
        appliedAt: 'forced-expired',
        forcedReason: 'old-token-expired',
      }),
    )
    expect(calls).toHaveLength(1)
    const ev = calls[0]!
    expect(ev.payload.forcedReasonSuffix).toBe(': old-token-expired')
    expect(ev.payload.actionHint).toBe('Old token dead — auto-switched')
    expect(ev.payload.forcedReason).toBe('old-token-expired')
  })

  test('mode=applied + appliedAt=turn-boundary → suffix empty + turn-boundary hint', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-tb', 0, emit)
    wrapped(basePayload({ mode: 'applied', appliedAt: 'turn-boundary' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload.forcedReasonSuffix).toBe('')
    expect(calls[0]!.payload.actionHint).toBe('Switched at turn boundary')
  })

  test('mode=applied + appliedAt=context-drop → context-drop hint', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-cd', 0, emit)
    wrapped(basePayload({ mode: 'applied', appliedAt: 'context-drop' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload.actionHint).toBe('Switched after context dropped')
  })

  test('mode=applied + appliedAt=immediate → "switched immediately" hint', () => {
    const { emit, calls } = makeSpy()
    const wrapped = createTokenRotationEmitter('sess-im', 0, emit)
    wrapped(basePayload({ mode: 'applied', appliedAt: 'immediate' }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.payload.actionHint).toBe('Switched immediately')
  })

  test('throwing emit fn does NOT propagate (NFR-08 fail-open)', () => {
    const throwingEmit: SignalWireEmitFn = () => {
      throw new Error('downstream broken')
    }
    const wrapped = createTokenRotationEmitter('sess-throw', 0, throwingEmit)
    // Wrapped emitter must swallow the error.
    expect(() => wrapped(basePayload({ mode: 'applied', appliedAt: 'immediate' }))).not.toThrow()
  })
})

// ──────────────────────────────────────────────────────────────
// setBoundSdk / getBoundSdk registry
// ──────────────────────────────────────────────────────────────

describe('setBoundSdk / getBoundSdk: module-level registry roundtrip', () => {
  afterEach(() => {
    // Clear after each test to avoid cross-test contamination.
    setBoundSdk(null)
  })

  test('starts at null when no SDK has been bound (or after reset)', () => {
    setBoundSdk(null)
    expect(getBoundSdk()).toBeNull()
  })

  test('setBoundSdk(sdk) → getBoundSdk() returns same reference', () => {
    const fakeSdk: TokenRotationSdkSurface = {
      tokenRotation: {
        setEventEmitter: () => {},
        hasPending: () => false,
        applyPending: async () => {},
      },
    }
    setBoundSdk(fakeSdk)
    expect(getBoundSdk()).toBe(fakeSdk)
  })

  test('setBoundSdk(null) clears the registry', () => {
    const fakeSdk: TokenRotationSdkSurface = {
      tokenRotation: { setEventEmitter: () => {} },
    }
    setBoundSdk(fakeSdk)
    expect(getBoundSdk()).toBe(fakeSdk)
    setBoundSdk(null)
    expect(getBoundSdk()).toBeNull()
  })

  test('last-writer-wins: second setBoundSdk overrides the first', () => {
    const sdkA: TokenRotationSdkSurface = {
      tokenRotation: { setEventEmitter: () => {} },
    }
    const sdkB: TokenRotationSdkSurface = {
      tokenRotation: { setEventEmitter: () => {} },
    }
    setBoundSdk(sdkA)
    setBoundSdk(sdkB)
    expect(getBoundSdk()).toBe(sdkB)
  })
})
