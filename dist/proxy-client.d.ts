/**
 * ProxyClient — the CORE orchestrator for subscription-based Anthropic proxying.
 *
 * ──────────────────────────────────────────────────────────────
 *  RESPONSIBILITIES
 * ──────────────────────────────────────────────────────────────
 *
 *  Given a consumer's HTTP request to /v1/messages (body + headers + session
 *  context), ProxyClient:
 *    1. Tracks per-session state (via ISessionStore port)
 *    2. Obtains fresh OAuth token (via ICredentialsProvider port)
 *    3. Rewrites headers (strip consumer auth, inject OAuth bearer, oauth beta)
 *    4. Notifies KeepaliveEngine so it knows there's a real request
 *    5. Forwards to api.anthropic.com (via IUpstreamFetcher port)
 *    6. Tees the SSE stream: one copy back to consumer, one parsed for usage
 *    7. Feeds usage back to engine which schedules keepalive fires
 *    8. Handles network-level errors with standards-compliant 503 response
 *
 *  What it does NOT do:
 *    - Listen on any port (that's the HTTP server's job — consumers wrap us)
 *    - Write logs directly (goes through IEventEmitter port)
 *    - Persist session state (goes through ISessionStore port)
 *    - Refresh OAuth tokens (ICredentialsProvider owns that)
 *
 *  ──────────────────────────────────────────────────────────────
 *  USAGE
 *  ──────────────────────────────────────────────────────────────
 *
 *  Zero-config (defaults):
 *    const client = new ProxyClient({
 *      config: { kaIntervalSec: 120, credentialsPath: '~/.claude/.credentials.json' },
 *      credentialsProvider: new FileCredentialsProvider(),
 *    })
 *
 *  HTTP proxy:
 *    Bun.serve({
 *      async fetch(req) {
 *        return client.handleRequest(
 *          await req.arrayBuffer(),
 *          headersToObject(req.headers),
 *          { sessionId: req.headers.get('x-claude-code-session-id') ?? randomId() }
 *        )
 *      }
 *    })
 *
 *  In-process (opencode-plugin):
 *    return {
 *      auth: {
 *        loader: () => ({
 *          fetch: (req, init) => client.handleRequest(init.body, headersFromInit(init), {
 *            sessionId: crypto.randomUUID(),
 *          }),
 *        }),
 *      },
 *    }
 */
