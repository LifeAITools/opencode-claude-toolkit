/**
 * Session-scoped cache-rewrite consent grants.
 *
 * The rewrite guard's primary consent channel is the `overrideMarker`
 * (`[%cache-rewrite-ok%]`) in the LATEST user message. That works for an
 * interactive human or an LLM agent that controls its next message text — but
 * NOT for consumers that cannot inject message text at the moment of the block:
 *   - a tool-loop continuation (the latest message is a `tool_result`),
 *   - a programmatic endpoint client (OpenAI-compat / external Anthropic-API),
 *   - an out-of-band actor (an orchestrator deciding for a sub-agent).
 *
 * This module is the SECOND consent channel: a small JSON file of short-TTL,
 * single-use grants keyed by sessionId. Any actor that can run a CLI / write a
 * file can grant consent for a session (`context cache-rewrite-ok <sessionId>`);
 * the proxy consumes the grant on the next proceeding rewrite. This is what
 * makes "block for ALL consumers" actionable rather than a dead end.
 *
 * Design mirrors the established per-session JSON-store pattern in this package
 * (loadPrefixHistory/savePrefixHistory in proxy-client.ts, ka-snapshot-store.ts):
 * best-effort, never throws, TTL-pruned on load. Unlike prefix-history this is
 * NOT held in an in-memory hot cache — it is read fresh on each consume so an
 * EXTERNAL writer (the CLI) is picked up immediately. The consume path runs only
 * when an avoidable rewrite ≥ threshold is predicted (rare), so the tiny
 * synchronous file read is on a cold path.
 */

import { readFileSync, writeFileSync } from 'fs'

/** One consent grant. `ttlMs` is captured at grant time so a config change does
 *  not retroactively extend or shorten already-issued grants. */
export interface ConsentGrant {
  grantedAt: number
  ttlMs: number
}

export type ConsentGrants = Record<string, ConsentGrant>

/** Read + prune expired grants. Never throws — missing/corrupt → empty. */
export function loadConsentGrants(path: string, now: number = Date.now()): ConsentGrants {
  const out: ConsentGrants = {}
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<ConsentGrant>>
    for (const [sid, g] of Object.entries(raw)) {
      if (g && typeof g.grantedAt === 'number' && typeof g.ttlMs === 'number'
          && g.grantedAt + g.ttlMs > now) {
        out[sid] = { grantedAt: g.grantedAt, ttlMs: g.ttlMs }
      }
    }
  } catch { /* missing or corrupt → no grants */ }
  return out
}

/** Best-effort write — never breaks the request path. */
function saveConsentGrants(path: string, grants: ConsentGrants): void {
  try {
    writeFileSync(path, JSON.stringify(grants))
  } catch { /* swallow — consent is advisory infra, must not throw */ }
}

/**
 * Issue a single-use consent grant for `sessionId`. Used by the CLI/command
 * path (and tests). Prunes expired entries while it's loaded.
 */
export function grantConsent(path: string, sessionId: string, ttlMs: number, now: number = Date.now()): void {
  const grants = loadConsentGrants(path, now)
  grants[sessionId] = { grantedAt: now, ttlMs }
  saveConsentGrants(path, grants)
}

/**
 * Consume a valid grant for `sessionId`. Returns true (and DELETES the grant —
 * single-use, fresh-consent) iff an unexpired grant exists; false otherwise.
 * Call ONLY on the proceed path — a blocked request must NOT consume a grant it
 * never had, and a guard-blocked request returns before reaching consume.
 */
export function consumeConsent(path: string, sessionId: string, now: number = Date.now()): boolean {
  const grants = loadConsentGrants(path, now)
  if (!grants[sessionId]) return false
  delete grants[sessionId]
  saveConsentGrants(path, grants)
  return true
}

/** Non-destructive check — does an unexpired grant exist? (For logging/preview;
 *  the block decision must use {@link consumeConsent} so consent is single-use.) */
export function hasConsent(path: string, sessionId: string, now: number = Date.now()): boolean {
  return !!loadConsentGrants(path, now)[sessionId]
}
