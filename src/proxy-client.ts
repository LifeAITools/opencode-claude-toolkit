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

import { KeepaliveEngine } from './keepalive-engine.js'
import { CacheMetricsCollector } from './cache-metrics.js'
import type {
  ICredentialsProvider,
  IEventEmitter,
  ILivenessChecker,
  ISessionStore,
  IUpstreamFetcher,
  Session,
} from './proxy-ports.js'
import {
  ConsoleEventEmitter,
  DefaultLivenessChecker,
  InMemorySessionStore,
  NativeFetchUpstream,
} from './proxy-adapters.js'
import type { StreamEvent, TokenUsage } from './types.js'
import { ANTHROPIC_API_BASE } from './anthropic-endpoints.js'
import { prefixHashes, classifyRewrite, type PrefixHashes } from './lineage.js'
import { loadKeepaliveConfig } from './keepalive-config.js'
import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  HEADER_AUTHORIZATION,
  HEADER_ANTHROPIC_BETA,
  HEADER_CONTENT_TYPE,
  CONTENT_TYPE_JSON,
} from './anthropic-headers.js'

// ═══ Config ═══════════════════════════════════════════════════════

export interface ProxyClientConfig {
  /** Anthropic API base URL. Default: https://api.anthropic.com */
  anthropicBaseUrl?: string

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
  kaCacheTtlSec?: number

  /**
   * Keepalive interval in seconds. Engine clamps to [intervalClampMin, intervalClampMax]
   * derived from the active cacheTtlMs (read from ~/.claude/keepalive.json SSOT,
   * or from kaCacheTtlSec when overridden).
   *
   * If undefined, engine uses SSOT.intervalMs (auto-scales: ~5m TTL → 150s, ~1h TTL → 1800s).
   * Explicit value overrides SSOT.
   */
  kaIntervalSec?: number

  /**
   * Idle timeout in seconds — how long without real requests before engine
   * disarms. 0 = never. Default: 0 (never, kept warm until PID dies).
   */
  kaIdleTimeoutSec?: number

  /** Minimum tokens for a snapshot to be eligible for KA. Default: 2000 */
  kaMinTokens?: number

  /** Rewrite-burst guard warn threshold (idle sec). Default: 300 */
  kaRewriteWarnIdleSec?: number

  /** Rewrite-burst guard warn token threshold. Default: 50000 */
  kaRewriteWarnTokens?: number

  /** Rewrite-burst guard block threshold (idle sec). 0 = never. Default: 0 */
  kaRewriteBlockIdleSec?: number

  /** Enable rewrite-burst hard block. Default: false (warn only) */
  kaRewriteBlockEnabled?: boolean
}

// Note: kaIntervalSec intentionally NOT defaulted here.
// When undefined, KeepaliveEngine reads its default from
// ~/.claude/keepalive.json (SSOT) which auto-scales with cacheTtlMs.
//
// kaCacheTtlSec DEFAULTS to 300 (5min) because this proxy intercepts native
// Claude Code traffic, whose cache_control:ephemeral writes live 5 min on
// Anthropic's side. The SSOT (~/.claude/keepalive.json) is shared with
// opencode and may declare 3600s — honoring that value here is a wire-TTL
// mismatch that wastes tokens (2026-05-17 incident). See ProxyClientConfig.
const DEFAULT_CONFIG: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & {
  kaIntervalSec: number | undefined
} = {
  anthropicBaseUrl: ANTHROPIC_API_BASE,
  kaCacheTtlSec: 300,
  kaIntervalSec: undefined,
  kaIdleTimeoutSec: 0,
  kaMinTokens: 2000,
  kaRewriteWarnIdleSec: 300,
  kaRewriteWarnTokens: 50000,
  kaRewriteBlockIdleSec: 0,
  kaRewriteBlockEnabled: false,
}

export interface ProxyClientOptions {
  /** Config tuning — all fields optional (sensible defaults) */
  config?: ProxyClientConfig

  /** REQUIRED: how to get OAuth tokens */
  credentialsProvider: ICredentialsProvider

  /** Optional: where to emit events. Default: ConsoleEventEmitter (stderr) */
  eventEmitter?: IEventEmitter

  /** Optional: where to store sessions. Default: InMemorySessionStore */
  sessionStore?: ISessionStore<KeepaliveEngine>

  /** Optional: how to talk to upstream. Default: native fetch */
  upstreamFetcher?: IUpstreamFetcher

  /** Optional: how to check PID liveness. Default: POSIX kill -0 */
  livenessChecker?: ILivenessChecker
}

// ═══ Request context (per handleRequest call) ══════════════════════

export interface HandleRequestContext {
  /** Unique identifier for the logical session. */
  sessionId: string

