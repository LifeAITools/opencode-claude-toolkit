/**
 * correlation-id — 12-char base32 IDs for spawn-flow tracing.
 *
 * Every spawn flow gets ONE correlation_id generated at the FIRST entry
 * point (CEO hire call OR context project start). It propagates via:
 *   - SynqTask member.metadata.spawn_correlation_id (set on hire)
 *   - wake-router wake event payload.correlation_id
 *   - child opencode env var SW_SPAWN_CORRELATION_ID (set by tmux launcher)
 *   - boot-audit + spawn-audit rows (correlation_id field, REQUIRED)
 *
 * Operators grep ONE ID across all logs to reconstruct full flow.
 *
 * Closes: G-A7 (ERROR-A, AD-11), CR-A3.
 */

import { randomBytes } from 'node:crypto'
import { CORRELATION_ID_LENGTH, CORRELATION_ID_ENV_VAR } from '../domain-constants'

// RFC 4648 base32 alphabet (no padding, easier to grep — no `+/=`)
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Generate a fresh 12-char base32 correlation ID (≈60 bits entropy).
 * ASCII-safe, grep-safe (no special regex chars).
 */
export function generateCorrelationId(): string {
  const bytes = randomBytes(CORRELATION_ID_LENGTH)
  let out = ''
  for (let i = 0; i < CORRELATION_ID_LENGTH; i++) {
    out += ALPHABET[bytes[i]! % 32]
  }
  return out
}

/**
 * Build env var mapping for child process (mutates a copy of input).
 * Caller spreads this into the child's env.
 */
export function propagateCorrelationId(parentEnv: Record<string, string | undefined>, id: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v !== undefined) out[k] = v
  }
  out[CORRELATION_ID_ENV_VAR] = id
  return out
}

/**
 * Read inherited correlation_id from process env (set by parent process).
 * Returns undefined when run as a root entry-point (no parent).
 */
export function readInheritedCorrelationId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[CORRELATION_ID_ENV_VAR]
  if (typeof v === 'string' && /^[A-Z2-7]{12}$/.test(v)) return v
  return undefined
}

/**
 * Resolve correlation_id for current spawn: inherited (if present) OR fresh.
 * Use this at every entry point to guarantee consistent tracing.
 */
export function resolveOrGenerateCorrelationId(env: NodeJS.ProcessEnv = process.env): string {
  return readInheritedCorrelationId(env) ?? generateCorrelationId()
}
