/**
 * The ONE place that names claude-max-debug.log.
 *
 * 🔴 WHY (2026-10-01): the path was spelled out at 39 call sites, so nothing could point it
 * elsewhere — and every `bun test` run appended hundreds of fake KA_* lines (KA_CLEAR_DIAG,
 * KA_FIRE_EVICTION_DETECTED, TOKEN_ROTATION…) into the LIVE log that night-time incident
 * analysis reads. A neighbour counted them while reconstructing the 01.10 cache deaths.
 * Tests now set CLAUDE_MAX_DEBUG_LOG in their preload; production leaves it unset.
 *
 * Read on every call, not at import: a test preload sets the variable before modules load,
 * but a reader frozen at import would silently keep the live path if the order ever changed.
 */
import { homedir } from 'os'
import { join } from 'path'

export function debugLogPath(): string {
  return process.env.CLAUDE_MAX_DEBUG_LOG || join(homedir(), '.claude', 'claude-max-debug.log')
}
