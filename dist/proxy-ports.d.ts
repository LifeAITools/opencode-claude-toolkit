/**
 * Proxy Ports — interfaces defining the extension points of ProxyClient.
 *
 * ──────────────────────────────────────────────────────────────
 *  HYBRID ARCHITECTURE (Hexagonal / Ports & Adapters)
 * ──────────────────────────────────────────────────────────────
 *
 *  ProxyClient is the core orchestrator of Anthropic-subscription proxying
 *  with cache keepalive. To keep the core CLEAN and IMPORTABLE from any
 *  consumer (standalone HTTP proxy, opencode plugin, programmatic SDK user),
 *  it must not depend on specific implementations of:
 *
 *    - credential storage   (file? memory? per-project? vault?)
 *    - event observability  (local console? typed event bus? rotating file
 *                            logger? TUI subscriber? external telemetry?)
 *    - session storage      (in-memory Map? redis for multi-host?)
 *
 *  Each of these becomes an INTERFACE (a "port") below. The core declares
 *  WHAT it needs; adapters implement HOW. Default adapters ship with SDK
 *  so the common case is zero-config:
 *
 *    const client = new ProxyClient({ config })
 *    // uses FileCredentialsProvider + ConsoleEventEmitter + InMemorySessionStore
 *
 *  For advanced integration (proxy-package with TUI + heartbeat + rotating
 *  logs, or opencode-plugin with per-project credentials), consumers pass
 *  their own adapters:
 *
 *    const client = new ProxyClient({
 *      config,
 *      credentialsProvider: new VaultCredentialsProvider({...}),
 *      eventEmitter:        new MultiSinkEventEmitter([console, file, tui]),
 *      sessionStore:        new RedisSessionStore({...}),
 *    })
 *
 *  ──────────────────────────────────────────────────────────────
 *  DESIGN PRINCIPLES
 *  ──────────────────────────────────────────────────────────────
 *
 *  1. MINIMAL — ports expose only what ProxyClient actually calls. Not
 *     a kitchen-sink "adapter that does everything".
 *
 *  2. ASYNC-SAFE — all I/O methods return Promise. No sync filesystem ops
 *     in hot paths.
 *
 *  3. NO TYPE LEAKAGE — ports don't reference implementation-specific types
 *     (no "EventEmitter" from node:events, no "Map" in public signatures).
 *
 *  4. STABLE — these are public API surface. Breaking changes here cascade
 *     to every adapter + consumer. Additions OK, removals = major version.
 */
/**
 * Source of truth for OAuth access tokens.
 *
 * ProxyClient calls getAccessToken() before every real request (the engine
 * calls it again before every KA fire). Implementations MUST handle:
 *   - caching (don't hit disk/network on every call)
 *   - refresh (when token expires, transparently get a fresh one)
 *   - concurrency (multiple simultaneous callers → one refresh operation)
 *
 * On upstream 401, ProxyClient calls invalidate() so next getAccessToken()
 * forces a reload / re-refresh.
 */
export interface ICredentialsProvider {
    /** Returns a currently-valid access token. Throws if none available. */
    getAccessToken(): Promise<string>;
    /** Invalidate any cached token. Next call re-loads/refreshes. */
    invalidate(): void;
}
/**
 * Structured event sink. ProxyClient emits events for every observable
 * thing: request lifecycle, KA fires, disarms, errors, network state.
 *
 * Adapters decide destination: stdout, log file, TUI, OTLP, nothing.
 *
 * Event shape is declarative — each event has `kind` (string enum),
 * `level` (error|info|debug), and kind-specific payload. Ports don't
 * care about the payload; they just forward/store/display.
 */
