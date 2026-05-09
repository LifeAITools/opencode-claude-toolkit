/**
 * Token Rotation Bridge — opencode-signal-wire ↔ claude-code-sdk integration.
 *
 * Glue layer between the SDK's `TokenRotationManager` (per-pid auth state
 * machine, owned by `claude-code-sdk/src/token-rotation.ts`) and the
 * signal-wire rule engine (this package). T13 from the
 * `token-rotation-deferred-apply` PRP.
 *
 * Three concerns:
 *
 *   1. **contextTokensProvider** (REQ-03): SDK needs a sync `() => number | null`
 *      reader for its decision gate. The signal-wire engine already tracks
 *      context position via `trackTokens()` (per-pid). We adapt the engine's
 *      `getContextPosition()` into the SDK's required shape.
 *
 *   2. **TokenRotated event emitter** (CR-02 + CR-07): `TokenRotationManager`
 *      emits canonical `TokenRotatedPayload` via a callback registered with
 *      `setEventEmitter()`. We register an adapter that:
 *        a. **Drops `mode='same-org'` events** before further signal-wire
 *           emit (CR-02 — these are silent in TUI; audit log already
 *           captured the event inside the manager).
 *        b. **Enriches the payload** with two synthetic fields the
 *           `token-rotation-banner` rule template requires:
 *             - `forcedReasonSuffix` — `": " + forcedReason` for forced
 *               mode, `""` otherwise. Keeps the rule template simple.
 *             - `actionHint` — mode-specific UX text rendered in the banner.
 *        c. Routes the enriched event to a caller-supplied emit function
 *           (typically `signalWire.evaluateHook` constructing a
 *           `SignalWireEvent` of type `token.rotated`).
 *
 *   3. **Turn-boundary apply** (REQ-08 / CR-04): when a `chat.message` hook
 *      fires (user sent new prompt), if the SDK has a pending deferred
 *      rotation, this is the consent-signal to apply it BEFORE the next API
 *      request. Because the SDK lives in `opencode-claude` and the hook
 *      lives here, we use a small module-level SDK registry: opencode-claude
 *      calls `setBoundSdk(sdk)` after construction; the chat.message
 *      handler in `plugin.ts` reads it via `getBoundSdk()`. Mirrors the
 *      `_identityError` pattern already established in `index.ts`.
 *
 * Constraints (from PRP):
 *
 *   - **NO npm dependencies added** — uses only `@kiberos/signal-wire-core`
 *     (already a dep) for the `TokenRotatedPayload` canonical type.
 *   - **NO direct import of claude-code-sdk** — duck-types `tokenRotation`
 *     surface to keep package boundaries clean (the SDK class lives in
 *     `@life-ai-tools/claude-code-sdk` which is NOT a dep of this package).
 *   - **Fail-open** (NFR-08): bridge errors must not propagate into the
 *     SDK rotation flow or the chat.message hook.
 *   - **Sync contract** (REQ-03): contextTokensProvider must NOT return a
 *     Promise; throws → null; undefined → null.
 */

import type { TokenRotatedPayload } from '@kiberos/signal-wire-core'

// ──────────────────────────────────────────────────────────────
// Helper 1: contextTokensProvider adapter
// ──────────────────────────────────────────────────────────────

/**
 * Source for context-token snapshot reads. Structural type so we can
 * adapt either the signal-wire engine (`getContextPosition()`) or any
 * other reader without naming it explicitly. Keeps the bridge decoupled
 * from `SignalWire`'s concrete class shape.
 */
export interface ContextTokensSource {
  /**
   * Return the current per-pid context-token count, or 0/falsy when
   * nothing tracked yet. Signal-wire's `SignalWire.getContextPosition()`
   * matches this shape.
   */
  getContextPosition?: () => number
}

/**
 * Build the sync `() => number | null` reader required by
 * `ClaudeCodeSDK`'s `contextTokensProvider` constructor option (REQ-03).
 *
 * Contract:
 *   - Source missing OR method missing → null.
 *   - Method throws → null (fail-open per NFR-08).
 *   - Returned value is non-finite, NaN, or ≤ 0 → null (uninitialized
 *     snapshot — SDK should treat as "unknown context" per CR-09).
 *   - Otherwise → the integer token count.
 *
 * The SDK's `TokenRotationManager` has its own throttle for repeated
 * provider failures (`contextProviderThrew`) — we can throw all we want
 * inside the adapter without spamming logs.
 */