  /** OS PID of the consumer process (for JIT liveness check). */
  sourcePid?: number | null

  /** Abort signal for the upstream fetch. */
  signal?: AbortSignal
}

// ═══ Rate limit snapshot (exposed for introspection) ═══════════════

export interface RateLimitSnapshot {
  status: string | null
  resetAt: number | null
  claim: string | null
  retryAfter: number | null
  utilization5h: number | null
  utilization7d: number | null
}

// ═══ ProxyClient ═══════════════════════════════════════════════════

export class ProxyClient {
  private readonly config: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }
  private readonly metrics: CacheMetricsCollector
  private readonly credentials: ICredentialsProvider
  private readonly events: IEventEmitter
  private readonly store: ISessionStore<KeepaliveEngine>
  private readonly upstream: IUpstreamFetcher
  private readonly liveness: ILivenessChecker

  private readonly reaperTimer: ReturnType<typeof setInterval>
  private lastRateLimit: RateLimitSnapshot = {
    status: null, resetAt: null, claim: null, retryAfter: null,
    utilization5h: null, utilization7d: null,
  }

  /** Previous request's cacheable-prefix fingerprint per `${sessionId}:${lineageKey}`.
   *  Persisted to disk (loadPrefixHistory) so the cache-miss predictor + rewrite
   *  guard survive a proxy restart — otherwise the first request of every
   *  session post-restart looks like a cold-start and the guard is blind. */
  private readonly prefixHistory: Map<string, { hashes: PrefixHashes; lastReqAt: number }> = loadPrefixHistory()

  constructor(opts: ProxyClientOptions) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.credentials = opts.credentialsProvider
    this.events = opts.eventEmitter ?? new ConsoleEventEmitter()
    this.liveness = opts.livenessChecker ?? new DefaultLivenessChecker()
    this.store = opts.sessionStore ?? new InMemorySessionStore<KeepaliveEngine>(this.liveness)
    this.upstream = opts.upstreamFetcher ?? new NativeFetchUpstream()

    // Cache metrics collector — emits CACHE_METRICS_SUMMARY every 60s and
    // CACHE_REGRESSION_DETECTED if hit_rate drops below threshold.
    this.metrics = new CacheMetricsCollector({
      windowMs: 60_000,
      reportIntervalMs: 60_000,
      onSummary: (summary) => this.events.emit({
        level: 'info',
        kind: 'CACHE_METRICS_SUMMARY',
        ...summary,
      }),
      onRegression: (info) => this.events.emit({
        level: 'error',
        kind: 'CACHE_REGRESSION_DETECTED',
        ...info,
      }),
    })

    // Periodic reaper — every 10s, remove sessions whose owner PID is dead.
    // Keeps state clean + stops KA engines for dead consumers.
    this.reaperTimer = setInterval(() => {
      const reaped = this.store.reapDead()
      for (const sid of reaped) {
        this.events.emit({ level: 'info', kind: 'SESSION_DEAD', sessionId: sid, reason: 'pid_gone' })
        // Drop this session's prefix-history (keys are `${sid}:${lineageKey}`).
        for (const k of this.prefixHistory.keys()) {
          if (k.startsWith(sid + ':')) this.prefixHistory.delete(k)
        }
      }
      // Persist prefix history each reaper tick so it survives a proxy restart.
      savePrefixHistory(this.prefixHistory)
    }, 10_000)
    if (this.reaperTimer && typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      (this.reaperTimer as any).unref()
    }
  }

  // ─── Public getters ─────────────────────────────────────────────

  /** Current rate-limit snapshot from last upstream response. */
  get rateLimitSnapshot(): Readonly<RateLimitSnapshot> { return this.lastRateLimit }

  /** List all tracked sessions (for stats endpoints). */
  listSessions(): Session<KeepaliveEngine>[] { return this.store.list() }

  /** Total session count. */
  sessionCount(): number { return this.store.size() }

  /** Config used by this client (read-only). */
  get configSnapshot(): Readonly<Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }> { return this.config }

  /** Snapshot of current rolling cache-metrics window. */
  get cacheMetricsSnapshot() { return this.metrics.summary() }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Clean shutdown — stops reaper, metrics collector, and all KA engines in store. */
  stop(): void {
    clearInterval(this.reaperTimer)
    savePrefixHistory(this.prefixHistory)
    this.metrics.stop()
    this.store.stopAll()
  }

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
  disarmSessions(reason: string, sessionId?: string): string[] {
    const disarmed: string[] = []
    if (sessionId) {
      const s = this.store.list().find(x => x.sessionId === sessionId)
      if (s) {
        s.engine.disarm(reason)
        disarmed.push(s.sessionId)
      }
    } else {
      for (const s of this.store.list()) {
        s.engine.disarm(reason)
        disarmed.push(s.sessionId)
      }
    }
    // Always invalidate token cache too — caller may have just rotated
    // credentials (org swap is the canonical case for this method).
    this.credentials.invalidate()
    this.events.emit({
      level: 'info',
      kind: 'ADMIN_DISARM',
      reason,
      sessionIdRequested: sessionId ?? null,
      disarmedCount: disarmed.length,
      sessionIds: disarmed,
    })
    return disarmed
  }

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
  reloadSessions(reason: string, sessionId?: string): string[] {
    const reloaded: string[] = []
    if (sessionId) {
      const s = this.store.list().find(x => x.sessionId === sessionId)
      if (s) { s.engine.reload(reason); reloaded.push(s.sessionId) }
    } else {
      for (const s of this.store.list()) { s.engine.reload(reason); reloaded.push(s.sessionId) }
    }
    // Same credential-cache invalidation as disarmSessions — the canonical
    // caller just rotated credentials (org swap).
    this.credentials.invalidate()
    this.events.emit({
      level: 'info',
      kind: 'ADMIN_RELOAD',
      reason,
      sessionIdRequested: sessionId ?? null,
      reloadedCount: reloaded.length,
      sessionIds: reloaded,
    })
    return reloaded
  }

  // ─── Main entry point ──────────────────────────────────────────

  /**
   * Handle one /v1/messages request end-to-end. Returns a Response whose
   * body streams SSE bytes from Anthropic directly to the caller.
   *
   * Network errors produce 503 with Retry-After: 2. Upstream 401 invalidates
   * cached OAuth. Upstream 4xx/5xx pass through unchanged.
   */
  async handleRequest(
    rawBody: ArrayBuffer | Uint8Array | string,
    headers: Record<string, string>,
    ctx: HandleRequestContext,
  ): Promise<Response> {
    const sessionId = ctx.sessionId
    const sourcePid = ctx.sourcePid ?? null

    // Get or create session with KA engine
    const session = this.store.getOrCreate(
      sessionId,
      sourcePid,
      () => this.createEngine(sessionId),
    )
    session.lastRequestAt = Date.now()

    // Normalize body
    const rawBodyStr = typeof rawBody === 'string'
      ? rawBody
      : new TextDecoder().decode(rawBody as ArrayBuffer)
    const bodyBytes = typeof rawBody === 'string'
      ? new TextEncoder().encode(rawBody).byteLength
      : (rawBody as ArrayBuffer | Uint8Array).byteLength

    // Parse body minimally (for model extraction + KA snapshot)
    let parsedBody: any
    try {
      parsedBody = JSON.parse(rawBodyStr)
    } catch {
      this.events.emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: 'Invalid JSON body' })
      return jsonResponse(400, { error: 'Invalid JSON' })
    }

    const model = parsedBody.model ?? 'unknown'
    session.model = model

    // Build upstream headers: strip hop-by-hop + consumer auth, force identity encoding
    const upstreamHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (HOP_BY_HOP_OR_AUTH.includes(lk)) continue
      upstreamHeaders[k] = v
    }
    upstreamHeaders['accept-encoding'] = 'identity'

    // Inject OAuth bearer
    try {
      const token = await this.credentials.getAccessToken()
      upstreamHeaders[HEADER_AUTHORIZATION] = `Bearer ${token}`
    } catch (credErr: any) {
      this.events.emit({
        level: 'error',
        kind: 'TOKEN_NEEDS_RELOGIN',
        sessionId,
        msg: credErr?.message ?? 'No OAuth credentials',
      })
      return jsonResponse(401, {
        error: { type: 'authentication_error', message: credErr?.message ?? 'No OAuth credentials' },
      })
    }

    // Ensure oauth beta flag present
    const existingBeta = upstreamHeaders[HEADER_ANTHROPIC_BETA] ?? upstreamHeaders['Anthropic-Beta'] ?? ''
    if (!existingBeta.includes('oauth-2025-04-20')) {
      const prefix = existingBeta ? existingBeta + ',' : ''
      upstreamHeaders[HEADER_ANTHROPIC_BETA] = prefix + 'oauth-2025-04-20'
      delete upstreamHeaders['Anthropic-Beta']
    }

    this.events.emit({
      level: 'info',
      kind: 'REAL_REQUEST_START',
      sessionId,
      model,
      bodyBytes,
    })

    // Prime engine — aborts any in-flight KA, records pending snapshot.
    // Capture the returned lineageKey so the (async, background) completion can
    // be matched to THIS request concurrency-safely — sub-agent fan-out keeps
    // many requests in flight at once, and a shared slot would clobber.
    const reqLineageKey = session.engine.notifyRealRequestStart(model, parsedBody, upstreamHeaders)

    // Predict whether this request incurs a cache rewrite + classify the cause.
    const rewriteAssessment = this.predictCacheMiss(sessionId, reqLineageKey, parsedBody, bodyBytes)

    // Rewrite guard — opt-in, default OFF. When enabled, an avoidable/anomalous
    // rewrite above the configured token threshold that the user has NOT
    // confirmed (via the override marker in their latest message) is rejected
    // with 400 instead of silently spending quota. `expected:*` rewrites
    // (cold-start / compact / tools-changed) are never blocked. This does NOT
    // save the cost — the re-sent request re-caches the same — it converts a
    // silent quota spend into an explicit, consented one.
    {
      const guard = loadKeepaliveConfig().rewriteGuard
      const lastMsg = inspectLastUserMessage(parsedBody, guard.overrideMarker)
      if (guard.enabled && rewriteAssessment && !rewriteAssessment.expected
          && rewriteAssessment.predictedTokens >= guard.minRewriteTokens
          && !lastMsg.isContinuation        // never block an agent tool-loop continuation
          && !lastMsg.hasMarker) {
        this.events.emit({
          level: 'error',
          kind: 'CACHE_REWRITE_BLOCKED',
          sessionId,
          lineageKey: reqLineageKey,
          rewriteClass: rewriteAssessment.rewriteClass,
          predictedTokens: rewriteAssessment.predictedTokens,
          msg: `rewrite guard blocked ${rewriteAssessment.rewriteClass} `
            + `(~${rewriteAssessment.predictedTokens} tok) — awaiting user override marker`,
        })
        return jsonResponse(400, {
          error: {
            type: 'cache_rewrite_guard',
            message: `Cache-rewrite guard: this turn would re-cache ~${rewriteAssessment.predictedTokens} `
              + `tokens (${rewriteAssessment.rewriteClass}) — an unconfirmed quota spend. To proceed, `
              + `re-send your message with ${guard.overrideMarker} in it. `
              + `(Disable: keepalive.json → rewriteGuard.enabled=false.)`,
          },
        })
      }
    }

    // Pre-request rewrite-burst guard
    try {
      session.engine.checkRewriteGuard(model)
    } catch (err: any) {
      if (err?.code === 'CACHE_REWRITE_BLOCKED') {
        return jsonResponse(429, {
          error: { type: 'cache_rewrite_blocked', message: err.message },
        })
      }
      throw err
    }

    const t0 = Date.now()

    // Forward upstream
    let upstream: Response
    try {
      upstream = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, {
        method: 'POST',
        headers: upstreamHeaders,
        body: rawBodyStr,
        signal: ctx.signal,
      })
    } catch (fetchErr: any) {
      return this.handleNetworkError(sessionId, fetchErr)
    }

    // Parse rate-limit headers into snapshot
    this.lastRateLimit = parseRateLimitHeaders(upstream.headers)

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      if (upstream.status === 401) this.credentials.invalidate()

      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        status: upstream.status,
        msg: errText.slice(0, 200),
      })

      if (upstream.status === 429) {
        this.events.emit({
          level: 'error',
          kind: 'UPSTREAM_RATE_LIMITED',
          sessionId,
          resetAt: this.lastRateLimit.resetAt,
          retryAfterSec: this.lastRateLimit.retryAfter,
          requestKind: 'real',
          status: 429,
        })
      }

      return new Response(errText, {
        status: upstream.status,
        headers: upstream.headers,
      })
    }

    if (!upstream.body) {
      return new Response('No upstream body', { status: 502 })
    }

    // Tee SSE stream: one to caller, one for usage parsing
    let toClient: ReadableStream<Uint8Array>
    let toParse: ReadableStream<Uint8Array>
    try {
      const teed = upstream.body.tee()
      toClient = teed[0]
      toParse = teed[1]
    } catch (teeErr: any) {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `tee() failed: ${teeErr?.message}`,
      })
      return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
    }

    // Parse in background — extract usage + notify engine. Never crashes.
    void this.parseSSEAndNotify(toParse, session, sessionId, model, t0, reqLineageKey).catch((e) => {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `parse promise rejected: ${e?.message}`,
      })
    })

    // Return byte-for-byte stream to caller
    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    return new Response(toClient, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }

  // ─── Internal: engine factory per session ──────────────────────

  private createEngine(sessionId: string): KeepaliveEngine {
    const cfg = this.config
    return new KeepaliveEngine({
      config: {
        // Per-consumer TTL pin — see ProxyClientConfig.kaCacheTtlSec docs.
        // Default 300s matches native CC wire TTL; without this the engine
        // honored SSOT's 3600s and fired KAs against dead caches (the
        // 2026-05-17 SDK-0.15 incident root cause).
        cacheTtlMs: cfg.kaCacheTtlSec * 1000,
        // undefined → engine reads from SSOT (~/.claude/keepalive.json)
        intervalMs: cfg.kaIntervalSec !== undefined ? cfg.kaIntervalSec * 1000 : undefined,
        idleTimeoutMs: cfg.kaIdleTimeoutSec > 0 ? cfg.kaIdleTimeoutSec * 1000 : Infinity,
        minTokens: cfg.kaMinTokens,
        rewriteWarnIdleMs: cfg.kaRewriteWarnIdleSec * 1000,
        rewriteWarnTokens: cfg.kaRewriteWarnTokens,
        rewriteBlockIdleMs: cfg.kaRewriteBlockIdleSec > 0 ? cfg.kaRewriteBlockIdleSec * 1000 : Infinity,
        rewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
        onHeartbeat: (stats) => {
          // Record KA fire into metrics — they're the canonical hit-rate signal
          // since they replay the exact prompt prefix.
          this.metrics.recordRequest({
            kind: 'ka',
            cacheRead: stats.usage.cacheReadInputTokens ?? 0,
            cacheWrite: stats.usage.cacheCreationInputTokens ?? 0,
            input: stats.usage.inputTokens ?? 0,
            model: stats.model,
          })
          this.events.emit({
            level: 'info',
            kind: 'KA_FIRE_COMPLETE',
            sessionId,
            model: stats.model,
            durationMs: stats.durationMs,
            idleMs: stats.idleMs,
            usage: {
              inputTokens: stats.usage.inputTokens,
              outputTokens: stats.usage.outputTokens,
              cacheReadInputTokens: stats.usage.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: stats.usage.cacheCreationInputTokens ?? 0,
            },
            rateLimit: stats.rateLimit,
          })
        },
        onTick: (tick) => {
          // Use the engine's resolved intervalMs for "idle" threshold.
          // If kaIntervalSec was unset, fall back to a reasonable estimate (90% of resolved interval).
          const resolvedIntervalMs = (cfg.kaIntervalSec ?? 120) * 1000
          if (tick.idleMs > resolvedIntervalMs * 0.9) {
            this.events.emit({
              level: 'debug',
              kind: 'KA_TICK_IDLE',
              sessionId,
              idleMs: tick.idleMs,
              nextFireMs: tick.nextFireMs,
              model: tick.model,
              tokens: tick.tokens,
            })
          }
        },
        onDisarmed: (info) => this.events.emit({
          level: 'error',
          kind: 'KA_DISARM',
          sessionId,
          reason: info.reason,
          msg: `KA disarmed for session ${sessionId.slice(0, 8)} — reason=${info.reason}`,
        }),
        onRewriteWarning: (info) => this.events.emit({
          level: info.blocked ? 'error' : 'info',
          kind: info.blocked ? 'REWRITE_BLOCK' : 'REWRITE_WARN',
          sessionId,
          idleMs: info.idleMs,
          estimatedTokens: info.estimatedTokens,
          blocked: info.blocked,
          model: info.model,
        }),
        onNetworkStateChange: (info) => this.events.emit({
          level: info.to === 'degraded' ? 'error' : 'info',
          kind: info.to === 'degraded' ? 'NETWORK_DEGRADED' : 'NETWORK_HEALTHY',
          sessionId,
          from: info.from,
          to: info.to,
        }),
        onTtlScan: (info) => this.events.emit({
          level: 'info',
          kind: 'CACHE_TTL_CHANGED',
          sessionId,
          minTtlMs: info.minTtlMs,
          previousTtlMs: info.previousTtlMs,
          hasAnyCacheControl: info.hasAnyCacheControl,
          msg: `cache_control TTL ${info.previousTtlMs === null ? 'first-seen' : 'changed'} for session ${sessionId.slice(0, 8)} — ${info.previousTtlMs === null ? '?' : Math.round(info.previousTtlMs / 60000) + 'm'} → ${info.minTtlMs === null ? 'none' : Math.round(info.minTtlMs / 60000) + 'm'}`,
        }),
      },
      getToken: () => this.credentials.getAccessToken(),
      doFetch: (body, headers, signal) => this.engineDoFetch(body, headers, signal),
      getRateLimitInfo: () => this.lastRateLimit,
      isOwnerAlive: () => this.store.isOwnerAlive(sessionId),
    })
  }

  // ─── Internal: SSE-generator wrapper used by engine ────────────
  //
  // KeepaliveEngine expects doFetch to yield StreamEvent objects. We wrap
  // the IUpstreamFetcher (which returns a Response) into an async generator
  // that parses SSE and yields typed events.

  private async *engineDoFetch(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const bodyStr = JSON.stringify(body)
    const response = await this.upstream.fetch(
      `${this.config.anthropicBaseUrl}/v1/messages?beta=true`,
      { method: 'POST', headers, body: bodyStr, signal },
    )

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const err: Error & {
        status?: number
        resetAt?: number | null     // epoch SECONDS (Anthropic convention) — engine multiplies by 1000
        retryAfterSec?: number | null
      } = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      err.status = response.status
      if (response.status === 401) this.credentials.invalidate()
      if (response.status === 429) {
        // Parse rate-limit headers (engine path bypasses the real-request
        // header parser; do it inline so the emitted event carries resetAt).
        const rl = parseRateLimitHeaders(response.headers)
        this.lastRateLimit = rl
        // Attach to the thrown error so the KA engine can apply smart-pause
        // policy (cache_dies_at vs resetAt) instead of plain retry-chain.
        err.resetAt = rl.resetAt
        err.retryAfterSec = rl.retryAfter
        this.events.emit({
          level: 'error',
          kind: 'UPSTREAM_RATE_LIMITED',
          sessionId: null,
          resetAt: rl.resetAt,
          retryAfterSec: rl.retryAfter,
          requestKind: 'ka',
          status: 429,
        })
      }
      throw err
    }

    if (!response.body) throw new Error('No response body')

    // Parse SSE and yield StreamEvents (only what engine cares about)
    yield* parseSSEToEvents(response.body, signal)
  }

  // ─── Internal: parse consumer-facing stream for usage ──────────

  private async parseSSEAndNotify(
    stream: ReadableStream<Uint8Array>,
    session: Session<KeepaliveEngine>,
    sessionId: string,
    model: string,
    t0: number,
    lineageKey: string,
  ): Promise<void> {
    try {
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      let buffer = ''
      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          const r = await reader.read()
          done = r.done
          value = r.value
        } catch (readErr: any) {
          this.events.emit({
            level: 'debug',
            kind: 'REAL_REQUEST_ERROR',
            sessionId,
            msg: `stream read aborted: ${readErr?.message}`,
          })
          return
        }
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') continue
          try {
            const p = JSON.parse(raw)
            if (p.type === 'message_start' && p.message?.usage) {
              const u = p.message.usage
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
              }
              // Phase 3.B (REQ-05, OQ-02): TTL-split + deletion subfields.
              // Present only on responses that used 1h cache_control or
              // experienced compact_20260112 / cache_edits.clear_at. Forward
              // `undefined` when absent (not 0) — omit-when-absent contract.
              const cc = u.cache_creation
              if (cc && typeof cc === 'object') {
                if (typeof cc.ephemeral_5m_input_tokens === 'number') {
                  usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
                }
                if (typeof cc.ephemeral_1h_input_tokens === 'number') {
                  usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
                }
              }
              if (typeof u.cache_deleted_input_tokens === 'number') {
                usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
              }
            } else if (p.type === 'message_delta' && p.usage?.output_tokens) {
              usage.outputTokens = p.usage.output_tokens
            }
          } catch { /* malformed line, skip */ }
        }
      }

      const isFirstCall = session.lastUsage === null
      session.lastUsage = usage
      try {
        session.engine.notifyRealRequestComplete(usage, lineageKey)
      } catch (e: any) {
        this.events.emit({
          level: 'error',
          kind: 'REAL_REQUEST_ERROR',
          sessionId,
          msg: `engine.notifyRealRequestComplete: ${e?.message}`,
        })
      }

      // Record into rolling metrics for hit-rate / regression tracking.
      this.metrics.recordRequest({
        kind: 'real',
        cacheRead: usage.cacheReadInputTokens ?? 0,
        cacheWrite: usage.cacheCreationInputTokens ?? 0,
        input: usage.inputTokens ?? 0,
        model,
        firstCall: isFirstCall,
      })

      this.events.emit({
        level: 'info',
        kind: 'REAL_REQUEST_COMPLETE',
        sessionId,
        model,
        durationMs: Date.now() - t0,
        usage,
        rateLimit: {
          util5h: this.lastRateLimit.utilization5h,
          util7d: this.lastRateLimit.utilization7d,
          status: this.lastRateLimit.status,
        },
      })
    } catch (err: any) {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `SSE parse error: ${err?.message ?? err}`,
      })
    }
  }

  // ─── Internal: predicted cache-miss observability ──────────────
  //
  // Before forwarding, compare this request's cacheable-prefix fingerprint to
  // the previous request of the same (session, lineage). A divergence at the
  // system/tools block — or an idle gap past the cache TTL — predicts a
  // cache_creation rewrite. We NEVER block (the request is the user's work);
  // we classify + emit PREDICTED_CACHE_MISS so every rewrite is visible with
  // its cause: expected:* (cold-start / compact / tools-change — incl. the
  // user's "первичный запуск = норм") logs at info; avoidable:* / anomalous:*
  // log at error. Never throws — observability must not affect throughput.

  private predictCacheMiss(
    sessionId: string,
    lineageKey: string,
    body: Record<string, unknown>,
    bodyBytes: number,
  ): { rewriteClass: string; expected: boolean; predictedTokens: number } | null {
    try {
      const key = `${sessionId}:${lineageKey}`
      const now = Date.now()
      const ph = prefixHashes(body)
      const prev = this.prefixHistory.get(key)
      this.prefixHistory.set(key, { hashes: ph, lastReqAt: now })

      const isFirstRequest = !prev
      const systemChanged = !!prev && prev.hashes.system !== ph.system
      const toolsChanged = !!prev && prev.hashes.toolNames !== ph.toolNames
      const idleMs = prev ? now - prev.lastReqAt : undefined
      const ttlMs = this.config.kaCacheTtlSec * 1000

      // Prefix unchanged + within TTL → a cache HIT is expected; stay quiet.
      if (!isFirstRequest && !systemChanged && !toolsChanged
          && (idleMs === undefined || idleMs <= ttlMs)) {
        return null
      }

      const verdict = classifyRewrite({ isFirstRequest, toolsChanged, idleMs, ttlMs })
      // When the cacheable prefix diverges or expires, ~the whole context
      // re-caches. bodyBytes/4 is a rough token estimate — adequate for a
      // threshold check (the guard) and a human-readable log figure.
      const predictedTokens = Math.round(bodyBytes / 4)
      this.events.emit({
        level: verdict.expected ? 'info' : 'error',
        kind: 'PREDICTED_CACHE_MISS',
        sessionId,
        lineageKey,
        rewriteClass: verdict.class,
        expected: verdict.expected,
        systemChanged,
        toolsChanged,
        predictedTokens,
        idleMs: idleMs ?? null,
        ttlMs,
        msg: `predicted cache rewrite — ${verdict.class} (~${predictedTokens} tok)`
          + (systemChanged ? ' [system changed]' : '')
          + (toolsChanged ? ' [tools changed]' : '')
          + (idleMs !== undefined && idleMs > ttlMs
              ? ` [idle ${Math.round(idleMs / 1000)}s > ttl ${Math.round(ttlMs / 1000)}s]` : ''),
      })
      return { rewriteClass: verdict.class, expected: verdict.expected, predictedTokens }
    } catch {
      // Predictor is observability-only — never affect the request path.
      return null
    }
  }

  // ─── Internal: network error handler ───────────────────────────

  private handleNetworkError(sessionId: string, fetchErr: any): Response {
    const code = fetchErr?.code ?? fetchErr?.cause?.code ?? ''
    const msg = String(fetchErr?.message ?? '').toLowerCase()
    const isNetworkErr =
      NETWORK_ERROR_CODES.has(code) ||
      msg.includes('unable to connect') || msg.includes('failed to open socket') ||
      msg.includes('connection refused') || msg.includes('network')

    this.events.emit({
      level: 'error',
      kind: 'REAL_REQUEST_ERROR',
      sessionId,
      status: isNetworkErr ? 503 : 502,
      msg: `upstream fetch threw: ${code || ''} ${msg}`.trim().slice(0, 200),
    })

    if (isNetworkErr) {
      return new Response(JSON.stringify({
        type: 'error',
        error: {
          type: 'overloaded_error',
          message: 'Upstream network error — proxy cannot reach Anthropic. Retrying will help once network is restored.',
        },
      }), {
        status: 503,
        headers: {
          [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON,
          'retry-after': '2',
        },
      })
    }

    return new Response(JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `Upstream request failed: ${msg || code || 'unknown'}` },
    }), { status: 502, headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON } })
  }
}

