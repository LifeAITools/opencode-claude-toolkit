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
/** One consent grant. `ttlMs` is captured at grant time so a config change does
 *  not retroactively extend or shorten already-issued grants. */
export interface ConsentGrant {
    grantedAt: number;
    ttlMs: number;
}
export type ConsentGrants = Record<string, ConsentGrant>;
/** Read + prune expired grants. Never throws — missing/corrupt → empty. */
export declare function loadConsentGrants(path: string, now?: number): ConsentGrants;
/**
 * Issue a single-use consent grant for `sessionId`. Used by the CLI/command
 * path (and tests). Prunes expired entries while it's loaded.
 */
export declare function grantConsent(path: string, sessionId: string, ttlMs: number, now?: number): void;
/**
 * Consume a valid grant for `sessionId`. Returns true (and DELETES the grant —
 * single-use, fresh-consent) iff an unexpired grant exists; false otherwise.
 * Call ONLY on the proceed path — a blocked request must NOT consume a grant it
 * never had, and a guard-blocked request returns before reaching consume.
 */
export declare function consumeConsent(path: string, sessionId: string, now?: number): boolean;
/** Non-destructive check — does an unexpired grant exist? (For logging/preview;
 *  the block decision must use {@link consumeConsent} so consent is single-use.) */
export declare function hasConsent(path: string, sessionId: string, now?: number): boolean;
//# sourceMappingURL=rewrite-consent.d.ts.map