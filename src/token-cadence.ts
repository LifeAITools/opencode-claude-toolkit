/**
 * token-cadence.ts — shared OAuth token-refresh cadence constants.
 *
 * These mirror the per-account proactive-rotation semantics documented in
 * `sdk.ts` (`PROACTIVE_REFRESH_RATIO`, `PROACTIVE_REFRESH_MIN_INTERVAL_MS`,
 * `EXPIRY_BUFFER_MS`). The proxy's per-ORG refresh loop reuses the same
 * budget-safe shape so short / rate-limited tokens can't blow the
 * ~6/day/refresh_token grant budget → 429 death spiral (architect-review H2).
 *
 * WHY A SHARED MODULE: `sdk.ts` owns the single-account disk-token timer for
 * direct-SDK / opencode consumers; `proxy-client.ts` owns the multi-org proxy
 * loop. Both derive their cadence from the SAME numbers here so the two paths
 * can never silently drift (feedback_ssot_no_hardcode). `sdk.ts` keeps its own
 * copies for now (documented parity) to bound the blast radius of this change;
 * new callers should import from here.
 */

/** Cheap expiry gate: treat a token as "needs refresh" this close to expiry. */
export const EXPIRY_BUFFER_MS = 5 * 60 * 1000 // 5 min

/**
 * Refresh when remaining life drops below this FRACTION of the token's
 * lifetime. 0.20 == refresh at 20% remaining (80% consumed). Lowered from 0.50
 * historically because 50% triggered ~6 grants/day/refresh_token → 429 storms.
 */
export const PROACTIVE_REFRESH_RATIO = 0.20

/**
 * Hard floor between PROACTIVE refresh grants for one org — caps refresh
 * frequency regardless of buffer/token-length, so a short (~54 min) token
 * cannot force a grant on every KA fire (architect-review H2). Force-on-401
 * bypasses this floor (a genuine server 401 must be able to recover) but is
 * itself bounded by the per-org failure cooldown below.
 */
export const PROACTIVE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 min

/**
 * Extra margin added on top of the KA interval when sizing the proactive
 * refresh threshold. The threshold is `min(kaInterval + margin, RATIO×lifetime)`
 * so long tokens refresh lazily (fraction-of-lifetime) while short tokens are
 * caught by the daemon sweep before they expire between two KA fires.
 */
export const ORG_REFRESH_MARGIN_MS = 10 * 60 * 1000 // 10 min

/**
 * Fallback token-lifetime estimate when a captured-at timestamp is unavailable
 * (first-ever active-org refresh). Anthropic issues ~8 h tokens under normal
 * conditions; short tokens carry a real captured-at, so this only affects the
 * cold-start estimate.
 */
export const DEFAULT_TOKEN_LIFETIME_MS = 8 * 60 * 60 * 1000 // 8 h

/** KA interval fallback (matches keepalive SSOT default) when config is unset. */
export const DEFAULT_KA_INTERVAL_SEC = 1800 // 30 min

/**
 * Per-org refresh-FAILURE cooldown (architect-review H3). After a forced
 * refresh fails, back off exponentially from BASE up to MAX before forcing
 * again — so sequential REARM-ladder slots don't re-hammer the OAuth endpoint
 * on a dead refresh_token.
 */
export const REFRESH_FAILURE_COOLDOWN_BASE_MS = 60 * 1000 // 1 min
export const REFRESH_FAILURE_COOLDOWN_MAX_MS = 30 * 60 * 1000 // 30 min

/**
 * Cooldown after a classified REVOKE (`invalid_grant`) — the org needs a fresh
 * `claude login`, so stop re-forcing for a longer window and let the KA ladder
 * run token-free (bounded) instead of spamming doomed grants.
 */
export const REVOKE_RELOGIN_COOLDOWN_MS = 30 * 60 * 1000 // 30 min

/** Default cadence of the daemon-owned per-org proactive refresh sweep. */
export const DEFAULT_ORG_PROACTIVE_SWEEP_SEC = 60 // 1 min
