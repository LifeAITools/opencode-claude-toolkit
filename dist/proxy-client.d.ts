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
export interface ProxyClientConfig {
    /** Anthropic API base URL. Default: https://api.anthropic.com */
    anthropicBaseUrl?: string;
    /**
     * Keepalive interval in seconds. Engine clamps to [intervalClampMin, intervalClampMax]
     * derived from the active cacheTtlMs (read from ~/.claude/keepalive.json SSOT).
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
     * Handle one /v1/messages request end-to-end. Returns a Response whose
     * body streams SSE bytes from Anthropic directly to the caller.
     *
     * Network errors produce 503 with Retry-After: 2. Upstream 401 invalidates
     * cached OAuth. Upstream 4xx/5xx pass through unchanged.
     */
    handleRequest(rawBody: ArrayBuffer | Uint8Array | string, headers: Record<string, string>, ctx: HandleRequestContext): Promise<Response>;
    private createEngine;
    private engineDoFetch;
    private parseSSEAndNotify;
    private handleNetworkError;
}
//# sourceMappingURL=proxy-client.d.ts.map