// ═══ Module-level helpers ═══════════════════════════════════════════

const HOP_BY_HOP_OR_AUTH = [
  'host', 'content-length', 'connection', 'authorization',
  'accept-encoding',  // force uncompressed SSE
]

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
])

function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  return {
    status: headers.get('anthropic-ratelimit-unified-status'),
    resetAt: headers.get('anthropic-ratelimit-unified-reset')
      ? Number(headers.get('anthropic-ratelimit-unified-reset')) : null,
    claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
    retryAfter: headers.get('retry-after')
      ? parseFloat(headers.get('retry-after')!) : null,
    utilization5h: headers.get('anthropic-ratelimit-unified-5h-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-5h-utilization')!) : null,
    utilization7d: headers.get('anthropic-ratelimit-unified-7d-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-7d-utilization')!) : null,
  }
}

// ─── Prefix-history persistence (survives a proxy restart) ─────────
// In-memory prefix fingerprints were wiped on restart → first request of every
// session post-restart classified cold-start → rewrite guard blind. Persisting
// bridges restarts.

const PREFIX_HISTORY_PATH = join(homedir(), '.claude-local', 'proxy-prefix-history.json')
const PREFIX_HISTORY_MAX_AGE_MS = 60 * 60 * 1000   // prune entries older than 1h on load

