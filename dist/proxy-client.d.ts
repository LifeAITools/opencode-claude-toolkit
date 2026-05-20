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
     * Per-consumer cache TTL override in SECONDS. When set, this proxy's engine
     * uses THIS value as its cache lifetime (and never live-reloads it from SSOT).
     *
     * Default: 300 (5 min) — matches native Claude Code's `cache_control:ephemeral`
     * wire behavior. The shared ~/.claude/keepalive.json may declare a longer TTL
     * (e.g. 3600s for opencode's 1h cache contract), but that value reflects
     * opencode's traffic — NOT the native CC traffic this proxy intercepts.
     *
     * Honoring SSOT's longer TTL here is the architectural bug that caused the
     * 2026-05-17 SDK-0.15 incident (906K cache_creation tokens wasted on KA fires
     * against caches Anthropic had already expired at 5 min).
     *
     * Set to `null` (or omit and patch the type) only when you knowingly want SSOT
     * behavior — e.g. when the proxy will exclusively serve opencode-style traffic
     * with explicit `ttl: '1h'` cache_control markers.
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
    /** Resolves the current Anthropic org UUID — drives org-switch detection. */
    private readonly orgIdResolver;
    constructor(opts: ProxyClientOptions);
    /** Current rate-limit snapshot from last upstream response. */
    get rateLimitSnapshot(): Readonly<RateLimitSnapshot>;
    /** List all tracked sessions (for stats endpoints). */
    listSessions(): Session<KeepaliveEngine>[];
    /** Total session count. */
    sessionCount(): number;
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
     *  next real request as a real rewrite) and emit KA_REVIVE_DROP. */
    private recordReviveDrop;
    private engineDoFetch;
    private parseSSEAndNotify;
    private predictCacheMiss;
    private handleNetworkError;
}
//# sourceMappingURL=proxy-client.d.ts.map