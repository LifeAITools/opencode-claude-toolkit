/**
 * EvictionCircuitBreaker — shared, cross-engine back-off for server-side
 * cache-eviction storms.
 *
 * WHY THIS EXISTS
 * ---------------
 * Each managed session owns its own KeepaliveEngine. When Anthropic evicts
 * cached prefixes server-side (LRU pressure / capacity flush / TTL-boundary
 * batch), every engine independently hits the eviction at *its own* fire time
 * and pays a full cold `cache_creation` rewrite. Observed 2026-05-28 02:15–02:38:
 * ~8 sessions each cold-rewrote within a 25-minute window — ~6M cache-write
 * tokens, none of it caused by user activity.
 *
 * KeepaliveEngine Layer 5 already detects the cold-write signature
 * (large cache_creation paired with near-zero cache_read) and disarms the
 * *detecting* engine — but the other engines have no way to know a storm is in
 * progress. This breaker is the missing shared signal: the first engine to
 * detect a genuine server-side eviction trips it; the rest consult it at their
 * fire gate and DISARM (drop the stale snapshot, stop the timer) until a real
 * request hands them a fresh, known-good snapshot. An N-session rewrite cascade
 * collapses into one rewrite + lazy re-warm on return.
 *
 * WHY DISARM, NOT HOLD: once the server has evicted a prefix, the warm cache is
 * already gone — there is nothing to "keep warm" by holding. Staying armed just
 * assumes the snapshot will be valid again after a cooldown, which the eviction
 * itself disproves: the next fire would be another cold rewrite, for an *idle*
 * session the user may never return to. Disarming stops guessing — KA resumes
 * cleanly when the next real request proves the user is back AND supplies a
 * current snapshot. Idle sessions thus re-warm lazily on return, not by
 * stampeding into N cold rewrites mid-storm.
 *
 * FALSE-POSITIVE GUARD (see isServerSideEviction): a cold write is only a fleet
 * signal when it has NO local cause. A recent REAL request — including a
 * user-authorized `[%cache-rewrite-ok%]` rewrite — slides this session's
 * cache_control prefix and is handled on the real-request path (re-snapshot);
 * that must NOT trip the fleet. The breaker is tripped only for cold writes on a
 * snapshot that was stable (KA-warmed, no real traffic) — i.e. truly server-side.
 *
 * Pure and deterministic: the caller supplies `now` (ms epoch). No timers, no
 * I/O — trivially unit-testable and safe to share across all engines in-process.
 */
/**
 * Decide whether a KA fire's result is a genuine SERVER-SIDE eviction that
 * should trip the shared fleet breaker — as opposed to a locally-explained cold
 * write (a recent real request, incl. a user-authorized rewrite, slid the
 * prefix). Pure; unit-tested independently of the engine.
 */
export declare function isServerSideEviction(p: {
    /** cache_creation tokens on the KA fire. */
    cacheWrite: number;
    /** cache_read tokens on the KA fire. */
    cacheRead: number;
    /** ms since the last REAL request on this lineage (KA fires excluded). */
    msSinceLastRealRequest: number;
    /** the engine's KA interval — the window within which a real request could
     *  plausibly have moved the prefix locally. */
    intervalMs: number;
    /** cache_creation above this is "large". Default 10_000. */
    cwThreshold?: number;
    /** cache_read must be below cacheWrite*this for a "cold" write. Default 0.1. */
    crRatioMax?: number;
}): boolean;
export interface EvictionBreakerConfig {
    /**
     * How long other engines hold (skip fires) after a trip, in ms. Must be
     * comfortably shorter than min(cacheTTL) − safetyMargin so a hold can never
     * itself expire a healthy cache. For the proxy's 1h TTL, ~5min is safe.
     * `<= 0` disables the breaker entirely (never engages).
     */
    cooldownMs: number;
    /**
     * Number of trips required within `windowMs` before the breaker engages.
     * Default 1: a single detected eviction holds the fleet (matches the
     * "one session burns → others back off" intent). Set to 2+ to require
     * corroboration and avoid holding on a lone per-session marker-slide.
     */
    minTripsToEngage?: number;
    /**
     * Sliding window (ms) over which trips are counted toward minTripsToEngage.
     * Defaults to cooldownMs. Trips older than this are pruned.
     */
    windowMs?: number;
}
export interface EvictionTripMeta {
    sessionId?: string;
    lineageKey?: string;
    cacheWrite: number;
    cacheRead: number;
}
export declare class EvictionCircuitBreaker {
    private readonly cooldownMs;
    private readonly minTripsToEngage;
    private readonly windowMs;
    /** Recent trips within the window (pruned lazily on access). */
    private trips;
    constructor(cfg: EvictionBreakerConfig);
    /** Record a detected cold-write eviction. Safe to call from any engine. */
    trip(now: number, meta: EvictionTripMeta): void;
    /**
     * True if the fleet should HOLD fires right now: enough corroborating trips
     * within the window AND the most recent trip is still inside the cooldown.
     */
    isTripped(now: number): boolean;
    /** Ms remaining until the breaker auto-clears (0 when not tripped). */
    cooldownRemainingMs(now: number): number;
    /** Count of trips currently inside the sliding window. */
    tripCount(now: number): number;
    get lastTrippedAt(): number | null;
    get lastTrip(): EvictionTripMeta | null;
    /** Drop trips older than the sliding window. */
    private prune;
}
//# sourceMappingURL=eviction-breaker.d.ts.map