function loadPrefixHistory(): Map<string, { hashes: PrefixHashes; lastReqAt: number }> {
  const m = new Map<string, { hashes: PrefixHashes; lastReqAt: number }>()
  try {
    const raw = JSON.parse(readFileSync(PREFIX_HISTORY_PATH, 'utf8')) as Record<string, { hashes: PrefixHashes; lastReqAt: number }>
    const cutoff = Date.now() - PREFIX_HISTORY_MAX_AGE_MS
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v.lastReqAt === 'number' && v.lastReqAt >= cutoff && v.hashes) m.set(k, v)
    }
  } catch { /* missing or corrupt → start empty */ }
  return m
}

function savePrefixHistory(m: Map<string, { hashes: PrefixHashes; lastReqAt: number }>): void {
  try {
    writeFileSync(PREFIX_HISTORY_PATH, JSON.stringify(Object.fromEntries(m)))
  } catch { /* best-effort — never break the request path */ }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON },
  })
}

/**
 * Inspect the LATEST user message for rewrite-guard purposes. Never throws.
 *
 *   isContinuation — the message carries a `tool_result` block → it is an
 *     agent tool-loop continuation, NOT a fresh user turn. The guard must NOT
 *     apply: the user has no message to add a marker to, so blocking would
 *     strand the loop forever. Such a request is always let through (the
 *     PREDICTED_CACHE_MISS log still records it).
 *   hasMarker — the override marker is present in this message's text. Only
 *     the latest user message is scanned, so a marker left in conversation
 *     history does NOT count — fresh-consent: the marker must be in the turn
 *     being sent now. This is why no marker-counting is needed: an old marker
 *     is structurally excluded by "latest message only".
 */