export interface ProxyEvent {
    /** ISO timestamp — emitter can auto-stamp if missing */
    ts?: string;
    /** Severity for filtering/coloring */
    level: 'error' | 'info' | 'debug';
    /** Event type — consumers match on this */
    kind: string;
    /** Optional human-readable message (complements structured fields) */
    msg?: string;
    /** Arbitrary event-specific fields */
    [key: string]: unknown;
}
export interface IEventEmitter {
    /** Emit one event. Fire-and-forget. Implementations must not throw. */
    emit(event: ProxyEvent): void;
}
/**
 * Where per-session state lives (one KA engine per session, tracks last
 * request time, observed model, owning process PID for JIT liveness check).
 *
 * Default in-memory Map suffices for single-host proxies. Multi-host
 * scenarios (e.g. proxy as cluster) could implement Redis-backed store.
 *
 * The engine itself is stored opaquely (as unknown / never-parsed by the
 * store). Store's job is to key-value — the engine instance stays in one
 * place.
 */
export interface Session<EngineT = unknown> {
    sessionId: string;
    pid: number | null;
    firstSeenAt: number;
    lastRequestAt: number;
    engine: EngineT;
    model: string | null;
    lastUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens: number;
        cacheCreationInputTokens: number;
    } | null;
}
export interface ISessionStore<EngineT = unknown> {
    /** Look up existing session, or create via factory if absent. */
    getOrCreate(sessionId: string, ownerPid: number | null, engineFactory: () => EngineT): Session<EngineT>;
    /** Find a session by ID. Returns undefined if unknown. */
    get(sessionId: string): Session<EngineT> | undefined;
    /** List all active sessions (for stats/admin routes). */
    list(): Session<EngineT>[];
    /** Total count of tracked sessions. */
    size(): number;
    /**
     * Check whether a session's owner process is still alive.
     * Used by engine isOwnerAlive() to avoid wasted KA fires on dead consumers.
     * Returns true if unknown/unresolved (err on the side of alive).
     */
    isOwnerAlive(sessionId: string): boolean;
    /**
     * Periodic cleanup — remove sessions whose owning PID is dead.
     * Returns IDs that were reaped. ProxyClient calls this every ~10s.
     * Implementations should also stop() the engine before removing.
     */
    reapDead(): string[];
    /** Shutdown ALL sessions (stop engines, clear store). */
    stopAll(): void;
}
/**
 * Low-level HTTPS transport to api.anthropic.com.
 *
 * Default adapter uses Node/Bun native fetch. Advanced adapters could
 * add per-request tracing, custom DNS, mTLS, connection pooling, etc.
 *
 * This port is OPTIONAL — ProxyClient provides a built-in default using
 * global fetch(). Most consumers will never touch this.
 */
export interface IUpstreamFetcher {
    /**
     * Perform the raw upstream fetch. Returns a Response whose body is an
     * SSE stream (per Anthropic API). ProxyClient tees that stream to
     * (a) forward to caller byte-for-byte, (b) parse usage for KA engine.
     *
     * Implementations MUST NOT retry internally — consumer retry policy
     * (CC: 10 attempts, opencode: 3, curl: 0) governs that, and retry-
     * amplification breaks observability.
     */
    fetch(url: string, init: {
        method: 'POST';
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }): Promise<Response>;
}
/**
 * Supplier of "is process <pid> still alive?" answers.
 *
 * Default adapter uses POSIX kill(pid, 0). Windows or non-POSIX
 * environments may need different implementations.
 *
 * This port is OPTIONAL — default via processAlive() built-in.
 */
export interface ILivenessChecker {
    /** True if the given PID is currently alive; false if reaped or unknown. */
    isAlive(pid: number): boolean;
}
/**
 * Aggregate type for ProxyClient constructor. Only `config` +
 * `credentialsProvider` are required; the rest have sensible defaults.
 */
export interface ProxyClientAdapters {
    /** REQUIRED: how to get OAuth access tokens */
    credentialsProvider: ICredentialsProvider;
    /** Optional: where to send observability events. Default: console. */
    eventEmitter?: IEventEmitter;
    /** Optional: where to store session state. Default: in-memory. */
    sessionStore?: ISessionStore;
    /** Optional: how to talk to upstream. Default: native fetch. */
    upstreamFetcher?: IUpstreamFetcher;
    /** Optional: how to check PID liveness. Default: POSIX kill -0. */
    livenessChecker?: ILivenessChecker;
}
//# sourceMappingURL=proxy-ports.d.ts.map