import { KeepaliveEngine } from './keepalive-engine.js';
import type { ICredentialsProvider, IEventEmitter, ILivenessChecker, ISessionStore, IUpstreamFetcher, Session } from './proxy-ports.js';
import { type OrgIdResolver } from './org-identity.js';
export interface ProxyClientConfig {
    /** Anthropic API base URL. Default: https://api.anthropic.com */
    anthropicBaseUrl?: string;
    /**
     * Per-consumer cache TTL pin in SECONDS — the engine's INITIAL cache-lifetime
     * belief. The wire autoscan (detectCacheTtlFromBody in notifyRealRequestStart)
     * monotonically locks it DOWN if it ever observes a shorter cache_control
     * marker, so this value is a ceiling, not an unconditional override.
     *
     * Default: 3600 (1 h). `handleRequest` upgrades native Claude Code's
     * `cache_control:{type:'ephemeral'}` markers to `ttl:'1h'` before forwarding
     * (gated on the prompt-caching-scope beta), so the cache genuinely lives 1 h
     * on Anthropic's side — 3600 is the true wire TTL, not an assumption.
     *
     * The 2026-05-17 SDK-0.15 incident (906K cache_creation tokens wasted) was a
     * wire/model MISMATCH: the engine believed 1 h while the wire was still 5 m,
     * so KA fired every 30 min into caches dead for 25. That cannot recur here:
     * the proxy now CONTROLS the wire to 1 h, and the autoscan downlock still
     * catches any request that slips through un-upgraded (no beta → wire 5 m →
     * engine downlocks that session to 300 s).
     */
    kaCacheTtlSec?: number;
    /**
     * Keepalive interval in seconds. Engine clamps to [intervalClampMin, intervalClampMax]
     * derived from the active cacheTtlMs (read from ~/.claude/keepalive.json SSOT,
     * or from kaCacheTtlSec when overridden).
     *
     * If undefined, engine uses SSOT.intervalMs (auto-scales: ~5m TTL → 150s, ~1h TTL → 1800s).
     * Explicit value overrides SSOT.
     */
    kaIntervalSec?: number;
    /**
     * Idle timeout in seconds — how long without real requests before engine
     * disarms. 0 = never. Default: 0 (never, kept warm until PID dies).
     */
    kaIdleTimeoutSec?: number;
    /** Minimum tokens for a snapshot to be eligible for KA. Default: 2000 */
    kaMinTokens?: number;
    /** Rewrite-burst guard warn threshold (idle sec). Default: 300 */
    kaRewriteWarnIdleSec?: number;
    /** Rewrite-burst guard warn token threshold. Default: 50000 */
    kaRewriteWarnTokens?: number;
    /** Rewrite-burst guard block threshold (idle sec). 0 = never. Default: 0 */
    kaRewriteBlockIdleSec?: number;
    /** Enable rewrite-burst hard block. Default: false (warn only) */
    kaRewriteBlockEnabled?: boolean;
    /**
     * Cross-engine eviction-storm window, in seconds. When one session's KA fire
     * detects a GENUINE server-side cold-write eviction (cold write with no local
     * cause) it trips a SHARED breaker; for this many seconds every other engine,
     * at its next fire, DISARMS (drops its stale snapshot and stops) rather than
     * pay its own cold rewrite into the same storm. Disarmed sessions re-arm
     * cleanly on their next real request. Collapses an N-session cold-rewrite
     * cascade (observed 2026-05-28: ~6M tokens across ~8 sessions in 25 min) into
     * a single rewrite plus lazy re-warm on return. A few minutes is enough for
     * every armed engine to hit at least one tick. 0 disables the breaker.
     * Default: 300 (5 min).
     */
    kaEvictionHoldSec?: number;
    /**
     * Trips required within the hold window before the breaker engages. 1 = a
     * single detected eviction holds the fleet (matches "one burns → others back
     * off"). 2+ requires corroboration, avoiding a hold on a lone per-session
     * marker-slide. Default: 1.
     */
    kaEvictionMinTrips?: number;
}
export interface ProxyClientOptions {
    /** Config tuning — all fields optional (sensible defaults) */
    config?: ProxyClientConfig;
    /** REQUIRED: how to get OAuth tokens */
    credentialsProvider: ICredentialsProvider;
    /** Optional: where to emit events. Default: ConsoleEventEmitter (stderr) */
    eventEmitter?: IEventEmitter;
    /** Optional: where to store sessions. Default: InMemorySessionStore */
    sessionStore?: ISessionStore<KeepaliveEngine>;
    /** Optional: how to talk to upstream. Default: native fetch */
    upstreamFetcher?: IUpstreamFetcher;
    /** Optional: how to check PID liveness. Default: POSIX kill -0 */
    livenessChecker?: ILivenessChecker;
    /**
     * Optional: how to resolve the current Anthropic org UUID — used by the
     * rewrite guard to detect a cross-org cache replay (`anomalous:org-switch`).
     * Default: FileOrgIdResolver reading `~/.claude.json`.
     */
    orgIdResolver?: OrgIdResolver;
    /**
     * Optional: where to persist the cache-prefix history (so the miss
     * predictor + rewrite guard survive a proxy restart). Default:
     * `~/.claude-local/proxy-prefix-history.json`. Injectable for test
     * isolation — production never sets it.
     */
    prefixHistoryPath?: string;
    /**
     * Optional: directory for rewrite-guard block dumps (the rejected request
     * + prefix diff, written on every block for offline analysis). Default:
     * `~/.claude-local/rewrite-guard-blocks/`. Injectable for test isolation.
     */
    rewriteBlockDumpDir?: string;
    /**
     * Optional: wall-clock time (ms) this proxy process started. Default:
     * `Date.now()` at construction. Used to recognise a TTL expiry that spans
     * a proxy restart (the KA engine could not have kept the cache warm across
     * a gap in which it did not exist) so the guard does not block it.
     * Injectable for tests.
     */
    proxyStartedAt?: number;
    /**
     * Optional: where to persist the KA snapshot registry so KA survives a
     * proxy restart (idle sessions keep their cache warm across a deploy).
     * Default: `~/.claude-local/proxy-ka-snapshots.json`. Injectable for tests.
     */
    kaSnapshotPath?: string;
}
export interface HandleRequestContext {
    /** Unique identifier for the logical session. */
    sessionId: string;
    /** OS PID of the consumer process (for JIT liveness check). */
    sourcePid?: number | null;
    /** Abort signal for the upstream fetch. */
    signal?: AbortSignal;
    /**
     * Whether this request comes from an INTERACTIVE human (native Claude Code),
     * as opposed to a programmatic endpoint client (OpenAI-compat /v1/chat/
     * completions, or an external Anthropic-API consumer). The rewrite guard is a
     * human consent checkpoint — when `rewriteGuard.interactiveOnly` is true
     * (default), guard blocking applies ONLY to interactive requests; programmatic
     * clients (interactive=false) are let through (logged) since they cannot
     * re-send with an override marker. Default true (preserves native-CC behavior).
     */
    interactive?: boolean;
}
export interface RateLimitSnapshot {
    status: string | null;
    resetAt: number | null;
    claim: string | null;
    retryAfter: number | null;
    utilization5h: number | null;
    utilization7d: number | null;
}
export declare class ProxyClient {
    private readonly config;
    private readonly metrics;
    private readonly credentials;
    private readonly events;
    private readonly store;
    private readonly upstream;
    private readonly liveness;
    private readonly reaperTimer;
    private lastRateLimit;
    /** Previous request's cacheable-prefix fingerprint per `${sessionId}:${lineageKey}`.
     *  Persisted to disk (loadPrefixHistory) so the cache-miss predictor + rewrite
     *  guard survive a proxy restart — otherwise the first request of every
     *  session post-restart looks like a cold-start and the guard is blind. */
    private readonly prefixHistory;
    /** Where prefixHistory is persisted — configurable for test isolation. */
    private readonly prefixHistoryPath;
    /** Directory for rewrite-guard block dumps. */
    private readonly rewriteBlockDumpDir;
    /** Wall-clock ms this proxy process started — a cache warm-up older than
     *  this means the TTL gap spans a restart (KA could not have prevented it). */
    private readonly proxyStartedAt;
    /** Last Claude Code version seen in a request's billing header — a change
     *  churns the cacheable prefix; tracked to emit CC_VERSION_CHANGED. */
    private lastCcVersion;
    /** Where the KA snapshot registry is persisted (configurable for tests). */
    private readonly kaSnapshotPath;
    /** Set when a KA registry mutated since the last persist — bounds writes
     *  to "only when something changed" (bodies are large; no blind 10s saves). */
    private kaSnapshotDirty;
    /** Lineage keys (`${sessionId}:${lineageKey}`) whose persisted KA snapshot
     *  was DROPPED at startup (cache already dead). The next real request for
     *  such a lineage is a genuine rewrite the guard should surface — see
     *  predictCacheMiss / classifyRewrite's `kaRevivalDropped`. */
    private readonly kaReviveDropped;
    /** Last cacheable prefix (system + tools) seen per `${sessionId}:${lineageKey}`.
     *  In-memory only (never persisted — bodies are large) — feeds the prefix
     *  diff written into a guard-block dump. Reaped with prefixHistory. */
    private readonly lineagePrefix;
    /** Per-session pinned account (org+token). Keyed by sessionId. In-memory only;
     *  reaped with the session. Drives forward token selection (hold cross-org /
     *  adopt same-org / rebind on marker+reload / 401 on cross-org expiry). */
    private readonly sessionPins;
    /** Resolves the current Anthropic org UUID — drives org-switch detection. */
    private readonly orgIdResolver;
    /** Shared across every per-session KA engine — fleet-wide eviction-storm hold. */
    private readonly evictionBreaker;
    constructor(opts: ProxyClientOptions);
    /** Current rate-limit snapshot from last upstream response. */
    get rateLimitSnapshot(): Readonly<RateLimitSnapshot>;
    /** List all tracked sessions (for stats endpoints). */
    listSessions(): Session<KeepaliveEngine>[];
    /** Total session count. */
    sessionCount(): number;
    /** Mark a session as Worker-managed (heartbeat-based liveness instead of PID). */
    markManagedSession(sessionId: string, workerId: string, ttlMs?: number): boolean;
    /** Worker heartbeat — refresh liveness for all Worker's sessions. */
    workerHeartbeat(workerId: string, activeSessionIds: string[]): number;
    /** Unmark a session as Worker-managed. */
    unmarkManagedSession(sessionId: string): boolean;
    /** Config used by this client (read-only). */
    get configSnapshot(): Readonly<Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & {
        kaIntervalSec: number | undefined;
    }>;
    /** Snapshot of current rolling cache-metrics window. */
    get cacheMetricsSnapshot(): import("./cache-metrics.js").MetricsSummary;
    /** Clean shutdown — stops reaper, metrics collector, and all KA engines in store. */
    stop(): void;
    /**
     * Disarm one or all KA engines and invalidate cached credentials.
     *
     * Use case: user swapped Anthropic org via `claude login` and wants the
     * proxy to drop all stale snapshots before next request. Without this,
     * the next KA fire would replay the previous session's accumulated
     * snapshot against the NEW org — paying full cold-cache-write cost
     * (~80K-500K tokens, see body-dump analysis) on the wrong account.
     *
     * Pass sessionId to target a single session, omit to disarm all.
     * Returns the list of sessionIds that were disarmed.
     */
    disarmSessions(reason: string, sessionId?: string): string[];
    /**
     * Reload one or all KA engines: drop stale snapshots + invalidate the
     * credential cache, but — unlike disarmSessions — leave each engine's tick
     * timer running so it auto-resumes the moment the next real request
     * re-registers a snapshot.
     *
     * This is the correct primitive for org-swap (`claude login` to a new org):
     * the old org's cached prefix is useless against the new org, so it must be
     * dropped — but the KA must NOT die. The user keeps working, and the parked
     * main agent's cache must be re-warmed as soon as traffic resumes. The old
     * disarmSessions() killed the timer, so a single org-swap silently disabled
     * KA for the rest of the session.
     *
     * Pass sessionId to target one session, omit to reload all.
     */
    reloadSessions(reason: string, sessionId?: string): string[];
    /**
     * Credentials file changed on disk (the daemon's fs.watch on
     * `~/.claude/.credentials.json`). Invalidate the token cache AND the org-id
     * cache **in lock-step**, so the pin/rewrite logic never sees a fresh token
     * paired with a stale org-id — the 2026-06-02 incident, where the org-id's
     * independent 5-min TTL let real traffic slip onto a new org silently while
     * the guard still believed it was the old org.
     *
     * Does NOT touch session pins: a same-org refresh must stay seamless, and a
     * cross-org switch must HOLD each session on its old org until an explicit
     * reload (`reloadSessions` / `[%reload-ok%]`). Layer 1 only re-syncs the two
     * caches; Layer 2 (pins) decides what each session does with the result.
     */
    notifyCredentialsChanged(reason: string): void;
    /**
     * Decide which token a session's request uses, given the live account snapshot
     * and the session's existing pin. The whole per-session model lives here:
     *
     *  - no pin OR explicit reload (`[%reload-ok%]`) → (re)bind to the current
     *    account and use its token (new session / deliberate switch);
     *  - same org (incl. a safe same-org refresh, or an unknown/null org on either
     *    side) → adopt the fresh token, keep the pin on this org;
     *  - cross-org, old token still alive → HOLD: keep posting to the OLD org+token
     *    (no block, no migration);
     *  - cross-org, old token expired → force-stop (401) — never silently migrate
     *    onto the new org's quota.
     *
     * Mutates `sessionPins`. Pure w.r.t. I/O (no awaits) so it is unit-testable.
     */
    private selectSessionToken;
    /**
     * Handle one /v1/messages request end-to-end. Returns a Response whose
     * body streams SSE bytes from Anthropic directly to the caller.
     *
     * Network errors produce 503 with Retry-After: 2. Upstream 401 invalidates
     * cached OAuth. Upstream 4xx/5xx pass through unchanged.
     */
    handleRequest(rawBody: ArrayBuffer | Uint8Array | string, headers: Record<string, string>, ctx: HandleRequestContext): Promise<Response>;
    private createEngine;
    /** Serialise every armed engine's KA registry into a persistable map. */
    private collectKaSnapshots;
    /** Persist the KA snapshot registry. Best-effort — never throws. */
    private persistKaSnapshots;
    /**
     * Startup: revive KA engines for sessions whose cache is provably still
     * warm. A snapshot too stale to revive is DROPPED — never re-armed (firing
     * KA on a dead cache is itself a cold write = quota burn). Each dropped
     * lineage is recorded in `kaReviveDropped` so the next real request for it
     * is surfaced as a genuine rewrite, not silently passed as proxy-restart.
     */
    private reviveKaSnapshots;
    /** Record a dropped KA snapshot: tag its lineages (so the guard surfaces the
     *  next real request as a real rewrite) and emit KA_REVIVE_DROP.
     *
     *  A drop only feeds `kaReviveDropped` (→ the rewrite guard treats the next
     *  real request as a blockable `avoidable:ttl-expiry`) when the cache death
     *  was AVOIDABLE — i.e. the cache was still alive at restart and a prompt KA
     *  could have kept it warm (`cache-dies-before-ka`), or revival hit a bug
     *  (`revive-error`). When the cache had ALREADY lapsed (`cache-already-dead`)
     *  or aged out (`too-old`), the gap exceeded the TTL — typically host
     *  downtime (reboot / power loss) during which no keepalive could possibly
     *  run. That rewrite is unavoidable, so we must NOT flag it: classifyRewrite
     *  then yields `expected:proxy-restart` and the guard lets the legitimate
     *  session-resume request through instead of 400-blocking it. */
    private static readonly AVOIDABLE_DROP_REASONS;
    private recordReviveDrop;
    private engineDoFetch;
    private parseSSEAndNotify;
    /**
     * Pure assessment of whether this request incurs a cache rewrite — does NOT
     * mutate prefix history. Returns a `commit` payload (always, so the PROCEED
     * path can advance history) and an `assessment` (null on an expected cache
     * HIT — nothing to surface/block). A blocked request calls this and skips
     * commit, so an unconsented rewrite never advances state or poisons the
     * marker-carrying retry's classification.
     */
    private assessCacheMiss;
    /** Persist this lineage's new prefix fingerprint + advance its idle clock.
     *  Call ONLY when the request PROCEEDS (never when the rewrite guard blocks
     *  it — a blocked, unconsented request must not advance history or it poisons
     *  the marker-carrying retry's classification). Also consumes the one-shot
     *  ka-revival-dropped flag. */
    private commitPrefixHistory;
    private handleNetworkError;
}
/**
 * Extract the Claude Code session id from a request body's `metadata.user_id`.
 *
 * Claude Code embeds the session UUID in `metadata.user_id` even when the
 * `x-claude-code-session-id` HTTP header is absent — interactive CC writes it
 * as a JSON `{"...","session_id":"<uuid>"}`, an Agent-SDK-spawned agent writes
 * it as `user_<device>_account_<acct>_session_<uuid>`. The proxy front-end can
 * therefore key a HEADER-LESS agent (every SDK-spawned cognitive worker) to
 * its real, stable session id instead of a throwaway `anon-*` — which is what
 * makes per-session KA + cross-restart cache persistence work for them.
 *
 * Never throws — a parse failure / absent field yields `null`.
 */
export declare function extractSessionIdFromBody(rawBody: ArrayBuffer | Uint8Array | string): string | null;
//# sourceMappingURL=proxy-client.d.ts.map