function inspectLastUserMessage(
  body: unknown,
  marker: string,
): { isContinuation: boolean; hasMarker: boolean } {
  const NONE = { isContinuation: false, hasMarker: false }
  try {
    const msgs = (body as { messages?: unknown })?.messages
    if (!Array.isArray(msgs)) return NONE
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m || typeof m !== 'object' || (m as { role?: unknown }).role !== 'user') continue
      const content = (m as { content?: unknown }).content
      let isContinuation = false
      let text = ''
      if (typeof content === 'string') {
        text = content
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown }
          if (b.type === 'tool_result') isContinuation = true
          if (typeof b.text === 'string') text += b.text + '\n'
        }
      }
      return { isContinuation, hasMarker: !!marker && text.includes(marker) }
    }
    return NONE
  } catch {
    return NONE
  }
}

/**
 * Parse Anthropic SSE stream into StreamEvent objects.
 * Only yields message_start / message_delta / message_stop — engine only
 * cares about usage. Other events (content_block_delta etc) are drained but
 * not yielded.
 */
async function* parseSSEToEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }

  try {
    while (true) {
      if (signal?.aborted) { reader.cancel(); return }
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6)
        if (raw === '[DONE]') continue
        let p: any
        try { p = JSON.parse(raw) } catch { continue }

        if (p.type === 'message_start' && p.message?.usage) {
          const u = p.message.usage
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          }
          // Phase 3.B (REQ-05): same TTL-split + deletion capture as
          // upstream.ts. Optional subfields forwarded `undefined` on absent.
          const cc = u.cache_creation
          if (cc && typeof cc === 'object') {
            if (typeof cc.ephemeral_5m_input_tokens === 'number') {
              usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
            }
            if (typeof cc.ephemeral_1h_input_tokens === 'number') {
              usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
            }
          }
          if (typeof u.cache_deleted_input_tokens === 'number') {
            usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
          }
        } else if (p.type === 'message_delta' && p.usage?.output_tokens) {
          usage.outputTokens = p.usage.output_tokens
        } else if (p.type === 'message_stop') {
          yield { type: 'message_stop', usage, stopReason: null }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
