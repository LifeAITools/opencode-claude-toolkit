/**
 * @life-ai-tools/opencode-signal-wire
 *
 * Signal-wire + wake-listener infrastructure for opencode plugins.
 * Extracted from @life-ai-tools/opencode-claude for single-responsibility.
 *
 * Contains:
 *   - SignalWire adapter (over @kiberos/signal-wire-core)
 *   - Wake event listener (cross-process agent coordination)
 *   - Wake preferences (global/per-project subscription config)
 *   - Wake TUI component
 *
 * This package has NO dependency on claude-code-sdk or claude-max-proxy —
 * it's purely about opencode agent coordination.
 */

export { SignalWire } from './signal-wire'
export type { HookEvent, SignalWireContext } from './signal-wire'

export {
  startWakeListener,
  stopWakeListener,
  getAgentIdentity,
  getSpawnActive,
  getSpawnTotal,
  helperStarted,
  helperFinished,
  resolveCurrentDepth,
  checkSpawnAllowed,
} from './wake-listener'
export type { WakeListenerHandle } from './wake-listener'

export { loadPreferences, computeSubscribe } from './wake-preferences'

export type { WakeEvent } from './wake-types'
export { DISCOVERY_DIR, WAKE_EVENT_TYPES, WARM_CHANNEL_TTL_MS } from './wake-types'

// ─── Identity error bridge (for TUI status display) ─────────────
//
// tui.tsx reads identity-resolution errors for status display. The actual
// identity resolution happens in opencode-claude's OAuth flow (outside this
// package). This provides a shared slot that opencode-claude writes to and
// tui.tsx reads from.
//
// Cross-package mutation is ugly but matches the pre-extraction behavior.
// Proper fix: pass error as a prop to TUI component. Left for future cleanup.

let _identityError: string | null = null

export function getIdentityError(): string | null { return _identityError }
export function setIdentityError(err: string | null): void { _identityError = err }