export function createContextTokensProvider(
  source: ContextTokensSource | null | undefined,
): () => number | null {
  return () => {
    if (!source?.getContextPosition) return null
    try {
      const tokens = source.getContextPosition()
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return null
      // Treat 0 as "no snapshot yet" — engine initializes contextPosition
      // to 0 before first trackTokens(). SDK's CR-09 handling: null →
      // small-context (apply path). Here, 0 means "we genuinely don't
      // know the context size yet" which is the same fail-safe.
      return tokens > 0 ? tokens : null
    } catch {
      return null
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Helper 2: TokenRotated event emitter adapter
// ──────────────────────────────────────────────────────────────

/**
 * Shape of the per-emit signal-wire dispatch function. The bridge stays
 * agnostic about engine internals — caller decides whether the event
 * goes through `signalWire.evaluateHook`, a state-file write, or a test
 * stub. Common production shape:
 *
 *   ```ts
 *   const signalWireEmit = (e) => {
 *     void signalWire.evaluateHook({
 *       source: 'sdk',
 *       type: e.type,
 *       sessionId: e.sessionId,
 *       payload: e.payload,
 *     }).catch(() => { /* fail-open *\/ })
 *   }
 *   ```
 *
 * Returning `void` (not Promise<void>) underscores the fire-and-forget
 * semantics: rotation flow MUST NOT block on emit (NFR-08).
 */
export type SignalWireEmitFn = (event: {
  type: string
  payload: Record<string, unknown>
  sessionId: string | null
}) => void

/**
 * Build the `(payload: TokenRotatedPayload) => void` callback registered
 * with `TokenRotationManager.setEventEmitter()`.
 *
 *   - `mode='same-org'` events are dropped here (CR-02). The audit log
 *     entry was already written inside `TokenRotationManager.emitEvent`
 *     before we were called, so dropping the signal-wire emit only
 *     suppresses the cross-pid TUI banner — exactly the desired
 *     behavior (same-org rotation is invisible to the user).
 *
 *   - For non-same-org events, we enrich with two synthetic fields the
 *     `token-rotation-banner` rule template embeds:
 *
 *       * `forcedReasonSuffix`: `": old-token-expired"` (etc.) for forced
 *         mode, `""` for all others. Keeps the rule's `text` template
 *         clean — no conditional rendering required server-side.
 *
 *       * `actionHint`: mode-specific UX line. See `actionHintFor`.
 *
 *   - We also fill `sessionId` and `spawnDepth` from bridge-side context
 *     when the SDK didn't have them (the SDK has no idea about opencode
 *     sessions or wake-listener depth tracking).
 *
 *   - All errors swallowed (NFR-08): a bridge bug must NEVER propagate
 *     into the SDK's rotation state machine. Failures here only mean
 *     the banner doesn't render — rotation still completes correctly.
 */
export function createTokenRotationEmitter(
  sessionId: string | null,
  spawnDepth: number,
  signalWireEmit: SignalWireEmitFn,
): (payload: TokenRotatedPayload) => void {
  return (payload) => {
    // CR-02: same-org rotation is silent at the signal-wire level.
    // Audit log already captured this event inside TokenRotationManager.
    if (payload.mode === 'same-org') return

    try {
      const enriched: Record<string, unknown> = {
        ...payload,
        // SDK doesn't know opencode session context; bridge does.
        sessionId: sessionId ?? payload.sessionId,
        spawnDepth: spawnDepth ?? payload.spawnDepth,
        forcedReasonSuffix: payload.forcedReason ? `: ${payload.forcedReason}` : '',
        actionHint: actionHintFor(payload),
      }
      signalWireEmit({
        type: 'token.rotated',
        payload: enriched,
        sessionId: sessionId ?? payload.sessionId,
      })
    } catch {
      // NFR-08 fail-open: bridge errors must not propagate into the
      // SDK rotation flow. A failed emit only loses the banner — the
      // audit log entry is already persisted.
    }
  }
}

/**
 * UX-friendly mode descriptor for the banner. Kept as a separate function
 * so bridge unit tests can assert each mode/appliedAt branch without
 * spinning up a full TokenRotationManager.
 *
 * Decision matrix mirrors the `appliedAt` enum in the canonical payload:
 *   - deferred                  → "next message or expiry"
 *   - forced                    → "old token dead"
 *   - applied + turn-boundary   → "switched at turn boundary"
 *   - applied + context-drop    → "switched after context dropped"
 *   - applied + immediate (or null appliedAt) → "switched immediately"
 *   - same-org never reaches here (filtered above) — fallback empty.
 */
function actionHintFor(payload: TokenRotatedPayload): string {
  if (payload.mode === 'deferred') {
    return 'Will apply on your next message or token expiry'
  }
  if (payload.mode === 'forced') {
    return 'Old token dead — auto-switched'
  }
  if (payload.mode === 'applied') {
    if (payload.appliedAt === 'turn-boundary') return 'Switched at turn boundary'
    if (payload.appliedAt === 'context-drop') return 'Switched after context dropped'
    return 'Switched immediately'
  }
  return ''
}

// ──────────────────────────────────────────────────────────────
// Helper 3: wire entry point
// ──────────────────────────────────────────────────────────────

/**
 * Minimal structural type for the SDK we wire — duck-typed so this
 * package needs no import of `@life-ai-tools/claude-code-sdk` (per CR-10
 * and the package-boundary constraint).
 *
 * We capture only the surface the bridge actually uses:
 *   - `setEventEmitter` — register our enricher (this task).
 *   - `hasPending` / `applyPending` — turn-boundary apply (read by the
 *     plugin's chat.message hook via `getBoundSdk`).
 */
export interface TokenRotationSdkSurface {
  tokenRotation: {
    setEventEmitter: (emit: (p: TokenRotatedPayload) => void) => void
    hasPending?: () => boolean
    applyPending?: (
      reason: 'turn-boundary' | 'context-drop' | 'forced-expired',
      forcedReason?: 'old-token-expired' | 'old-refresh-failed' | 'old-api-rejected',
    ) => Promise<void>
  }
}

/**
 * Single entry point called by the SDK consumer (typically
 * `opencode-claude/provider.ts`) immediately after constructing a
 * `ClaudeCodeSDK` instance.
 *
 * Connects:
 *   1. TokenRotationManager → our enricher via `setEventEmitter`.
 *   2. Registers the SDK in this module's registry so `plugin.ts`
 *      `chat.message` hook can fetch it for turn-boundary apply.
 *
 * The `contextTokensProvider` was already passed via the SDK constructor
 * options (set up at SDK construction time, NOT here — once the manager
 * is built, the provider can't be swapped).
 *
 * Idempotent on repeated calls for the same SDK; later calls overwrite
 * the registered SDK reference (last-writer-wins) — matches the
 * single-active-SDK-per-pid invariant in the PRP (DB-05).
 */
export function wireTokenRotation(
  sdk: TokenRotationSdkSurface,
  sessionId: string | null,
  spawnDepth: number,
  signalWireEmit: SignalWireEmitFn,
): void {
  const emitter = createTokenRotationEmitter(sessionId, spawnDepth, signalWireEmit)
  sdk.tokenRotation.setEventEmitter(emitter)
  setBoundSdk(sdk)
}

// ──────────────────────────────────────────────────────────────
// SDK registry (cross-package coupling)
// ──────────────────────────────────────────────────────────────
//
// The chat.message hook lives in this package's plugin.ts; the SDK
// instance lives in opencode-claude. The cleanest cross-package handoff
// without adding a direct dependency is a module-level registry —
// established precedent in `index.ts` (`_identityError` setter/getter).
//
// Lifetime: process-scoped. opencode-claude calls `setBoundSdk(sdk)`
// during its server() init; opencode shutdown clears the reference.
// In tests, callers should call `setBoundSdk(null)` in afterEach to
// avoid cross-test contamination.

let _boundSdk: TokenRotationSdkSurface | null = null

/**
 * Register the active SDK. Called by the SDK consumer (opencode-claude)
 * after constructing the `ClaudeCodeSDK` instance. Pass `null` to clear
 * (test teardown / SDK close path).
 */
export function setBoundSdk(sdk: TokenRotationSdkSurface | null): void {
  _boundSdk = sdk
}

/**
 * Retrieve the registered SDK. Returns null when no SDK is bound (e.g.
 * during early plugin startup before opencode-claude has finished its
 * own init, or when opencode-claude isn't installed). Callers MUST
 * tolerate null — a missing SDK means the chat.message hook silently
 * skips turn-boundary apply.
 */
export function getBoundSdk(): TokenRotationSdkSurface | null {
  return _boundSdk
}

// ──────────────────────────────────────────────────────────────
// SignalWire engine registry (cross-package contextTokensProvider)
// ──────────────────────────────────────────────────────────────
//
// Mirrors _boundSdk pattern. The signal-wire engine is created
// per-session inside this package's plugin.ts; opencode-claude's
// provider.ts builds the SDK with a `contextTokensProvider` that needs
// to read `engine.getContextPosition()` lazily (because the engine
// doesn't exist yet at SDK-construction time, only after the plugin's
// server hook fires). This registry bridges the gap.
//
// Lifetime: per-process. Last-writer-wins; new sessions overwrite the
// reference. Multi-session opencode serve mode is a known edge — for
// production, the SignalWireSource exposed here is whichever session
// most recently created its engine. Cross-session token-rotation
// decisions still work because TokenRotationManager state is per-pid
// (DB-05); only the context-tokens snapshot is potentially stale.

let _currentSignalWire: ContextTokensSource | null = null

/**
 * Register the active signal-wire engine. Called by plugin.ts'
 * server hook immediately after `createSignalWire(...)`. Pass `null`
 * to clear (test teardown).
 */
export function setCurrentSignalWire(engine: ContextTokensSource | null): void {
  _currentSignalWire = engine
}

/**
 * Retrieve the registered signal-wire engine for context-tokens reads.
 * Returns null when no engine is bound (e.g. before plugin server hook
 * fires, or when the package isn't loaded). Used by provider.ts to
 * build a lazy `contextTokensProvider` that resolves at SDK request
 * time, not at SDK construction time.
 */
export function getCurrentSignalWire(): ContextTokensSource | null {
  return _currentSignalWire
}

/**
 * Convenience: produce a `contextTokensProvider` callback for SDK
 * constructor that lazily resolves through the registry. Returns null
 * when no engine is bound (CR-09: SDK treats null as small-context →
 * apply path, fail-safe).
 */
export function createLazyContextTokensProvider(): () => number | null {
  return () => {
    const engine = _currentSignalWire
    if (!engine?.getContextPosition) return null
    try {
      const tokens = engine.getContextPosition()
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens <= 0) return null
      return tokens
    } catch {
      return null
    }
  }
}
