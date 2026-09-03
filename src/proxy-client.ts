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

import { KeepaliveEngine, detectCacheTtlFromBody, upgradeCacheControlTtl } from './keepalive-engine.js'
import { EvictionCircuitBreaker } from './eviction-breaker.js'
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
import { prefixHashes, classifyRewrite, lineageKey, type PrefixHashes } from './lineage.js'
import { loadKeepaliveConfig } from './keepalive-config.js'
import { consumeConsent } from './rewrite-consent.js'
import { FileOrgIdResolver, readOrgInfoFromConfig, type OrgIdResolver } from './org-identity.js'
import { OrgVault } from './org-vault.js'
import {
  refreshOAuthToken,
  readClaudeCredentials,
  writeClaudeCredentials,
  getClaudeConfigDir,
  getDefaultCredentialsPath,
  OAuthRefreshError,
  type RefreshedTokens,
} from './auth.js'
import { acquireConfigDirLock } from './config-dir-lock.js'
import {
  EXPIRY_BUFFER_MS,
  PROACTIVE_REFRESH_RATIO,
  PROACTIVE_REFRESH_MIN_INTERVAL_MS,
  ORG_REFRESH_MARGIN_MS,
  DEFAULT_TOKEN_LIFETIME_MS,
  DEFAULT_KA_INTERVAL_SEC,
  REFRESH_FAILURE_COOLDOWN_BASE_MS,
  REFRESH_FAILURE_COOLDOWN_MAX_MS,
  REVOKE_RELOGIN_COOLDOWN_MS,
  DEFAULT_ORG_PROACTIVE_SWEEP_SEC,
} from './token-cadence.js'
import {
  writeRewriteBlockDump,
  DEFAULT_REWRITE_DUMP_DIR,
  type CachePrefix,
} from './rewrite-dump.js'
import {
  loadKaSnapshots,
  saveKaSnapshots,
  assessRevival,
  DEFAULT_KA_SNAPSHOT_PATH,
  KA_SNAPSHOT_MAX_AGE_MS,
  type PersistedSession,
} from './ka-snapshot-store.js'
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
  kaEvictionHoldSec?: number

  /**
   * Trips required within the hold window before the breaker engages. 1 = a
   * single detected eviction holds the fleet (matches "one burns → others back
   * off"). 2+ requires corroboration, avoiding a hold on a lone per-session
   * marker-slide. Default: 1.
   */
  kaEvictionMinTrips?: number

  /**
   * Cadence (SECONDS) of the daemon-owned per-org proactive refresh sweep. The
   * sweep refreshes EVERY vault org + the active org on its own budget-safe
   * cadence, independent of session traffic — the ONLY thing that keeps a
   * zero-live-session org's token alive (architect-review C2). 0 disables the
   * sweep (used by tests that drive `_runOrgProactiveSweep()` manually).
   * Default: 60.
   */
  orgProactiveRefreshSec?: number
}

// Note: kaIntervalSec intentionally NOT defaulted here.
// When undefined, KeepaliveEngine reads its default from
// ~/.claude/keepalive.json (SSOT) which auto-scales with cacheTtlMs.
//
// kaCacheTtlSec DEFAULTS to 3600 (1h): handleRequest upgrades native Claude
// Code's cache_control markers to ttl:'1h' before forwarding, so the wire TTL
// genuinely IS 1h. The autoscan downlock (notifyRealRequestStart) still pins a
// session to 5m if it ever observes an un-upgraded marker — so this default is
// a safe ceiling, not the 2026-05-17 wire-TTL mismatch. See ProxyClientConfig.
// ── Session-pin GC (T4.3) ──────────────────────────────────────────────────
// The vault accumulates a pin per session that ever held / auto-pinned an org
// (200+ incl. `synthetic-*` + the `rotate-probe-test` live-validation artifact).
// A pin is retired only when it is BOTH not currently tracked AND unseen beyond
// this age — never sooner, so a resumed conversation (same sessionId, new PID)
// keeps its HOLD binding within the window. `orgs` are NEVER touched.
const PIN_GC_MAX_AGE_DAYS = 7
const PIN_GC_MAX_AGE_MS = PIN_GC_MAX_AGE_DAYS * 24 * 60 * 60 * 1000
// A live pin's watermark is refreshed at most once per this window (the request
// path is hot; the vault already persists per response via markVerified).
const PIN_TOUCH_THROTTLE_MS = 60 * 60 * 1000   // 1 h

const DEFAULT_CONFIG: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & {
  kaIntervalSec: number | undefined
} = {
  anthropicBaseUrl: ANTHROPIC_API_BASE,
  kaCacheTtlSec: 3600,
  kaIntervalSec: undefined,
  kaIdleTimeoutSec: 0,
  kaMinTokens: 2000,
  kaRewriteWarnIdleSec: 300,
  kaRewriteWarnTokens: 50000,
  kaRewriteBlockIdleSec: 0,
  kaRewriteBlockEnabled: false,
  kaEvictionHoldSec: 300,
  // Require TWO distinct genuine evictions within the window before holding the
  // fleet (was 1). Layer-0c DISARMS siblings on a trip — for idle sessions that
  // means cache death, so a lone trip should not stampede the fleet. Combined
  // with the primary-lineage role gate (keepalive-engine eviction block), this
  // makes a fleet hold require real corroboration, not one session's cold-write.
  kaEvictionMinTrips: 2,
  orgProactiveRefreshSec: DEFAULT_ORG_PROACTIVE_SWEEP_SEC,
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

  /**
   * Optional: how to resolve the current Anthropic org UUID — used by the
   * rewrite guard to detect a cross-org cache replay (`anomalous:org-switch`).
   * Default: FileOrgIdResolver reading `~/.claude.json`.
   */
  orgIdResolver?: OrgIdResolver

  /**
   * Optional: where to persist the cache-prefix history (so the miss
   * predictor + rewrite guard survive a proxy restart). Default:
   * `~/.claude-local/proxy-prefix-history.json`. Injectable for test
   * isolation — production never sets it.
   */
  prefixHistoryPath?: string

  /**
   * Optional: directory for rewrite-guard block dumps (the rejected request
   * + prefix diff, written on every block for offline analysis). Default:
   * `~/.claude-local/rewrite-guard-blocks/`. Injectable for test isolation.
   */
  rewriteBlockDumpDir?: string

  /**
   * Optional: wall-clock time (ms) this proxy process started. Default:
   * `Date.now()` at construction. Used to recognise a TTL expiry that spans
   * a proxy restart (the KA engine could not have kept the cache warm across
   * a gap in which it did not exist) so the guard does not block it.
   * Injectable for tests.
   */
  proxyStartedAt?: number

  /**
   * Optional: where to persist the KA snapshot registry so KA survives a
   * proxy restart (idle sessions keep their cache warm across a deploy).
   * Default: `~/.claude-local/proxy-ka-snapshots.json`. Injectable for tests.
   */
  kaSnapshotPath?: string

  /**
   * Optional: per-organization credential vault (multi-org sessions). Stores
   * every credential ever seen keyed by org UUID + session→org pin bindings,
   * so a cross-org login never loses the previous org's tokens and a proxy
   * restart restores HOLDs. Injectable for tests (pass a tmp-path OrgVault).
   * Default: OrgVault at `~/.claude-local/org-vault.json`.
   */
  orgVault?: OrgVault

  /**
   * Optional: the Claude config directory (`~/.claude`) whose `.credentials.json`
   * holds the ACTIVE org's credential. The per-org choke-point co-writes this
   * file under the config-dir lock when it refreshes the active org. Injectable
   * for tests. Default: `getClaudeConfigDir()`.
   */
  claudeConfigDir?: string

  /**
   * Optional: path to `.credentials.json` (the active org's on-disk credential).
   * Injectable for tests. Default: `getDefaultCredentialsPath()`.
   */
  credentialsPath?: string

  /**
   * Optional: the OAuth refresh-grant function. Injectable for tests so the
   * choke-point can be exercised without real network. Default: the real
   * `refreshOAuthToken` (POSTs the Anthropic token endpoint).
   */
  oauthRefresher?: (refreshToken: string) => Promise<RefreshedTokens>

  /**
   * Optional: acquire the cross-process config-dir lock (for the active-org
   * `.credentials.json` co-write). Resolves to a release fn, or null if a peer
   * holds it. Injectable for tests. Default: `acquireConfigDirLock` (proper-lockfile).
   */
  acquireConfigLock?: (configDir: string) => Promise<(() => Promise<void>) | null>
}

/** One persisted cache-prefix fingerprint, keyed by `${sessionId}:${lineageKey}`. */
interface PrefixHistoryEntry {
  hashes: PrefixHashes
  /** Timestamp of the last REAL request for this lineage. */
  lastReqAt: number
  /** Org UUID under which this prefix was last cached — `null` when unknown.
   *  Absent in entries written before org-awareness; loaded as `null`. */
  orgId: string | null
  /** Timestamp of the last KA fire that warmed this lineage's cache. A KA
   *  fire refreshes the Anthropic-side prefix TTL just like a real request —
   *  so the cache-miss predictor must treat it as a cache touch. Without
   *  this, a user who idles past TTL while KA keeps the cache warm gets a
   *  FALSE `avoidable:ttl-expiry` (the predictor saw only real-request idle)
   *  and the rewrite guard blocks a request whose cache is actually hot. */
  lastKaAt?: number
}

// ═══ Request context (per handleRequest call) ══════════════════════

export interface HandleRequestContext {
  /** Unique identifier for the logical session. */
  sessionId: string

  /** OS PID of the consumer process (for JIT liveness check). */
  sourcePid?: number | null

  /** Abort signal for the upstream fetch. */
  signal?: AbortSignal

  /**
   * Имя СУБАГЕНТА, если ход принадлежит ему (`x-claude-code-agent-id`).
   *
   * 🔴 ЗАЧЕМ, И ЭТО КУПЛЕНО ЧУЖИМ СЧЁТОМ (02.09.2026). Сторож перезаписи
   * останавливает ход и говорит человеку, что набрать, чтобы продолжить. У
   * субагента человека НЕТ ВООБЩЕ: его отказ никто не видит, а перезапуск
   * родителя не спасает уже погибшую работу. Путь спасения при этом
   * СУЩЕСТВУЕТ — согласие за субагента выдаёт его родитель, — но об этом
   * никто не знал, потому что отказ об этом не говорил. У соседнего проекта
   * так погиб проверщик целиком: три прочитанных документа и несостоявшийся
   * отчёт.
   *
   * Заголовок доезжает сюда доводом, а не читается из `headers`: там к этому
   * месту уже стоит наша подстановка (см. clientUserAgent).
   */
  agentId?: string | null

  /**
   * WHO called, as the caller named itself — the `user-agent` of the INCOMING
   * request, taken before anything of ours touches it.
   *
   * 🔴 ЗАЧЕМ ОТДЕЛЬНОЕ ПОЛЕ, А НЕ `headers['user-agent']` НА МЕСТЕ ЗАПИСИ
   * (замерено 29.08.2026, я привёз эту ошибку и поймал её живой проверкой):
   * к `handleRequest` приезжают уже ПЕРЕПИСАННЫЕ заголовки — для чужого
   * клиента прокси подставляет туда `claude-cli/…`, чтобы подписка приняла
   * запрос. Прочитанное там имя ВСЕГДА наше собственное, одинаковое для всех
   * звонящих, и в журнале выглядит как ответ, не будучи им. Настоящее имя
   * живёт только до обогащения, поэтому и передаётся сюда доводом.
   */
  clientUserAgent?: string | null

  /**
   * Whether this request comes from an INTERACTIVE human (native Claude Code),
   * as opposed to a programmatic endpoint client (OpenAI-compat /v1/chat/
   * completions, or an external Anthropic-API consumer). The rewrite guard is a
   * human consent checkpoint — when `rewriteGuard.interactiveOnly` is true
   * (default), guard blocking applies ONLY to interactive requests; programmatic
   * clients (interactive=false) are let through (logged) since they cannot
   * re-send with an override marker. Default true (preserves native-CC behavior).
   */
  interactive?: boolean

  /**
   * WHICH DOOR named this session — the header (`x-claude-code-session-id`),
   * the body (`metadata.user_id`), or nothing at all.
   *
   * `'none'` means the caller could not be named and `sessionId` is a synthetic
   * `anon-*` label minted for THIS request only. Such a request is served
   * normally, but it must never arm keepalive: the slot it would create can
   * never be matched by a later request, so KA would warm a cache nobody will
   * ever read.
   *
   * MEASURED 2026-08-18 on the live proxy (research/cache-accounting-remeasure-
   * 2026-08-18.md): 463 of 521 persisted prefixes were such one-shot `anon-*`
   * keys — EVERY ONE of them with exactly one entry, i.e. never matched again.
   * 428 were still being warmed a median of 8.7h (max 24.8h) after their single
   * request, and in one 29-minute window 70 of 89 KA fires (79%) and 6 592 380
   * cache-read tokens (36%) were spent on sessions that could not return.
   *
   * Recorded on every `REAL_REQUEST_START` so "this session never reached the
   * proxy" and "this session reached it unnamed" stay distinguishable in the
   * journal. Default `'header'` (back-compat for callers that pre-date this).
   */
  idSource?: 'header' | 'body' | 'none'
}

// ═══ Rate limit snapshot (exposed for introspection) ═══════════════

export interface RateLimitSnapshot {
  status: string | null
  /** Когда сбрасывается ПЯТИЧАСОВОЕ окно, epoch-секунды. Это то окно, которое останавливает
   * работу, и то, что человек имеет в виду, спрашивая «когда отпустит». */
  resetAt: number | null
  /** Когда сбрасывается НЕДЕЛЬНОЕ окно, epoch-секунды. Отдельное поле, потому что часы разные:
   * замерено в один момент — пятичасовое через 13 минут, недельное через 142 часа. Одно число не
   * может стоять за оба, и потребитель, показывающий «сброс в …», обязан сказать, какое именно. */
  resetAt7d?: number | null
  claim: string | null
  retryAfter: number | null
  utilization5h: number | null
  utilization7d: number | null
}

// ═══ ProxyClient ═══════════════════════════════════════════════════

/**
 * Per-session pinned account: the org + token a session is bound to. Captured at
 * bind time (first request, or a rebind via `[%reload-ok%]` / cli reload).
 * In-memory only — a proxy restart rebinds every session to the current account.
 * `expiresAt` is the pinned token's expiry (null = unknown ⇒ treat as alive,
 * the upstream-401 path is the stop condition).
 */
interface SessionPin {
  orgId: string | null
  token: string
  expiresAt: number | null
}

export class ProxyClient {
  private readonly config: Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }
  private readonly metrics: CacheMetricsCollector
  private readonly credentials: ICredentialsProvider
  private readonly events: IEventEmitter
  private readonly store: ISessionStore<KeepaliveEngine>
  private readonly upstream: IUpstreamFetcher
  private readonly liveness: ILivenessChecker

  // Bounded, abortable backoff for TRANSIENT upstream faults (5xx / 529) on the
  // REAL request path — smooths seconds-long Anthropic capacity blips so they
  // don't surface to Claude Code as a hard error requiring a manual re-resume.
  // Short by design; not a substitute for surviving a multi-minute outage.
  // Overridable in tests via (client as any).realRetryDelaysMs.
  //
  // THREE RUNGS, NOT FOUR — measured 2026-08-24 over 8 days of the live log
  // (claude-max-proxy.jsonl, 298 requests that took at least one retry):
  //   rung 1 → 23 successes /  3 failures
  //   rung 2 →  5 successes /  1 failure
  //   rung 3 →  2 successes /  0 failures
  //   rung 4 →  2 successes / 248 failures   ← 0.8%, and it cost 8s each time
  // A capacity blip that outlives rung 3 is a MINUTES-long upstream window
  // (05:04–05:56Z that morning: requests over 2 MB failed 152 of 153), which no
  // backoff can outwait. Keeping the 4th rung bought 2 requests in 250 and spent
  // one extra upstream call per failure at exactly the moment upstream is
  // shedding load — plus 8s of a client whose measured patience is ~1.8s median
  // (232 'client stopped reading' aborts), so the wait was usually thrown away.
  private readonly realRetryDelaysMs: readonly number[] = [1_000, 2_000, 4_000]
  // Absolute ceiling for any single backoff wait (caps a large upstream
  // retry-after and the jittered baseline). Overridable in tests.
  private readonly retryCeilingMs: number = 10_000
  // Jitter source for de-syncing concurrent retries; Math.random in prod,
  // pinned in tests via (client as any).retryRandom for deterministic delays.
  private readonly retryRandom: () => number = Math.random

  private readonly reaperTimer: ReturnType<typeof setInterval>
  private lastRateLimit: RateLimitSnapshot = {
    status: null, resetAt: null, resetAt7d: null, claim: null, retryAfter: null,
    utilization5h: null, utilization7d: null,
  }

  /** Previous request's cacheable-prefix fingerprint per `${sessionId}:${lineageKey}`.
   *  Persisted to disk (loadPrefixHistory) so the cache-miss predictor + rewrite
   *  guard survive a proxy restart — otherwise the first request of every
   *  session post-restart looks like a cold-start and the guard is blind. */
  private readonly prefixHistory: Map<string, PrefixHistoryEntry>

  /** Where prefixHistory is persisted — configurable for test isolation. */
  private readonly prefixHistoryPath: string

  /** Directory for rewrite-guard block dumps. */
  private readonly rewriteBlockDumpDir: string

  /** Wall-clock ms this proxy process started — a cache warm-up older than
   *  this means the TTL gap spans a restart (KA could not have prevented it). */
  private readonly proxyStartedAt: number

  /** Last Claude Code version seen in a request's billing header — a change
   *  churns the cacheable prefix; tracked to emit CC_VERSION_CHANGED. */
  /**
   * Claude Code version last seen PER SESSION.
   *
   * It used to be one field for the whole fleet, and that was fine while every
   * agent on a machine ran the same CLI. It stopped being fine when several
   * versions started living side by side: whichever session sent the last
   * request overwrote the field, so the next session's request looked like a
   * version change to a version it had never left. Measured 2026-08-20: SIX
   * versions in use at once (2.1.177, .197, .234, .235, .236, .237) and 3676
   * "version changed" events across 157 sessions in a day — one session alone
   * flip-flopped 457 times between two versions it was never actually on.
   *
   * The event claims "the cacheable prefix changed", so a reader chasing a
   * rewrite spike was being pointed at innocent sessions thousands of times a
   * day, and a REAL version change for one agent was unfindable in the noise.
   */
  private lastCcVersionBySession = new Map<string, string>()

  /** Where the KA snapshot registry is persisted (configurable for tests). */
  private readonly kaSnapshotPath: string
  /** True while the snapshot file cannot be written — dedupes the alarm. */
  private kaSnapshotPersistFailing = false

  /** Set when a KA registry mutated since the last persist — bounds writes
   *  to "only when something changed" (bodies are large; no blind 10s saves). */
  private kaSnapshotDirty = false

  /** Lineage keys (`${sessionId}:${lineageKey}`) whose persisted KA snapshot
   *  was DROPPED at startup (cache already dead). The next real request for
   *  such a lineage is a genuine rewrite the guard should surface — see
   *  predictCacheMiss / classifyRewrite's `kaRevivalDropped`. */
  private readonly kaReviveDropped: Set<string> = new Set()

  /** Last cacheable prefix (system + tools) seen per `${sessionId}:${lineageKey}`.
   *  In-memory only (never persisted — bodies are large) — feeds the prefix
   *  diff written into a guard-block dump. Reaped with prefixHistory. */
  private readonly lineagePrefix: Map<string, CachePrefix> = new Map()

  /** Per-session pinned account (org+token). Keyed by sessionId. In-memory only;
   *  reaped with the session. Drives forward token selection (hold cross-org /
   *  adopt same-org / rebind on marker+reload / 401 on cross-org expiry). */
  private readonly sessionPins: Map<string, SessionPin> = new Map()
  /** Per-org credential vault + persisted pin bindings (multi-org support). */
  private readonly orgVault: OrgVault
  /** One-shot consents from an explicit `switchSessionOrg` — exempts the very
   *  next request's org-switch from the rewrite guard (maintenance rotate). */
  private readonly orgRotateConsent: Set<string> = new Set()
  /** Per-session org actually served by Anthropic (response header evidence). */
  private readonly lastServedOrg: Map<string, string> = new Map()
  /** Single-flight refresh guard per orgId. */
  private readonly orgRefreshInflight: Map<string, Promise<void>> = new Map()
  /** Last successful refresh (epoch ms) per orgId — the H2 min-interval floor. */
  private readonly orgLastRefreshAt: Map<string, number> = new Map()
  /** Per-org refresh-failure cooldown (H3): back off before forcing again. */
  private readonly orgRefreshCooldown: Map<string, { until: number; attempts: number; needsRelogin: boolean }> = new Map()
  /** Daemon-owned proactive per-org refresh sweep timer (C2). */
  private orgProactiveTimer: ReturnType<typeof setInterval> | null = null
  /** Config dir (`~/.claude`) + `.credentials.json` path — active-org co-write. */
  private readonly claudeConfigDir: string
  private readonly credentialsPath: string
  /** OAuth refresh-grant fn (injectable for tests). */
  private readonly oauthRefresher: (refreshToken: string) => Promise<RefreshedTokens>
  /** Config-dir lock acquirer (injectable for tests). */
  private readonly acquireConfigLock: (configDir: string) => Promise<(() => Promise<void>) | null>

  /** Resolves the current Anthropic org UUID — drives org-switch detection. */
  private readonly orgIdResolver: OrgIdResolver

  /** Shared across every per-session KA engine — fleet-wide eviction-storm hold. */
  private readonly evictionBreaker: EvictionCircuitBreaker

  constructor(opts: ProxyClientOptions) {
    this.config = { ...DEFAULT_CONFIG, ...opts.config }
    this.evictionBreaker = new EvictionCircuitBreaker({
      cooldownMs: this.config.kaEvictionHoldSec * 1000,
      minTripsToEngage: this.config.kaEvictionMinTrips,
    })
    this.credentials = opts.credentialsProvider
    this.events = opts.eventEmitter ?? new ConsoleEventEmitter()
    // Startup confirmation: the eviction breaker is otherwise silent until it
    // trips, so emit one line at boot so operators can verify the fleet-wide
    // cache-eviction guard is armed (and with what thresholds).
    this.events.emit({
      level: 'info',
      kind: 'EVICTION_BREAKER_ARMED',
      cooldownSec: this.config.kaEvictionHoldSec,
      minTrips: this.config.kaEvictionMinTrips,
      enabled: this.config.kaEvictionHoldSec > 0,
    })
    this.liveness = opts.livenessChecker ?? new DefaultLivenessChecker()
    this.store = opts.sessionStore ?? new InMemorySessionStore<KeepaliveEngine>(this.liveness)
    this.upstream = opts.upstreamFetcher ?? new NativeFetchUpstream()
    this.orgIdResolver = opts.orgIdResolver ?? new FileOrgIdResolver()
    this.prefixHistoryPath = opts.prefixHistoryPath ?? PREFIX_HISTORY_PATH
    this.rewriteBlockDumpDir = opts.rewriteBlockDumpDir ?? DEFAULT_REWRITE_DUMP_DIR
    this.proxyStartedAt = opts.proxyStartedAt ?? Date.now()
    this.kaSnapshotPath = opts.kaSnapshotPath ?? DEFAULT_KA_SNAPSHOT_PATH
    this.orgVault = opts.orgVault ?? new OrgVault()
    this.claudeConfigDir = opts.claudeConfigDir ?? getClaudeConfigDir()
    this.credentialsPath = opts.credentialsPath ?? getDefaultCredentialsPath()
    this.oauthRefresher = opts.oauthRefresher ?? refreshOAuthToken
    this.acquireConfigLock = opts.acquireConfigLock ?? acquireConfigDirLock
    this.prefixHistory = loadPrefixHistory(this.prefixHistoryPath)

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
        for (const k of this.lineagePrefix.keys()) {
          if (k.startsWith(sid + ':')) this.lineagePrefix.delete(k)
        }
        for (const k of this.kaReviveDropped) {
          if (k.startsWith(sid + ':')) this.kaReviveDropped.delete(k)
        }
        this.sessionPins.delete(sid)  // drop the per-session org/token pin
        this.lastCcVersionBySession.delete(sid)
        this.kaSnapshotDirty = true   // a reaped session must leave the KA file
      }
      // Session-pin GC (T4.3): age out vault pins for long-dead sessions so the
      // binding table can't grow unbounded (the 200+ `synthetic-*` /
      // `rotate-probe-test` accumulation). A reaped pid_gone session keeps its
      // vault pin for the grace window (a resumed conversation restores its
      // HOLD); it is retired only once unseen > N days AND not live. Never drops
      // an `orgs` credential.
      this.gcSessionPins()
      // Persist prefix history each reaper tick so it survives a proxy restart.
      savePrefixHistory(this.prefixHistory, this.prefixHistoryPath)
      // Persist the KA snapshot registry, but only when something changed —
      // snapshot bodies are large, so no unconditional 10s writes.
      if (this.kaSnapshotDirty) {
        this.persistKaSnapshots()
        this.kaSnapshotDirty = false
      }
    }, 10_000)
    if (this.reaperTimer && typeof this.reaperTimer === 'object' && 'unref' in this.reaperTimer) {
      (this.reaperTimer as any).unref()
    }

    // Revive KA engines for sessions whose cache is provably still warm —
    // last step of construction so every dependency above is ready.
    this.reviveKaSnapshots()

    // Daemon-owned proactive per-org refresh sweep (C2). A keepalive daemon
    // exists to keep caches warm for clients that have GONE AWAY, so token
    // freshness cannot be coupled to session traffic — this loop refreshes
    // EVERY org on its own budget-safe cadence, independent of KA fires. It is
    // the only thing that keeps a zero-live-session org alive. 0 disables it
    // (tests drive `_runOrgProactiveSweep()` directly).
    const sweepSec = this.config.orgProactiveRefreshSec
    if (sweepSec && sweepSec > 0) {
      this.orgProactiveTimer = setInterval(() => {
        void this.proactiveOrgSweep()
      }, sweepSec * 1000)
      if (this.orgProactiveTimer && typeof this.orgProactiveTimer === 'object' && 'unref' in this.orgProactiveTimer) {
        (this.orgProactiveTimer as any).unref()
      }
    }
  }

  // ─── Public getters ─────────────────────────────────────────────

  /** Current rate-limit snapshot from last upstream response. */
  get rateLimitSnapshot(): Readonly<RateLimitSnapshot> { return this.lastRateLimit }

  /** List all tracked sessions (for stats endpoints). */
  listSessions(): Session<KeepaliveEngine>[] { return this.store.list() }

  /** Total session count. */
  sessionCount(): number { return this.store.size() }

  /** Mark a session as Worker-managed (heartbeat-based liveness instead of PID). */
  markManagedSession(sessionId: string, workerId: string, ttlMs?: number): boolean {
    return (this.store as any).markManaged?.(sessionId, workerId, ttlMs) ?? false
  }

  /** Worker heartbeat — refresh liveness for all Worker's sessions. */
  workerHeartbeat(workerId: string, activeSessionIds: string[]): number {
    return (this.store as any).workerHeartbeat?.(workerId, activeSessionIds) ?? 0
  }

  /** Unmark a session as Worker-managed. */
  unmarkManagedSession(sessionId: string): boolean {
    return (this.store as any).unmarkManaged?.(sessionId) ?? false
  }

  /** Config used by this client (read-only). */
  get configSnapshot(): Readonly<Omit<Required<ProxyClientConfig>, 'kaIntervalSec'> & { kaIntervalSec: number | undefined }> { return this.config }

  /** Snapshot of current rolling cache-metrics window. */
  get cacheMetricsSnapshot() { return this.metrics.summary() }

  // ─── Lifecycle ─────────────────────────────────────────────────

  /** Clean shutdown — stops reaper, metrics collector, and all KA engines in store. */
  stop(): void {
    clearInterval(this.reaperTimer)
    if (this.orgProactiveTimer) clearInterval(this.orgProactiveTimer)
    savePrefixHistory(this.prefixHistory, this.prefixHistoryPath)
    // Final KA-snapshot persist — must run BEFORE store.stopAll() empties the
    // engines, so a clean shutdown leaves a current registry to revive from.
    this.persistKaSnapshots()
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
    // Drop the per-session pin(s) → the next request REBINDS to the current
    // org+token. cli reload is the explicit "switch to current org" trigger:
    // global (no sessionId) rebinds all; targeted rebinds one.
    if (sessionId) this.sessionPins.delete(sessionId)
    else this.sessionPins.clear()
    // Re-sync BOTH caches in lock-step — a reload follows a credential/org swap.
    this.credentials.invalidate()
    this.orgIdResolver.invalidate()
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
  notifyCredentialsChanged(reason: string): void {
    this.credentials.invalidate()
    this.orgIdResolver.invalidate()
    this.events.emit({ level: 'info', kind: 'CREDENTIALS_CHANGED', reason })
    // Vault: capture the NEW credential under its org before anything uses it.
    // (The previous org's entry is untouched — orgs are separate accounts, so
    // a cross-org login must never cost us the old org's tokens.) THEN — once the
    // fresh token is mirrored — proactively push it to every session frozen on the
    // changed org: a native RE-LOGIN revokes the old token, so a session still
    // replaying it in its KA would 401 and, if idle, never self-heal (re-login-
    // revoke incident 2026-07-23, session ab787846). Reconciling here turns
    // thousands of reactive per-session 401 recoveries (4712 `recovered-peer`
    // that day, many too late) into ONE proactive push.
    void this.snapshotCurrentAccount('credentials-changed')
      .then(() => { this.reconcileFrozenSessionsForChangedOrg() })
      .catch(() => { /* fail-soft — the KA-401 frozen-replay fall-through remains the backstop */ })
  }

  /**
   * Proactive re-login/refresh reconcile (re-login-revoke incident 2026-07-23).
   * The fresh disk credential belongs to org X; a native RE-LOGIN to X revokes
   * X's previous token. Every session SERVED BY X that is currently frozen on an
   * org-switch-pending snapshot token is replaying that now-revoked token in its
   * KA — and an idle one issues no real request to discover the rotation, so it
   * 401s until `auth_retry_exhausted` → disarm → its warm cache ages out and dies.
   *
   * Unfreeze those sessions here so their KA re-arms with X's CURRENT token on the
   * next tick — proactively, not reactively per-401. This is a token SWAP only
   * (the pin / served org is unchanged; `getTokenForSession` still resolves X) —
   * never a cross-org migration. Best-effort by design: a session this org
   * resolution misses (e.g. multi-process `.claude.json` org oscillation) is
   * still caught by the KA-401 frozen-replay fall-through (the guaranteed backstop).
   */
  private reconcileFrozenSessionsForChangedOrg(): void {
    // "Which org did the fresh disk credential belong to?" has no single reliable
    // signal at fs.watch time (the account file's org can lag / oscillate under
    // multiple CC processes), so consider BOTH — the active resolver AND the
    // account-file org — as candidate changed orgs. A frozen session whose served
    // org is either is thawed. Anything this misses (rare oscillation) is still
    // caught reactively by the KA-401 frozen-replay fall-through.
    const candidates = new Set<string>()
    const active = this.orgIdResolver.current()
    if (active) candidates.add(active)
    const cfgOrg = readOrgInfoFromConfig().orgId
    if (cfgOrg) candidates.add(cfgOrg)
    if (candidates.size === 0) return
    let thawedSessions = 0
    let thawedLineages = 0
    for (const s of this.store.list()) {
      const served = this.resolveServedOrg(s.sessionId)
      if (!served || !candidates.has(served)) continue
      const n = s.engine.clearAllOrgSwitchPending()
      if (n > 0) { thawedSessions++; thawedLineages += n }
    }
    if (thawedSessions > 0) {
      this.events.emit({
        level: 'info', kind: 'ORG_TOKEN_REFRESHED',
        orgId: [...candidates].join(','), reason: 'relogin-reconcile',
        sessions: thawedSessions, lineages: thawedLineages,
        msg: `credentials changed (org ${[...candidates].map(o => o.slice(0, 8)).join('/')}) — `
          + `proactively thawed ${thawedLineages} frozen KA lineage(s) across ${thawedSessions} `
          + `served session(s) so their KA adopts the fresh token before any 401`,
      })
    }
  }

  /** Test seam — run the credentials-change frozen-session reconcile directly. */
  _reconcileFrozenSessionsForChangedOrg(): void { this.reconcileFrozenSessionsForChangedOrg() }

  /** Test seam — how many KA lineages a session is currently frozen (org-switch-pending) on. */
  _sessionFrozenLineages(sessionId: string): number {
    const s = this.store.list().find(x => x.sessionId === sessionId)
    return s ? s.engine._orgSwitchPending.size : 0
  }

  /** Test seam — how many cache lineages this session's KA engine has been
   *  PRIMED with. Zero is the whole invariant for an UNIDENTIFIED request
   *  (`idSource:'none'`): with no lineage primed there is no pending snapshot
   *  to commit, so the KA registry can never fill and tick() finds nothing to
   *  fire. Unknown session → 0. */
  _sessionPrimedLineages(sessionId: string): number {
    const s = this.store.list().find(x => x.sessionId === sessionId)
    return s ? s.engine._lineageStats.size : 0
  }

  /**
   * Snapshot the system credential file's current token into the per-org
   * vault, keyed by the org that owns it. Fail-soft, never throws — the vault
   * is strictly additive safety. Called on startup-ish (first request) and on
   * every credentials-file change.
   */
  async snapshotCurrentAccount(reason: string): Promise<void> {
    try {
      const token = await this.credentials.getAccessToken()
      const { orgId, orgName, accountEmail } = readOrgInfoFromConfig()
      const resolvedOrg = orgId ?? this.orgIdResolver.current()
      if (!resolvedOrg || !token) return
      this.orgVault.upsert({
        orgId: resolvedOrg,
        orgName: orgName ?? undefined,
        accountEmail: accountEmail ?? undefined,
        accessToken: token,
        refreshToken: this.credentials.currentRefreshToken?.() ?? null,
        expiresAt: this.credentials.currentExpiresAt?.() ?? null,
        capturedAt: Date.now(),
      })
      this.events.emit({ level: 'debug', kind: 'ORG_VAULT_SNAPSHOT', orgId: resolvedOrg, reason })
    } catch { /* fail-soft */ }
  }

  // ─── Per-org token freshness — the single choke-point (M2/C1/H1/H2/H3) ───
  //
  // EVERY use of a pinned-org token routes through `withFreshOrgToken`:
  // real-request held/persisted pins, the KA-fire fast path, the force-on-401
  // backstop, and the daemon proactive sweep. It enforces the invariant "any
  // use of an org token is preceded by a check-and-refresh" at ONE seam, so a
  // new consumer cannot silently bypass it (the KA-path bypass this evolution
  // fixes). It BRANCHES active-vs-vault:
  //   - ACTIVE org → refresh + co-write `.credentials.json` under the native
  //                  CLI's config-dir `proper-lockfile` lock (never rotate the
  //                  shared refresh_token into a vault-only store — that would
  //                  strand the disk token for the native CLI, architect C1);
  //   - VAULT org  → refresh + `orgVault.upsert` (proxy-owned, in-process
  //                  single-flight only — no cross-process lock, architect H1).

  /** True when `orgId` is the machine's ACTIVE org (the one in `.credentials.json`). */
  private isActiveOrg(orgId: string): boolean {
    const active = this.orgIdResolver.current()
    return active !== null && active === orgId
  }

  /** Token metadata for `orgId` — from disk for the active org, from the vault
   *  otherwise. `capturedAt` (lifetime estimate) comes from the vault mirror
   *  even for the active org. Null when there is nothing to refresh. */
  private orgTokenMeta(orgId: string): { accessToken: string | null; refreshToken: string | null; expiresAt: number | null; capturedAt: number | null } | null {
    if (this.isActiveOrg(orgId)) {
      const disk = readClaudeCredentials(this.credentialsPath)?.claudeAiOauth
      if (!disk) return null
      const ve = this.orgVault.get(orgId)
      return {
        accessToken: disk.accessToken ?? null,
        refreshToken: disk.refreshToken ?? null,
        expiresAt: disk.expiresAt ?? null,
        capturedAt: ve?.capturedAt ?? null,
      }
    }
    const e = this.orgVault.get(orgId)
    if (!e) return null
    return { accessToken: e.accessToken, refreshToken: e.refreshToken, expiresAt: e.expiresAt, capturedAt: e.capturedAt }
  }

  /** Proactive refresh-due test (H2): remaining < min(kaInterval+margin, RATIO×lifetime),
   *  floored at the cheap 5-min expiry buffer. Never couples to a bare interval. */
  private isRefreshDueByExpiry(meta: { expiresAt: number | null; capturedAt: number | null }): boolean {
    if (meta.expiresAt === null) return false      // unknown expiry → 401 backstop is the guard
    const now = Date.now()
    const remaining = meta.expiresAt - now
    if (remaining <= 0) return true
    const lifetime = (meta.capturedAt !== null && meta.expiresAt > meta.capturedAt)
      ? meta.expiresAt - meta.capturedAt
      : DEFAULT_TOKEN_LIFETIME_MS
    const kaIntervalMs = (this.config.kaIntervalSec ?? DEFAULT_KA_INTERVAL_SEC) * 1000
    const intervalMargin = kaIntervalMs + ORG_REFRESH_MARGIN_MS
    const threshold = Math.min(intervalMargin, PROACTIVE_REFRESH_RATIO * lifetime)
    return remaining < Math.max(threshold, EXPIRY_BUFFER_MS)
  }

  /** Per-org failure cooldown (H3): a forced refresh must not fire while backing off. */
  private inFailureCooldown(orgId: string, now: number): boolean {
    const cd = this.orgRefreshCooldown.get(orgId)
    return !!cd && cd.until > now
  }

  /** H2 min-interval floor — caps PROACTIVE grant frequency regardless of token length. */
  private minRefreshIntervalElapsed(orgId: string, now: number): boolean {
    const last = this.orgLastRefreshAt.get(orgId) ?? 0
    return now - last >= PROACTIVE_REFRESH_MIN_INTERVAL_MS
  }

  private recordRefreshSuccess(orgId: string, now: number): void {
    this.orgLastRefreshAt.set(orgId, now)
    this.orgRefreshCooldown.delete(orgId)     // clear any prior failure backoff
  }

  /** Record a failed grant → exponential backoff; classify a revoke → needs-relogin. */
  private recordRefreshFailure(orgId: string, err: unknown, now: number): void {
    const prev = this.orgRefreshCooldown.get(orgId)
    const attempts = (prev?.attempts ?? 0) + 1
    const revoke = err instanceof OAuthRefreshError && err.isInvalidGrant
    if (revoke) {
      const wasRelogin = prev?.needsRelogin === true
      this.orgRefreshCooldown.set(orgId, { until: now + REVOKE_RELOGIN_COOLDOWN_MS, attempts, needsRelogin: true })
      if (!wasRelogin) {
        // Emit once per entry into the needs-relogin state (parity with CC
        // tengu_oauth_token_refresh_error on a hard revoke).
        this.events.emit({
          level: 'error', kind: 'ORG_TOKEN_NEEDS_RELOGIN', orgId,
          msg: `org ${orgId.slice(0, 8)} refresh_token revoked (invalid_grant) — run: claude login for that org`,
        })
      }
    } else {
      const backoff = Math.min(REFRESH_FAILURE_COOLDOWN_BASE_MS * 2 ** (attempts - 1), REFRESH_FAILURE_COOLDOWN_MAX_MS)
      this.orgRefreshCooldown.set(orgId, { until: now + backoff, attempts, needsRelogin: false })
    }
    this.events.emit({
      level: 'error', kind: 'ORG_TOKEN_REFRESH_FAILED', orgId, revoke,
      msg: String((err as Error)?.message ?? err).slice(0, 200),
    })
  }

  /**
   * The single choke-point: return a FRESH access token for `orgId`, refreshing
   * first when due (or `force`). Returns the current token when no refresh is
   * needed/possible (fail-soft — the upstream-401 path stays the hard stop).
   */
  private async withFreshOrgToken(orgId: string, opts: { force?: boolean; reason?: string } = {}): Promise<string | null> {
    const meta = this.orgTokenMeta(orgId)
    if (!meta) return null
    if (!meta.refreshToken) return meta.accessToken       // nothing to refresh with
    const now = Date.now()

    if (!opts.force) {
      // Proactive/fast-path: refresh only when actually due AND the min-interval
      // floor has elapsed (H2 — a short token can't force a grant every fire).
      if (!this.isRefreshDueByExpiry(meta)) return meta.accessToken
      if (!this.minRefreshIntervalElapsed(orgId, now)) return meta.accessToken
    }
    // Both proactive and force respect the FAILURE cooldown (H3 — a revoke must
    // not be re-forced on every REARM-ladder slot). Force bypasses only the
    // min-interval floor (a genuine 401 must be able to recover).
    if (this.inFailureCooldown(orgId, now)) return meta.accessToken

    // Single-flight per org (coalesce concurrent fires → exactly ONE grant).
    const inflight = this.orgRefreshInflight.get(orgId)
    if (inflight) {
      await inflight.catch(() => {})
      return this.orgTokenMeta(orgId)?.accessToken ?? meta.accessToken
    }
    const reason = opts.reason ?? (opts.force ? 'force-401' : 'proactive')
    const run = this.isActiveOrg(orgId)
      ? this.refreshActiveOrg(orgId, meta.refreshToken, reason)
      : this.refreshVaultOrg(orgId, meta, reason)
    this.orgRefreshInflight.set(orgId, run.then(() => {}, () => {}))
    try {
      return await run
    } finally {
      this.orgRefreshInflight.delete(orgId)
    }
  }

  /**
   * ACTIVE-org refresh (C1): grant → co-write `.credentials.json` atomically
   * under the native CLI's config-dir `proper-lockfile` lock → mirror into the
   * vault → invalidate the proxy token cache so `getAccessToken` re-reads.
   * NEVER rotates the shared refresh_token into a vault-only store. Returns the
   * fresh access token (or the current disk token on lock-contention / failure).
   */
  private async refreshActiveOrg(orgId: string, refreshToken: string, reason: string): Promise<string | null> {
    const release = await this.acquireConfigLock(this.claudeConfigDir)
    if (!release) {
      // A peer / the native CLI holds the lock (mid-refresh). Re-read disk — the
      // winner will have written a fresh token — and use whatever is there.
      this.credentials.invalidate()
      const disk = readClaudeCredentials(this.credentialsPath)?.claudeAiOauth
      return disk?.accessToken ?? null
    }
    try {
      // Triple-check under lock (race_resolved): a peer / the native CLI may
      // have refreshed while we waited. Detect it by refresh_token identity —
      // if the on-disk refresh_token ROTATED away from the one we entered with,
      // a peer already refreshed: adopt the disk token, skip our grant (mirror
      // CC's "storage holds a different token → use it"). Same token → no peer,
      // proceed to grant.
      const diskNow = readClaudeCredentials(this.credentialsPath)?.claudeAiOauth
      if (diskNow?.accessToken && diskNow.refreshToken && diskNow.refreshToken !== refreshToken) {
        this.credentials.invalidate()
        this.events.emit({ level: 'info', kind: 'ORG_TOKEN_REFRESHED', orgId, active: true, reason: 'race-resolved' })
        return diskNow.accessToken
      }
      const grantToken = diskNow?.refreshToken ?? refreshToken
      const fresh = await this.oauthRefresher(grantToken)
      // Write-before-use: persist the rotated refresh_token to DISK first, so the
      // native CLI + every other consumer see it; then mirror into the vault.
      writeClaudeCredentials(this.credentialsPath, {
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        scopes: fresh.scopes,
      })
      const info = readOrgInfoFromConfig()
      this.orgVault.upsert({
        orgId,
        orgName: info.orgName ?? undefined,
        accountEmail: info.accountEmail ?? undefined,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        capturedAt: Date.now(),
      })
      this.credentials.invalidate()
      this.recordRefreshSuccess(orgId, Date.now())
      this.events.emit({ level: 'info', kind: 'ORG_TOKEN_REFRESHED', orgId, active: true, reason })
      return fresh.accessToken
    } catch (err) {
      this.recordRefreshFailure(orgId, err, Date.now())
      const disk = readClaudeCredentials(this.credentialsPath)?.claudeAiOauth
      return disk?.accessToken ?? null
    } finally {
      try { await release() } catch { /* release best-effort */ }
    }
  }

  /**
   * VAULT (non-active) org refresh (M1): grant → `orgVault.upsert` (write-before-use).
   * Proxy-owned single-writer store → in-process single-flight only, NO
   * cross-process lock (H1). Returns the fresh access token (or the current one
   * on failure — fail-soft).
   */
  private async refreshVaultOrg(
    orgId: string,
    meta: { accessToken: string | null; refreshToken: string | null; expiresAt: number | null; capturedAt: number | null },
    reason: string,
  ): Promise<string | null> {
    const entry = this.orgVault.get(orgId)
    const refreshToken = entry?.refreshToken ?? meta.refreshToken
    if (!refreshToken) return meta.accessToken
    try {
      const fresh = await this.oauthRefresher(refreshToken)
      // Write-before-use: the rotated refresh_token lands in the vault BEFORE the
      // new access token is handed back to serve/replay anything.
      this.orgVault.upsert({
        orgId,
        orgName: entry?.orgName,
        accountEmail: entry?.accountEmail,
        accessToken: fresh.accessToken,
        refreshToken: fresh.refreshToken,
        expiresAt: fresh.expiresAt,
        capturedAt: Date.now(),
        lastVerifiedAt: entry?.lastVerifiedAt,
      })
      this.recordRefreshSuccess(orgId, Date.now())
      this.events.emit({ level: 'info', kind: 'ORG_TOKEN_REFRESHED', orgId, active: false, reason })
      return fresh.accessToken
    } catch (err) {
      this.recordRefreshFailure(orgId, err, Date.now())
      return entry?.accessToken ?? meta.accessToken
    }
  }

  /**
   * Force-on-401 backstop (H3), mirroring CC's `handleOAuth401Error`: re-read
   * the served org's token — if a peer already rotated it (different token),
   * adopt that with no grant; else force ONE refresh (cooldown-gated). Wired
   * into the KA engine's `onAuthError`.
   */
  private async handleOrg401(orgId: string, failedToken: string): Promise<void> {
    const current = this.orgTokenMeta(orgId)?.accessToken
    if (current && current !== failedToken) {
      // A peer / native-CLI already refreshed — the next getToken() picks it up.
      this.events.emit({ level: 'info', kind: 'ORG_TOKEN_REFRESHED', orgId, reason: 'recovered-peer' })
      return
    }
    await this.withFreshOrgToken(orgId, { force: true, reason: 'force-401' })
  }

  /**
   * The org a session is CURRENTLY serving its token from — the pinned org when
   * held, else the machine's active org (mirror `selectSessionToken`'s decision).
   * The KA fast path, the KA 401 backstop, AND the real-request 401 backstop all
   * resolve the served org through this ONE seam, so every path force-refreshes
   * the SAME org whose token was actually sent.
   */
  private resolveServedOrg(sessionId: string): string | null {
    return this.sessionPins.get(sessionId)?.orgId ?? this.orgIdResolver.current()
  }

  /**
   * Resolve the org a session is CURRENTLY SERVING (mirror `selectSessionToken`:
   * a held cross-org session serves its pinned org; everything else serves the
   * active org) and return a FRESH token for it (M3). Used by the KA `getToken`
   * fast path so an idle held session warms the RIGHT org's cache with a
   * refreshed token — not the active account's (the proxy-client:1489 bug).
   */
  private async getTokenForSession(sessionId: string): Promise<string> {
    const pin = this.sessionPins.get(sessionId)
    const servedOrg = this.resolveServedOrg(sessionId)
    if (servedOrg) {
      const fresh = await this.withFreshOrgToken(servedOrg, { reason: 'ka-fast-path' })
      if (fresh) return fresh
    }
    // Fall back: a held cross-org pin with no refreshable vault token keeps its
    // last-known token (never silently warm the active org for a held session);
    // otherwise the active disk token.
    if (pin && pin.orgId !== null && pin.orgId !== this.orgIdResolver.current() && pin.token) {
      return pin.token
    }
    return this.credentials.getAccessToken()
  }

  /**
   * Daemon-owned proactive sweep (C2): refresh EVERY vault org + the active org
   * on its own budget-safe cadence, independent of session traffic. This is the
   * ONLY thing that keeps a zero-live-session org's token alive. Fail-soft per org.
   */
  private async proactiveOrgSweep(): Promise<void> {
    const seen = new Set<string>()
    const active = this.orgIdResolver.current()
    if (active) {
      seen.add(active)
      try { await this.withFreshOrgToken(active, { reason: 'proactive-loop' }) } catch { /* cooldown handles it */ }
    }
    for (const e of this.orgVault.list()) {
      if (seen.has(e.orgId)) continue
      seen.add(e.orgId)
      try { await this.withFreshOrgToken(e.orgId, { reason: 'proactive-loop' }) } catch { /* fail-soft */ }
    }
  }

  /** Test seam — run one proactive sweep synchronously. */
  async _runOrgProactiveSweep(): Promise<void> { return this.proactiveOrgSweep() }

  /**
   * Session-pin GC (T4.3): retire vault pins whose session is NEITHER currently
   * tracked in the store NOR seen within `PIN_GC_MAX_AGE_MS`. A currently-live
   * session is always kept regardless of watermark age; a legacy pin with no
   * watermark is seeded on first sweep (a full grace window before it can age
   * out). NEVER drops an `orgs` credential — only `pins`. Runs on the reaper
   * tick and drops the paired in-memory pin too.
   */
  private gcSessionPins(now = Date.now()): void {
    const live = new Set(this.store.list().map(s => s.sessionId))
    const retired = this.orgVault.gcPins(
      (sid, lastSeenAt) => live.has(sid) || (now - lastSeenAt) <= PIN_GC_MAX_AGE_MS,
      now,
    )
    for (const sid of retired) {
      this.sessionPins.delete(sid)
      this.events.emit({
        level: 'info', kind: 'ORG_PIN_GC', sessionId: sid,
        msg: `retired dead-session pin (no live session, unseen > ${PIN_GC_MAX_AGE_DAYS}d)`,
      })
    }
  }

  /** Test seam — run one pin-GC pass at a controlled clock. */
  _gcSessionPins(now = Date.now()): void { return this.gcSessionPins(now) }

  /** Test seam — read the per-org cooldown state (H3 assertions). */
  _orgCooldown(orgId: string): { until: number; attempts: number; needsRelogin: boolean } | undefined {
    return this.orgRefreshCooldown.get(orgId)
  }

  /** Test seam — direct choke-point invocation. */
  async _withFreshOrgToken(orgId: string, opts: { force?: boolean; reason?: string } = {}): Promise<string | null> {
    return this.withFreshOrgToken(orgId, opts)
  }

  /** Test seam — force-on-401 backstop for a served org (H3 assertions). */
  async _forceOrg401(orgId: string, failedToken: string): Promise<void> {
    return this.handleOrg401(orgId, failedToken)
  }

  /**
   * Explicit maintenance rotate: bind `sessionId` to `orgQuery`'s org using
   * the vault's credential for it. This is the `claude-max org switch`
   * backend. It does NOT weaken the rewrite guard — it grants exactly ONE
   * org-switch consent for this session (equivalent in strength to the
   * existing `[%reload-ok%]` marker, but scoped and org-targeted).
   */
  async switchSessionOrg(sessionId: string, orgQuery: string): Promise<
    | { ok: true; orgId: string; orgName?: string; refreshed: boolean }
    | { ok: false; error: string }
  > {
    // Make sure the CURRENT account is in the vault too (so switching back is
    // always possible, and switching TO the current org works by id).
    await this.snapshotCurrentAccount('org-switch')
    const entry = this.orgVault.resolve(orgQuery)
    if (!entry) {
      return { ok: false, error: `no vault entry matches "${orgQuery}" — known orgs: ${this.orgVault.list().map(e => `${e.orgId.slice(0, 8)}(${e.orgName ?? '?'})`).join(', ') || 'none'}` }
    }
    let refreshed = false
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      await this.withFreshOrgToken(entry.orgId, { force: true, reason: 'org-switch' })
      const after = this.orgVault.get(entry.orgId)
      if (!after || (after.expiresAt !== null && after.expiresAt <= Date.now())) {
        return { ok: false, error: `org ${entry.orgId.slice(0, 8)} token expired and refresh failed — log into that org once to recapture` }
      }
      refreshed = true
    }
    const live = this.orgVault.get(entry.orgId)!
    this.sessionPins.set(sessionId, { orgId: live.orgId, token: live.accessToken, expiresAt: live.expiresAt })
    this.orgVault.setPin(sessionId, live.orgId)
    this.orgRotateConsent.add(sessionId)
    this.events.emit({
      level: 'info', kind: 'ORG_PIN_ROTATED', sessionId,
      orgId: live.orgId, msg: `session pinned to org ${live.orgId.slice(0, 8)} (${live.orgName ?? '?'}) by explicit rotate`,
    })
    return { ok: true, orgId: live.orgId, orgName: live.orgName, refreshed }
  }

  /** Org surface snapshot for /admin/orgs — tokens redacted. */
  orgSurface(): {
    orgs: Array<{ orgId: string; orgName?: string; accountEmail?: string; expiresAt: number | null; hasRefreshToken: boolean; capturedAt: number; lastVerifiedAt?: number }>
    sessions: Array<{ sessionId: string; pinnedOrg: string | null; servedOrg: string | null }>
  } {
    const orgs = this.orgVault.list().map(e => ({
      orgId: e.orgId, orgName: e.orgName, accountEmail: e.accountEmail, expiresAt: e.expiresAt,
      hasRefreshToken: !!e.refreshToken, capturedAt: e.capturedAt, lastVerifiedAt: e.lastVerifiedAt,
    }))
    const ids = new Set<string>([...this.sessionPins.keys(), ...this.lastServedOrg.keys()])
    const sessions = [...ids].map(sid => ({
      sessionId: sid,
      pinnedOrg: this.sessionPins.get(sid)?.orgId ?? null,
      servedOrg: this.lastServedOrg.get(sid) ?? null,
    }))
    return { orgs, sessions }
  }

  /**
   * Per-org token health for the heartbeat (T4.1 observability). Surfaces the
   * MINIMUM remaining lifetime across the active + every vault org, how many are
   * already expired, and how many are flagged needs-relogin (an `invalid_grant`
   * revoke classified by `recordRefreshFailure`). A stranded / −42h org is thus
   * VISIBLE in `HEALTH_HEARTBEAT` before a session ever needs it — the L1 gap
   * where the −42h relish org stayed invisible until manual inspection.
   */
  orgTokenHealth(): { orgs: number; minOrgExpiresInSec: number | null; orgsExpired: number; orgsNeedRelogin: number } {
    const now = Date.now()
    const expiries: number[] = []          // epoch ms, known-expiry orgs only
    const seen = new Set<string>()
    const active = this.orgIdResolver.current()
    if (active) {
      seen.add(active)
      const meta = this.orgTokenMeta(active)
      if (meta?.expiresAt != null) expiries.push(meta.expiresAt)
    }
    for (const e of this.orgVault.list()) {
      if (seen.has(e.orgId)) continue
      seen.add(e.orgId)
      if (e.expiresAt != null) expiries.push(e.expiresAt)
    }
    const orgsExpired = expiries.filter(ms => ms <= now).length
    const minMs = expiries.length ? Math.min(...expiries) : null
    const minOrgExpiresInSec = minMs === null ? null : Math.floor((minMs - now) / 1000)
    let orgsNeedRelogin = 0
    for (const cd of this.orgRefreshCooldown.values()) if (cd.needsRelogin) orgsNeedRelogin++
    return { orgs: seen.size, minOrgExpiresInSec, orgsExpired, orgsNeedRelogin }
  }

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
  private selectSessionToken(
    sessionId: string,
    account: { orgId: string | null; token: string; expiresAt: number | null },
    reloadAsked: boolean,
    now: number,
  ): { token: string; stop: boolean; held: boolean } {
    const pin = this.sessionPins.get(sessionId)
    if (!pin || reloadAsked) {
      this.sessionPins.set(sessionId, { ...account })
      return { token: account.token, stop: false, held: false }
    }
    if (pin.orgId === null || account.orgId === null || pin.orgId === account.orgId) {
      pin.token = account.token            // same org → adopt the fresh token
      pin.expiresAt = account.expiresAt
      return { token: account.token, stop: false, held: false }
    }
    if (pin.expiresAt === null || now < pin.expiresAt) {
      return { token: pin.token, stop: false, held: true }   // cross-org, alive → HOLD
    }
    return { token: pin.token, stop: true, held: false }      // cross-org, expired → force-stop
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
    // An UNNAMED caller is served, but never warmed — its sessionId is minted
    // per request, so a keepalive slot opened under it is unreachable forever
    // after. See HandleRequestContext.idSource for the measurement.
    const idSource = ctx.idSource ?? 'header'
    const unidentified = idSource === 'none'

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

    // Detect a Claude Code version change. A CC version bump rewrites the
    // cached system text + tool definitions → a new lineage → one cold cache
    // rewrite per active session. It is otherwise invisible (it happens in
    // the background); surfacing it as an explicit event makes the rewrite
    // spike attributable instead of a silent mystery.
    {
      const ccVersion = extractCcVersion(parsedBody)
      const prevForSession = this.lastCcVersionBySession.get(sessionId) ?? null
      if (ccVersion && ccVersion !== prevForSession) {
        const prev = prevForSession
        this.lastCcVersionBySession.set(sessionId, ccVersion)
        if (prev !== null) {
          this.events.emit({
            level: 'info',
            kind: 'CC_VERSION_CHANGED',
            sessionId,
            previousVersion: prev,
            version: ccVersion,
            msg: `Claude Code version ${prev} -> ${ccVersion} — the cacheable `
              + `prefix changed; expect one cold cache rewrite per active session`,
          })
        }
      }
    }

    // Build upstream headers: strip hop-by-hop + consumer auth, force identity encoding
    const upstreamHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase()
      if (HOP_BY_HOP_OR_AUTH.includes(lk)) continue
      upstreamHeaders[k] = v
    }
    upstreamHeaders['accept-encoding'] = 'identity'

    // Inject OAuth bearer — per-session org/token pin selection (Layer 2).
    // A cross-org login does NOT migrate a live session: it HOLDS the old
    // org+token until an explicit switch (`[%reload-ok%]` / cli reload) or a
    // force condition (old token expired). Same-org refresh adopts the fresh
    // token seamlessly.
    let orgHeld = false   // this session is holding a previous org (KA must warm the OLD cache)
    // Hoisted to the guard's scope below: an explicit `[%reload-ok%]` is the
    // user consenting to migrate THIS session to the current org, so it must
    // exempt the org-switch from the rewrite guard exactly like an active HOLD
    // does — otherwise the documented org-swap path would demand a second,
    // different marker. (Defaults false on any credentials read failure.)
    let reloadAsked = false
    // One-shot consent from an explicit switchSessionOrg rotate (maintenance).
    let rotateConsumed = false
    // The EXACT bearer token placed on the upstream request — captured in fn
    // scope so the upstream-401 backstop below can force-refresh the SERVED org
    // keyed by the token that was actually rejected (mirror handleOrg401's
    // failed-token contract). Set once the Authorization header is built.
    let sentToken: string | null = null
    try {
      const account = {
        orgId: this.orgIdResolver.current(),
        token: await this.credentials.getAccessToken(),
        expiresAt: this.credentials.currentExpiresAt?.() ?? null,
      }
      reloadAsked = inspectLastUserMessage(
        parsedBody, loadKeepaliveConfig().rewriteGuard.reloadMarker,
      ).hasMarker
      // Vault: make sure the CURRENT account is captured (first-request lazy
      // snapshot — startup equivalent), and restore a persisted pin binding
      // for this session if the proxy restarted since it was set.
      void this.snapshotCurrentAccount('lazy')
      // Refresh this session's pin-GC watermark (throttled — at most 1 vault
      // write/hour/session). No-op unless the session has a persisted pin; keeps
      // an actively-used HOLD/auto-pin from ageing out of the GC window (T4.3).
      this.orgVault.touchPin(sessionId, Date.now(), PIN_TOUCH_THROTTLE_MS)
      if (!this.sessionPins.has(sessionId) && !reloadAsked) {
        const persisted = this.orgVault.getPin(sessionId)
        if (persisted && persisted.orgId !== account.orgId) {
          await this.withFreshOrgToken(persisted.orgId, { reason: 'real-request' })
          const ve = this.orgVault.get(persisted.orgId)
          if (ve && (ve.expiresAt === null || ve.expiresAt > Date.now())) {
            this.sessionPins.set(sessionId, { orgId: ve.orgId, token: ve.accessToken, expiresAt: ve.expiresAt })
            this.events.emit({
              level: 'info', kind: 'ORG_PIN_RESTORED', sessionId,
              msg: `session pin restored from vault after proxy restart — holding org ${ve.orgId.slice(0, 8)}`,
            })
          } else {
            this.orgVault.deletePin(sessionId)  // dead binding — fall through to normal bind
          }
        }
      }
      // Vault: a session HOLDing a non-current org gets its held token kept
      // fresh from the vault (refresh grant) instead of dying at expiry.
      {
        const pin = this.sessionPins.get(sessionId)
        if (pin && pin.orgId !== null && account.orgId !== null && pin.orgId !== account.orgId) {
          await this.withFreshOrgToken(pin.orgId, { reason: 'real-request' })
          const ve = this.orgVault.get(pin.orgId)
          if (ve && ve.accessToken !== pin.token && (ve.expiresAt === null || ve.expiresAt > Date.now())) {
            pin.token = ve.accessToken
            pin.expiresAt = ve.expiresAt
          }
        }
      }
      rotateConsumed = this.orgRotateConsent.delete(sessionId)
      const sel = this.selectSessionToken(sessionId, account, reloadAsked, Date.now())
      if (sel.stop) {
        this.events.emit({
          level: 'error',
          kind: 'ORG_PIN_EXPIRED',
          sessionId,
          msg: 'pinned previous-org token expired — reload required to continue on the current org',
        })
        return jsonResponse(401, {
          error: {
            type: 'authentication_error',
            message: 'This session was pinned to a previous organization whose access token has now '
              + 'expired. Re-send your message with [%reload-ok%] (or run a proxy reload) to continue '
              + 'on the current organization — expect a one-time large cache rewrite.',
          },
        })
      }
      if (sel.held) {
        orgHeld = true
        // Persist the HOLD binding (orgId only — tokens live in the vault's
        // org entries). Auto-captured pins are otherwise in-memory, so a
        // proxy restart would silently rebind every held session to the
        // current org = the exact forced cross-org cache rewrite HOLD exists
        // to prevent. Guard on getPin to avoid a vault write per request.
        const heldOrgId = this.sessionPins.get(sessionId)?.orgId
        if (heldOrgId && this.orgVault.getPin(sessionId)?.orgId !== heldOrgId) {
          this.orgVault.setPin(sessionId, heldOrgId)
        }
        this.events.emit({
          level: 'info',
          kind: 'ORG_PIN_HELD',
          sessionId,
          msg: 'cross-org login detected — holding this session on its previous org+token (no migration)',
        })
      }
      upstreamHeaders[HEADER_AUTHORIZATION] = `Bearer ${sel.token}`
      sentToken = sel.token
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

    // Lift native Claude Code's cache_control markers from the implicit 5-minute
    // ephemeral TTL to ttl:'1h'. Native CC marks its stable system+tools+history
    // prefix with `cache_control:{type:'ephemeral'}`; a coding turn routinely
    // runs longer than 5 minutes, so that prefix dies mid-turn and the next turn
    // re-caches ~140K tokens (cache_creation ≈ 111× a cache_read). Anthropic
    // honors ttl:'1h' only under the prompt-caching-scope beta — which native CC
    // already sends — so gate on it. Done BEFORE notifyRealRequestStart +
    // predictCacheMiss so the KA engine's wire autoscan and the rewrite guard
    // both measure against the cache TTL actually forwarded upstream.
    let forwardBodyStr = rawBodyStr
    {
      const beta = upstreamHeaders[HEADER_ANTHROPIC_BETA] ?? upstreamHeaders['Anthropic-Beta'] ?? ''
      if (beta.includes('prompt-caching-scope-2026-01-05')) {
        const { upgraded } = upgradeCacheControlTtl(parsedBody)
        if (upgraded > 0) forwardBodyStr = JSON.stringify(parsedBody)
      }
    }

    // Compute the lineage key WITHOUT priming — lineageKey(body) is pure, so the
    // rewrite guard can decide BEFORE any keepalive mutation. (Matches the value
    // notifyRealRequestStart returns on the proceed path below.)
    const reqLineageKey = lineageKey(parsedBody)

    // Assess (PURE — no history writes) so a blocked request never advances
    // state. The commit (prefix-history write + KA prime) happens only if the
    // request proceeds past the guard.
    const assessed = this.assessCacheMiss(sessionId, reqLineageKey, parsedBody, bodyBytes)
    const rewriteAssessment = assessed?.assessment ?? null

    // Rewrite guard — when enabled, an avoidable/anomalous rewrite above the
    // configured token threshold that has NOT been consented is rejected with
    // 400 for EVERY consumer: interactive human, automated agent, programmatic
    // endpoint, AND tool-loop continuation. No silent expensive re-cache ever
    // slips through. `expected:*` rewrites (compact / tools-changed) are never
    // blocked — with ONE exception: an `expected:cold-start` whose predicted
    // write exceeds minColdStartTokens blocks too (founder directive
    // 2026-06-12: a model switch maps the session to a fresh lineage, so a
    // 342k-context re-cache sailed through as a "cold start" with no consent
    // step). This does NOT save the cost — the re-sent request
    // re-caches the same — it converts a silent quota spend into an explicit,
    // consented one. Consent has TWO channels:
    //   1. `overrideMarker` in the latest user message — for an interactive
    //      human or an LLM agent that controls its next message text; OR
    //   2. a single-use, short-TTL session-scoped GRANT file (consumeConsent) —
    //      the actionable channel for consumers that cannot inject a message
    //      marker at block time (tool_result continuations, programmatic
    //      clients, an out-of-band orchestrator deciding for a sub-agent):
    //      `context cache-rewrite-ok <sessionId>`.
    {
      const guard = loadKeepaliveConfig().rewriteGuard
      // org-switch stands down ONLY when Layer 2 actually absorbs the cost:
      // either this session HOLDS its old org+token (no cross-org burn), or
      // the user EXPLICITLY reloaded into the current org ([%reload-ok%] =
      // consent to migrate). When neither holds — a pin lost to a proxy
      // restart or a global `claude-max reload` — an org-switch is a real
      // silent cross-org cold rewrite; the guard MUST surface it (block +
      // consent), not delegate to a Layer 2 that isn't there. (2026-06-08:
      // a global reload cleared all pins 2s before a switch → ~526K tok
      // burned on the new org with no block and no signal.)
      const blockAvoidable = !!rewriteAssessment && !rewriteAssessment.expected
        && !(rewriteAssessment.signals.orgChanged && (orgHeld || reloadAsked || rotateConsumed))
        && rewriteAssessment.predictedTokens >= guard.minRewriteTokens
      // Founder directive 2026-06-12: a HUGE first write for a new lineage is
      // an unconfirmed quota spend even though it is "expected" — stop and ask
      // for the same consent. Routine session starts and compacted resumes sit
      // far below minColdStartTokens and never prompt.
      const blockColdStart = !!rewriteAssessment
        && rewriteAssessment.rewriteClass === 'expected:cold-start'
        && rewriteAssessment.predictedTokens >= guard.minColdStartTokens
      if (guard.enabled && rewriteAssessment && (blockAvoidable || blockColdStart)) {
        // Consent check. Inspect the in-message marker first (no side effect);
        // only when it is ABSENT consume a session grant (single-use). The
        // short-circuit OR guarantees a marker'd turn never burns a grant.
        const lastMsg = inspectLastUserMessage(parsedBody, guard.overrideMarker)
        const consented = lastMsg.hasMarker
          || consumeConsent(guard.consentGrantPath, sessionId)
        if (!consented) {
          // Dump the blocked request + prefix diff for offline analysis.
          let dumpPath: string | null = null
          if (guard.dumpBlocked) {
            // Snapshot what we KNEW about this session, before anything prunes
            // it. A dump that says only `noBaseline: true` cannot distinguish a
            // genuine first turn from a baseline that was swept — and the sweep
            // happens on session death and by age on load, i.e. long before a
            // person opens the file.
            const sessionPrefix = `${sessionId}:`
            const siblingLineages: Array<{ lineageKey: string; lastReqAgeMs: number | null }> = []
            const nowMs = Date.now()
            for (const [key, entry] of this.prefixHistory) {
              if (!key.startsWith(sessionPrefix)) continue
              siblingLineages.push({
                lineageKey: key.slice(sessionPrefix.length),
                lastReqAgeMs: entry.lastReqAt ? nowMs - entry.lastReqAt : null,
              })
            }
            const thisEntry = this.prefixHistory.get(`${sessionId}:${reqLineageKey}`)
            const lastSeenAt = thisEntry
              ? Math.max(thisEntry.lastReqAt ?? 0, thisEntry.lastKaAt ?? 0)
              : 0
            dumpPath = writeRewriteBlockDump(this.rewriteBlockDumpDir, {
              sessionId,
              lineageKey: reqLineageKey,
              rewriteClass: rewriteAssessment.rewriteClass,
              predictedTokens: rewriteAssessment.predictedTokens,
              signals: rewriteAssessment.signals,
              blockedRequest: parsedBody,
              previousPrefix: rewriteAssessment.prevPrefix,
              sessionState: {
                sessionOnRecord: siblingLineages.length > 0,
                lineageOnRecord: !!thisEntry,
                siblingLineages,
                historyEntriesTotal: this.prefixHistory.size,
                proxyStartedAt: this.proxyStartedAt || null,
                spansProxyRestart: !!this.proxyStartedAt && lastSeenAt > 0
                  && lastSeenAt < this.proxyStartedAt,
              },
            })
          }
          // TWO DIFFERENT EVENTS, and the word "rewrite" hid the difference.
          // A cold start WRITES a large cache for the FIRST time — nothing is
          // being re-cached, there was no cache, and the spend is repaid by
          // every later read. A ttl-expiry or org-switch THROWS AWAY a cache we
          // already paid for and buys it again. Both need consent (founder,
          // 2026-06-12), but calling them the same thing made the log unreadable:
          // a dump named `expected_cold-start` with 448 104 tokens sat in a
          // directory called rewrite-guard-blocks and read as a rewrite, while
          // its own prefixDiff said `noBaseline: true, systemLen.prev = 0`.
          // Nth-in-a-row, counted by the thing that does the refusing. One
          // refusal is a question the caller can answer; a run of them is a wall
          // that answering will not move, and until now the two looked the same
          // from every side. See Session.rewriteBlockStreak for the measurement.
          const prevStreak = session.rewriteBlockStreak?.count ?? 0
          const streak = prevStreak + 1
          session.rewriteBlockStreak = {
            count: streak,
            lastAt: Date.now(),
            lastClass: rewriteAssessment.rewriteClass,
          }

          // When the account changed, paying is not the only way out — and the
          // block used to offer no other. The cache still exists on the account
          // that built it, so if we can still speak for that account, binding
          // the session back makes this very turn a free READ instead of a
          // ~half-million-token purchase. Measured 2026-08-21: five sessions
          // were asked to pay 476k each the morning after a re-login, while the
          // previous account's token sat alive in the vault the whole time.
          let freeReadHint = ''
          try {
            const owner = rewriteAssessment.signals?.prevOrgId
            if (rewriteAssessment.signals?.orgChanged && owner) {
              const ve = this.orgVault.get(owner)
              if (ve && (ve.expiresAt === null || ve.expiresAt > Date.now())) {
                freeReadHint = ` — CHEAPER: this cache belongs to account ${owner.slice(0, 8)}, `
                  + `whose token is still alive; putting the session back on it makes this turn a free read `
                  + `instead of buying ${rewriteAssessment.predictedTokens} tokens`
              }
            }
          } catch { /* a hint must never break the block path */ }
          const isFirstWrite = rewriteAssessment.rewriteClass === 'expected:cold-start'
          // 🔴 THREE causes wore ONE sentence, and for the commonest of them it
          // was false in the way that matters. A cold start WRITES a cache for
          // the first time. An org-switch ABANDONS a cache that still exists on
          // the other account — there `freeReadHint` above offers the way back,
          // so "discarded and bought again" is exactly right and actionable.
          // But a ttl-expiry means the cache DIED ON THE CLOCK, hours before
          // this turn; nothing this turn does discards it, and there is no
          // cheaper path to offer. Telling that reader a paid cache "is
          // discarded" invites them to prevent a loss that already happened,
          // and to retry looking for the mistake they did not make.
          // MEASURED 2026-09-03: of 29 overnight blocks, 26 were ttl-expiry at
          // 8–9h idle against a 1h lifetime — the fleet had simply slept. Five
          // project owners woke to a refusal that read as their own avoidable
          // error, and one shift (20f32b0a) died against it after six retries.
          // Machine-readable fields — rewriteClass, spendKind, predictedTokens,
          // consecutiveBlocks, consent.* — are UNCHANGED and remain the only
          // thing a consumer keys on; this edit touches prose alone.
          const idleMs = rewriteAssessment.signals?.idleMs ?? null
          const expiredAgo = idleMs !== null && idleMs > 0
            ? ` ~${idleMs >= 3_600_000
                ? `${(idleMs / 3_600_000).toFixed(1)}h`
                : `${Math.round(idleMs / 60_000)}m`} ago`
            : ''
          const spendPhrase = isFirstWrite
            ? `write ~${rewriteAssessment.predictedTokens} tokens of NEW cache (first write for this lineage — nothing is being discarded)`
            : rewriteAssessment.rewriteClass === 'avoidable:ttl-expiry'
              ? `re-cache ~${rewriteAssessment.predictedTokens} tokens (the cache expired${expiredAgo} and is already gone — `
                + `this turn buys it back; the choice is to pay or to stop this session, NOT to save the old cache)`
              : `re-cache ~${rewriteAssessment.predictedTokens} tokens (a cache already paid for is discarded and bought again)`
          this.events.emit({
            level: 'error',
            kind: 'CACHE_REWRITE_BLOCKED',
            sessionId,
            lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass,
            // Machine-readable form of the distinction above, so a consumer
            // never has to parse prose or re-derive it from the class name.
            spendKind: isFirstWrite ? 'first-write' : 'rewrite',
            predictedTokens: rewriteAssessment.predictedTokens,
            // Чей это ход — субагента или самой сессии. Без этого поля нельзя
            // было даже ПОСЧИТАТЬ, сколько отказов убивает субагентов.
            agentId: ctx.agentId ?? null,
            consecutiveBlocks: streak,
            continuation: lastMsg.isContinuation,
            dumpPath,
            msg: `guard blocked ${rewriteAssessment.rewriteClass} — would ${spendPhrase}; awaiting consent `
              + `(${guard.overrideMarker} or: context cache-rewrite-ok ${sessionId})`
              + freeReadHint
              + (dumpPath ? ` — dump: ${dumpPath}` : ''),
          })
          return jsonResponse(400, {
            error: {
              type: 'cache_rewrite_guard',
              rewriteClass: rewriteAssessment.rewriteClass,
              spendKind: isFirstWrite ? 'first-write' : 'rewrite',
              predictedTokens: rewriteAssessment.predictedTokens,
              // The caller's own turn counter: 1 means "answer the question",
              // 3 means "you are hitting the same wall and retrying will not
              // clear it". Nobody could tell those apart before.
              consecutiveBlocks: streak,
              minRewriteTokens: guard.minRewriteTokens,
              minColdStartTokens: guard.minColdStartTokens,
              // Machine-parseable consent affordances so a programmatic client
              // or agent harness can act on the block without scraping prose.
              consent: {
                marker: guard.overrideMarker,
                command: '/cache-rewrite-ok',
                // --until-consumed, НЕ голая форма: подсказку читает ЧЕЛОВЕК у
                // терминала, а сессия к этому моменту ходов не делает — часы
                // на 180 с истекут раньше, чем он наберёт команду и пошлёт
                // сообщение, которое её потратит. Согласие без часов ждёт
                // ровно того хода, ради которого выдано.
                cli: `context cache-rewrite-ok ${sessionId} --until-consumed`,
                disable: 'keepalive.json → rewriteGuard.enabled=false',
              },
              // 🔴 THE LEADING `Cache guard` IS A PUBLISHED CONTRACT, NOT A
              // STYLE CHOICE — do not reword it, and do not let anything
              // precede it. Downstream watchers cannot tell this refusal apart
              // any other way: the Claude Code CLI has no class for a 400 whose
              // `error.type` is `cache_rewrite_guard`, so it files the turn as
              // class `unknown` (measured 2026-09-03 over one project's
              // transcripts: 12 blocks, all `unknown`, against `rate_limit` for
              // 429 and `server_error` for 529). The telegram error-watch
              // therefore mapped the class NAME `unknown` to "cache rewrite
              // guard" — which makes EVERY unclassified error of any kind read
              // to the founder as ours. This prefix is the honest key it should
              // use instead, so it stays byte-stable across versions.
              // Pinned by test: 'the refusal opens with the marker downstream
              // watchers key on'.
              message: (streak >= 2
                ? `Cache guard (${streak} turns IN A ROW now — retrying will not clear this; `
                  + `grant consent or change what the turn sends): this turn would ${spendPhrase} `
                : `Cache guard: this turn would ${spendPhrase} `)
                + `(${rewriteAssessment.rewriteClass}) — `
                + `an unconfirmed quota spend, blocked for all consumers. To proceed, either include `
                + `${guard.overrideMarker} in your next message (/cache-rewrite-ok), or grant out-of-band: `
                + `context cache-rewrite-ok ${sessionId} --until-consumed. Consent is single-use `
                + `(--until-consumed waits for this session's next turn instead of a 180s clock — `
                + `the form that survives you typing it). `
                // Субагенту адресовать «наберите команду» бессмысленно: у него
                // нет человека. Но и тупика нет — согласие за него выдаёт тот,
                // кто его запустил. Об этом надо СКАЗАТЬ, иначе путь есть, а
                // знания о нём нет (02.09.2026, потерянный проверщик соседа).
                + (ctx.agentId
                  ? `NOTE: this turn belongs to sub-agent "${ctx.agentId}", which has no human to read this. `
                    + `Its PARENT must grant, and the command above ALREADY carries this sub-agent's OWN `
                    + `session id (${sessionId}) — a grant on the parent's own id does NOTHING here: to the `
                    + `proxy a sub-agent is a FULL SEPARATE SESSION with its own bucket. `
                  : '')
                + `(Disable: keepalive.json → rewriteGuard.enabled=false.)`,
            },
          })
        }
      }
    }

    // Cross-org login → this session HOLDS its old org+token for real traffic
    // (Layer 2 forward selection above). Keep the OLD org's cache warm during
    // the hold: while held, KA replays the snapshot's old token. The flag tracks
    // the PIN state (source of truth), not the assess-time orgChanged: set while
    // held, cleared on rebind / same-org so KA resumes fresh-token warming.
    if (orgHeld || rotateConsumed) session.engine.markOrgSwitchPending(reqLineageKey)
    else session.engine.clearOrgSwitchPending(reqLineageKey)

    // PROCEED path — the request will be forwarded. ONLY NOW mutate keepalive:
    // prime the engine (aborts any in-flight KA, records the pending snapshot)
    // and advance prefix history. A blocked request returned above without
    // reaching here, so it never disturbs keepalive's warming of the OLD cache.
    // The run is over the moment a turn actually goes through — reset HERE, on
    // the forward path, not on a timer: what makes a streak a streak is that
    // nothing got through in between.
    session.rewriteBlockStreak = null

    // agentId на КАЖДОМ ходу, а не только на отказе: родителю нужен номер
    // сессии субагента, ПОКА ТОТ ЖИВ, — иначе рецепт спасения начинается со
    // смерти. В расписке запуска субагент значится ИМЕНЕМ, своего номера там
    // нет; связать имя с номером можно только здесь (02.09.2026, вопрос
    // владельца anywhisper: «где родителю взять номер, пока тот жив»).
    this.events.emit({ level: 'info', kind: 'REAL_REQUEST_START', sessionId, model, bodyBytes, idSource, agentId: ctx.agentId ?? null })
    if (unidentified) {
      // Serve it — do not warm it. Skipping notifyRealRequestStart is what
      // makes this airtight rather than cosmetic: no pending snapshot is
      // recorded, so notifyRealRequestComplete has nothing to commit, the KA
      // registry stays empty for this session and tick() finds nothing to
      // fire. Prefix history is skipped for the same reason — an entry keyed
      // by a one-shot id can only ever accumulate, never match.
      this.events.emit({
        level: 'info',
        kind: 'REQUEST_UNIDENTIFIED',
        sessionId,
        model,
        bodyBytes,
        // 🔴 КТО пришёл — без этого тревога называет беду, но не адресата
        // (29.08.2026). Владелец соседнего проекта неделями искал, почему у
        // него ничего не греется; событие всё это время писалось, но не
        // говорило, чей клиент безымянный, поэтому по журналу нельзя было ни
        // найти виновника, ни доказать, что он один. Заголовки здесь уже под
        // рукой — тело для этого не разбирается. Берётся ДО обогащения (см.
        // HandleRequestContext.clientUserAgent): в заголовках на этом месте
        // уже стоит наша подстановка, а не имя звонящего.
        userAgent: ctx.clientUserAgent ?? null,
        msg: 'no x-claude-code-session-id header and no session id in metadata.user_id — '
          + 'request forwarded, keepalive NOT armed (a one-shot id can never be matched again)',
      })
    } else {
      session.engine.notifyRealRequestStart(model, parsedBody, upstreamHeaders)
      if (assessed) this.commitPrefixHistory(assessed.commit)
    }

    // Pre-request rewrite-burst guard
    try {
      session.engine.checkRewriteGuard(model)
    } catch (err: any) {
      if (err?.code === 'CACHE_REWRITE_BLOCKED') {
        // Outcome invariant: this request already emitted REAL_REQUEST_START, so
        // it MUST emit exactly one terminal event — otherwise it vanishes from the
        // log and every later count built on start-minus-outcome is wrong (2026-08-18:
        // 591 of 6413 requests had no outcome at all, and an in-flight counter built
        // that way produced a spurious 19x "concurrency causes 529" correlation).
        this.events.emit({
          level: 'error',
          kind: 'REAL_REQUEST_ERROR',
          sessionId,
          status: 429,
          msg: `cache_rewrite_blocked: ${err.message}`,
        })
        return jsonResponse(429, {
          error: { type: 'cache_rewrite_blocked', message: err.message },
        })
      }
      throw err
    }

    const t0 = Date.now()

    // Forward upstream — with bounded, abortable server-side retry for TRANSIENT
    // upstream faults (Anthropic 5xx / 529 Overloaded). A brief capacity blip
    // otherwise surfaces to Claude Code as a hard error the user must manually
    // re-`resume` through (incident 2026-06-04: session df081b12 saw ~3 min of
    // repeated 529s). A 5xx/529 is a PRE-STREAM rejection (error JSON, no partial
    // content), so re-sending the same body is safe + idempotent. NOT retried
    // here: 429 (quota — has resetAt-aware handling below; retrying worsens it)
    // and other 4xx (client errors). Budget is intentionally short.
    const TRANSIENT_UPSTREAM_STATUSES = new Set([500, 502, 503, 529])
    let upstream: Response
    let realAttempt = 0
    // Per-request rate-limit snapshot — captured in THIS request's scope (from
    // its own upstream response) and passed to the async parser. Must NOT read
    // the shared this.lastRateLimit at emit time: REAL_REQUEST_COMPLETE fires
    // AFTER the body has streamed (up to ~60s), during which a concurrent request
    // on ANOTHER org overwrites this.lastRateLimit — so the completing request
    // would emit a different org's utilisation under its own org label (cross-org
    // quota contamination feeding the per-session badge + agent gate; 2026-06-24:
    // a b3219c9b request emitted f9420373's 7d=0.99).
    let reqRateLimit: RateLimitSnapshot
    for (;;) {
      try {
        upstream = await this.upstream.fetch(`${this.config.anthropicBaseUrl}/v1/messages?beta=true`, {
          method: 'POST',
          headers: upstreamHeaders,
          body: forwardBodyStr,
          signal: ctx.signal,
        })
      } catch (fetchErr: any) {
        return this.handleNetworkError(sessionId, fetchErr)
      }

      // Parse rate-limit headers into snapshot (request-local AND shared field:
      // the shared one still feeds heartbeat/rateLimitSnapshot + 429 handling;
      // the local is what REAL_REQUEST_COMPLETE emits, race-free).
      reqRateLimit = parseRateLimitHeaders(upstream.headers)
      this.lastRateLimit = reqRateLimit

      // Ground-truth org evidence: Anthropic names the serving org on every
      // response. Verify the vault binding and surface mismatches (a session
      // believing it posts to org A while org B serves it = quota leak).
      {
        const servedOrg = upstream.headers.get('anthropic-organization-id')
        if (servedOrg) {
          this.lastServedOrg.set(sessionId, servedOrg)
          this.orgVault.markVerified(servedOrg)
          // TOFU auto-pin: the first org Anthropic actually serves a session
          // becomes a sticky implicit pin, so an unpinned session stops
          // following ~/.claude.json default-org churn (multiple Claude Code
          // processes on different orgs each rewrite that one shared file,
          // oscillating it → unpinned sessions flip org between requests). Only
          // an explicit `org switch` changes it afterwards. Creating a real pin
          // reuses the existing pin machinery (vault token refresh, HOLD,
          // restart-restore). servedOrg is ground truth (response header) — we
          // bind to what was actually served, not the racy resolver default.
          if (!this.sessionPins.has(sessionId)) {
            const ve = this.orgVault.get(servedOrg)
            if (ve && (ve.expiresAt === null || ve.expiresAt > Date.now())) {
              this.sessionPins.set(sessionId, { orgId: ve.orgId, token: ve.accessToken, expiresAt: ve.expiresAt })
              this.orgVault.setPin(sessionId, servedOrg)
              this.events.emit({
                level: 'info', kind: 'ORG_PIN_AUTO', sessionId,
                msg: `auto-pinned to first-served org ${servedOrg.slice(0, 8)} (TOFU — sticky; change via 'org switch')`,
              })
            }
          }
          const expected = this.sessionPins.get(sessionId)?.orgId ?? this.orgIdResolver.current()
          if (expected !== null && expected !== servedOrg) {
            this.events.emit({
              level: 'error', kind: 'ORG_SERVED_MISMATCH', sessionId,
              msg: `expected org ${expected.slice(0, 8)} but Anthropic served ${servedOrg.slice(0, 8)} — token/org binding is wrong`,
            })
            // Self-heal: a served-org mismatch means a cached (orgId, token)
            // pair is lying — re-read both from disk so the NEXT request pairs
            // truthfully. Without this a dead fs.watch turned one stale cache
            // into hours of wrong-org traffic (2026-06-11: 37 mismatch alerts,
            // f9420373's 5h window burned to 429 while logged into b3219c9b).
            this.credentials.invalidate()
            this.orgIdResolver.invalidate()
          }
        }
      }

      if (upstream.ok
          || !TRANSIENT_UPSTREAM_STATUSES.has(upstream.status)
          || realAttempt >= this.realRetryDelaysMs.length) {
        break  // success, non-retryable, or budget exhausted → fall through below
      }

      // Transient upstream fault → back off and retry. Honor retry-after only to
      // LENGTHEN the wait, never to shorten it below our exponential floor:
      // Anthropic emits `retry-after: 0` during wide overloads, and obeying it
      // verbatim retries an already-overloaded upstream with ZERO spacing
      // (2026-06-24: delayMs=0 fired twice in a row, burning the whole retry
      // budget in <2s → "Repeated 529" surfaced to the user on a fresh session).
      // floor = baseline schedule; cap = retryCeilingMs. Then ±20% jitter so the
      // many concurrent sessions / KA-ticks all hitting the same blip don't
      // retry in lockstep and re-spike the upstream.
      const baseMs = this.realRetryDelaysMs[realAttempt]!
      const retryAfterHeader = upstream.headers.get('retry-after')
      const retryAfterParsed = retryAfterHeader ? parseFloat(retryAfterHeader) : NaN
      const honoredMs = Number.isFinite(retryAfterParsed)
        ? Math.max(retryAfterParsed * 1_000, baseMs)
        : baseMs
      const jittered = honoredMs * (1 + (this.retryRandom() - 0.5) * 0.4)
      const delayMs = Math.round(Math.min(jittered, this.retryCeilingMs))
      // Release the error-response body so the connection can be reused.
      try { await upstream.body?.cancel() } catch { /* best-effort */ }
      this.events.emit({
        level: 'info',
        kind: 'REAL_REQUEST_RETRY',
        sessionId,
        status: upstream.status,
        attempt: realAttempt + 1,
        maxAttempts: this.realRetryDelaysMs.length,
        delayMs,
      })
      realAttempt++
      try {
        await new Promise<void>((resolve, reject) => {
          if (ctx.signal?.aborted) { reject(new Error('aborted')); return }
          const timer = setTimeout(resolve, delayMs)
          ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
        })
      } catch {
        // Client disconnected while we were backing off — stop retrying.
        // Outcome invariant (see above): emit the terminal event before returning.
        this.events.emit({
          level: 'info',
          kind: 'REAL_REQUEST_ABORTED',
          sessionId,
          phase: 'retry-backoff',
          attempt: realAttempt,
          msg: 'client disconnected during upstream retry backoff',
        })
        return new Response('client disconnected during upstream retry', { status: 499 })
      }
    }

    // 🔴 ANTHROPIC'S OWN ID FOR THIS REQUEST — RECORDED ON SUCCESSES, NOT ONLY FAILURES.
    //
    // Every response carries `request-id`, and a REFUSAL additionally repeats it
    // inside its error body — which is the only reason we had any at all. Measured
    // 2026-08-18 over the whole 13:40–20:35Z window: 536 request_ids in the log,
    // and every single one belongs to a failure (265 from REAL_REQUEST_ERROR, 270
    // from HEALTH_HEARTBEAT — and all 270 of those are echoes of the same failures).
    // A successful request left no id anywhere.
    //
    // So the last open question of the 529 investigation — "do the refusals' ids
    // carry any structure?" — was unanswerable, not for want of a storm but for
    // want of a control group: with failures only, ANY pattern found is a pattern
    // of the whole population, and there is nothing to contrast it against.
    const upstreamRequestId = upstream.headers.get('request-id')

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '')
      if (upstream.status === 401) {
        // Real-request 401 backstop (mirror the KA `onAuthError` path + CC's
        // `handleOAuth401Error`). The token we ACTUALLY sent (`sentToken`) was
        // rejected → force ONE refresh of the SERVED org through the choke-point:
        // `handleOrg401` re-reads the org token (adopts a peer's fresh token if
        // one rotated in) else force-refreshes, per-org-cooldown-gated so a
        // genuine `invalid_grant` revoke classifies to relogin-once and does NOT
        // hammer the endpoint (the config-dir lock is taken only when a refresh
        // is actually due). Without this a stale active-org token only cleared
        // the in-memory cache and re-read the SAME stale disk token, returning
        // 401 with no self-heal (the P0 drift this closes).
        const servedOrg = this.resolveServedOrg(sessionId)
        if (servedOrg && sentToken) await this.handleOrg401(servedOrg, sentToken)
        // Keep the cache invalidation: the active-org path re-reads fresh disk on
        // the next request, and this covers the served=null / no-sentToken edge.
        this.credentials.invalidate()
      }

      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        status: upstream.status,
        msg: errText.slice(0, 200),
      })

      if (upstream.status === 429) {
        // 🔴 ОТКАЗ БЕЗ ИМЕНИ АККАУНТА НЕ ОТВЕЧАЕТ НА ЕДИНСТВЕННЫЙ ВОПРОС, КОТОРЫЙ ЗАДАЮТ.
        //
        // Замер 02.09.2026: 105 отказов в журнале за двое суток, и ни один не нёс
        // ни имени аккаунта, ни его доли — а спрашивают всегда одно: «чей запас
        // кончился и был ли рядом свободный». В тот день 447 сессий сидели на
        // аккаунте с долей 0.99, пока соседний стоял на 0.27, и доказать это по
        // журналу было НЕЛЬЗЯ: пришлось сверять снимок квоты со стороны.
        //
        // Доля берётся из `reqRateLimit` — снимка ЗАГОЛОВКОВ ЭТОГО ответа, а не из
        // общего `this.lastRateLimit`: последний перезаписывается параллельным
        // запросом ДРУГОГО аккаунта, и отказ получил бы чужую долю под своим
        // именем (та же гонка, что описана у reqRateLimit выше).
        this.events.emit({
          level: 'error',
          kind: 'UPSTREAM_RATE_LIMITED',
          sessionId,
          org: this.resolveServedOrg(sessionId),
          util5h: reqRateLimit.utilization5h,
          util7d: reqRateLimit.utilization7d,
          resetAt: reqRateLimit.resetAt,
          resetAt7d: reqRateLimit.resetAt7d ?? null,
          retryAfterSec: reqRateLimit.retryAfter,
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
      // Outcome invariant (see above).
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        status: 502,
        msg: 'upstream returned no body',
      })
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
    void this.parseSSEAndNotify(toParse, session, sessionId, model, t0, reqLineageKey, reqRateLimit, upstreamRequestId).catch((e) => {
      this.events.emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `parse promise rejected: ${e?.message}`,
      })
    })

    // Return byte-for-byte stream to caller — WRAPPED so a client that walks
    // away mid-stream is observable. Claude Code aborts a turn on Esc, on its
    // own timeout, or when the harness cancels; the tee'd client branch is then
    // cancelled and, unguarded, that abort left NO trace at all: the request had
    // already emitted REAL_REQUEST_START and never emitted any terminal event,
    // and in Bun the discarded stream surfaced only as an anonymous
    // `unhandledRejection: null is not an object`. Measured 2026-08-18 over 4.5h:
    // 591 of 6413 requests (9%, and 51% of the worst session's) had no outcome
    // event, against 576 such rejections — close enough that they are almost
    // certainly the same event seen from two sides. The cost was not cosmetic: an
    // in-flight counter built as start-minus-outcome drifts upward for ever and
    // manufactured a 19x "concurrency causes 529" correlation that survived until
    // it was cross-checked against a window-density count.
    //
    // The wrapper never alters the bytes. It only names the abort, once, and
    // cancels the upstream reader so the connection is released instead of being
    // dropped on the floor.
    const clientReader = toClient.getReader()
    let abortNamed = false
    const nameAbort = (why: string) => {
      if (abortNamed) return
      abortNamed = true
      this.events.emit({
        level: 'info',
        kind: 'REAL_REQUEST_ABORTED',
        sessionId,
        phase: 'streaming',
        durationMs: Date.now() - t0,
        msg: why,
      })
    }
    const guardedToClient = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          const { done, value } = await clientReader.read()
          if (done) { controller.close(); return }
          controller.enqueue(value)
        } catch (streamErr: any) {
          nameAbort(`upstream stream failed mid-response: ${streamErr?.message ?? streamErr}`)
          try { controller.error(streamErr) } catch { /* already errored */ }
        }
      },
      cancel: (reason) => {
        nameAbort(`client stopped reading the response${reason ? `: ${String(reason)}` : ''}`)
        // Release the upstream connection; a rejection here is the very thing
        // this wrapper exists to stop from escaping as an unhandled rejection.
        void clientReader.cancel(reason).catch(() => { /* best-effort */ })
      },
    })

    const responseHeaders = new Headers(upstream.headers)
    responseHeaders.delete('content-encoding')
    responseHeaders.delete('content-length')
    return new Response(guardedToClient, {
      status: upstream.status,
      headers: responseHeaders,
    })
  }

  // ─── Internal: engine factory per session ──────────────────────

  private createEngine(sessionId: string): KeepaliveEngine {
    const cfg = this.config
    return new KeepaliveEngine({
      evictionBreaker: this.evictionBreaker,
      config: {
        // Per-consumer TTL pin — see ProxyClientConfig.kaCacheTtlSec docs.
        // Default 3600s: handleRequest upgrades native CC's cache_control to
        // ttl:'1h', so KA fires every ~30 min against a genuinely 1h cache.
        // The wire autoscan downlocks this per-session if a 5m marker appears.
        cacheTtlMs: cfg.kaCacheTtlSec * 1000,
        // undefined → engine reads from SSOT (~/.claude/keepalive.json)
        intervalMs: cfg.kaIntervalSec !== undefined ? cfg.kaIntervalSec * 1000 : undefined,
        idleTimeoutMs: cfg.kaIdleTimeoutSec > 0 ? cfg.kaIdleTimeoutSec * 1000 : Infinity,
        minTokens: cfg.kaMinTokens,
        rewriteWarnIdleMs: cfg.kaRewriteWarnIdleSec * 1000,
        rewriteWarnTokens: cfg.kaRewriteWarnTokens,
        rewriteBlockIdleMs: cfg.kaRewriteBlockIdleSec > 0 ? cfg.kaRewriteBlockIdleSec * 1000 : Infinity,
        rewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
        // Outcome invariant for keepalive — the pair of KA_FIRE_COMPLETE below.
        // Wired the same way onHeartbeat is: the engine owns no bus, the client
        // does.
        onFireStart: (info) => {
          this.events.emit({
            level: 'info',
            kind: 'KA_FIRE_START',
            sessionId,
            // The account that ACTUALLY served this fire — the pin when the session has
            // one, otherwise whichever account the pool is currently serving. The
            // narrower `sessionPins` alone left this null on 88 of 91 paid warm-ups
            // over the week of 2026-08-13..20, which is exactly the field needed to
            // test whether a restart re-serves a session from the OTHER account —
            // whose cache is worthless to it. Same source the auth path already uses.
            org: this.resolveServedOrg(sessionId),
            lineageKey: info.lineageKey,
            idleMs: info.idleMs,
          })
        },
        onFireError: (info) => {
          this.events.emit({
            level: 'error',
            kind: 'KA_FIRE_ERROR',
            sessionId,
            // The account that ACTUALLY served this fire — the pin when the session has
            // one, otherwise whichever account the pool is currently serving. The
            // narrower `sessionPins` alone left this null on 88 of 91 paid warm-ups
            // over the week of 2026-08-13..20, which is exactly the field needed to
            // test whether a restart re-serves a session from the OTHER account —
            // whose cache is worthless to it. Same source the auth path already uses.
            org: this.resolveServedOrg(sessionId),
            lineageKey: info.lineageKey,
            idleMs: info.idleMs,
            status: info.status,
            category: info.category,
            msg: info.message,
            durationMs: info.durationMs,
          })
        },
        onHeartbeat: (stats) => {
          // A successful KA fire just refreshed this lineage's Anthropic-side
          // cache prefix — record the warm-up so predictCacheMiss does not
          // later mistake KA-kept-warm idle for a TTL expiry and false-block.
          if (stats.lineageKey) {
            const e = this.prefixHistory.get(`${sessionId}:${stats.lineageKey}`)
            if (e) e.lastKaAt = Date.now()
          }
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
            lineageKey: stats.lineageKey,
            // Org of the session's pinned token (multi-org quota attribution).
            // The account that ACTUALLY served this fire — the pin when the session has
            // one, otherwise whichever account the pool is currently serving. The
            // narrower `sessionPins` alone left this null on 88 of 91 paid warm-ups
            // over the week of 2026-08-13..20, which is exactly the field needed to
            // test whether a restart re-serves a session from the OTHER account —
            // whose cache is worthless to it. Same source the auth path already uses.
            org: this.resolveServedOrg(sessionId),
            model: stats.model,
            durationMs: stats.durationMs,
            idleMs: stats.idleMs,
            usage: {
              inputTokens: stats.usage.inputTokens,
              outputTokens: stats.usage.outputTokens,
              cacheReadInputTokens: stats.usage.cacheReadInputTokens ?? 0,
              cacheCreationInputTokens: stats.usage.cacheCreationInputTokens ?? 0,
            },
            // Показания счётчика подписки, снятые с ОТВЕТА НА ЭТОТ УДАР.
            // Ради них всё и делалось: ночью это единственный запрос в системе,
            // поэтому только здесь движение счётчика не смешано с работой.
            rateLimit: stats.rateLimit,
            util5h: (stats.rateLimit as { utilization5h?: number | null })?.utilization5h ?? null,
            util7d: (stats.rateLimit as { utilization7d?: number | null })?.utilization7d ?? null,
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
        onHeld: (info) => this.events.emit({
          level: 'info',
          kind: 'KA_HOLD',
          sessionId,
          reason: info.reason,
          holdMs: info.holdMs,
          regSize: info.regSize,
          msg: `KA held for session ${sessionId.slice(0, 8)} — reason=${info.reason}, snapshot kept, resuming in ${Math.round(info.holdMs / 1000)}s`,
        }),
        onDisarmed: (info) => this.events.emit({
          level: 'error',
          kind: 'KA_DISARM',
          sessionId,
          reason: info.reason,
          errStatus: info.errStatus ?? null,
          errMessage: info.errMessage ?? null,
          msg: `KA disarmed for session ${sessionId.slice(0, 8)} — reason=${info.reason}`
            + (info.errStatus || info.errMessage ? ` err=${info.errStatus ?? 'na'}:${info.errMessage ?? ''}` : ''),
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
        // Registry mutated → mark the KA snapshot file dirty so the reaper
        // persists the fresh state on its next tick.
        onRegistryChange: () => { this.kaSnapshotDirty = true },
      },
      // KA fast path (M3): resolve the session's currently-SERVED org (a held
      // cross-org session serves its pinned org, not the active account) and
      // route its token through the refresh choke-point, so an idle held
      // session warms the RIGHT org's cache with a REFRESHED token.
      getToken: () => this.getTokenForSession(sessionId),
      // Force-on-401 backstop (H3): on a KA auth error, re-read the served org's
      // token / force ONE refresh (per-org cooldown + revoke classification).
      onAuthError: (failedToken: string) => {
        const servedOrg = this.resolveServedOrg(sessionId)
        return servedOrg ? this.handleOrg401(servedOrg, failedToken) : Promise.resolve()
      },
      doFetch: (body, headers, signal) => this.engineDoFetch(body, headers, signal, sessionId),
      getRateLimitInfo: () => this.lastRateLimit,
      isOwnerAlive: () => this.store.isOwnerAlive(sessionId),
    })
  }

  // ─── Internal: KA snapshot persistence (survives a proxy restart) ──────

  /** Serialise every armed engine's KA registry into a persistable map. */
  private collectKaSnapshots(): Record<string, PersistedSession> {
    const out: Record<string, PersistedSession> = {}
    for (const s of this.store.list()) {
      const state = s.engine.serializeState()
      if (!state) continue                       // disarmed / never-armed — skip
      out[s.sessionId] = {
        ...state,
        sessionId: s.sessionId,
        ownerPid: s.pid ?? null,
        model: s.model ?? null,
        // Whose cache this is. See PersistedSession.orgId.
        orgId: this.resolveServedOrg(s.sessionId),
      }
    }
    return out
  }

  /**
   * Persist the KA snapshot registry. Never throws — and never fails quietly.
   *
   * The file is what every session revives from after a restart, so a failure
   * that nobody hears costs the whole fleet its warmth the next time the proxy
   * comes up. Reported ONCE per failure episode (and once again on recovery),
   * because this runs every ten seconds and a repeated alarm is an ignored one.
   */
  private persistKaSnapshots(): void {
    const r = saveKaSnapshots(this.collectKaSnapshots(), this.kaSnapshotPath)
    if (!r.ok) {
      if (!this.kaSnapshotPersistFailing) {
        this.kaSnapshotPersistFailing = true
        this.events.emit({
          level: 'error',
          kind: 'KA_SNAPSHOT_PERSIST_FAILED',
          path: this.kaSnapshotPath,
          error: r.error,
          msg: `KA snapshot file could not be written (${r.error}) — every session would lose its warm cache on the next restart`,
        })
      }
      return
    }
    if (this.kaSnapshotPersistFailing) {
      this.kaSnapshotPersistFailing = false
      this.events.emit({
        level: 'info',
        kind: 'KA_SNAPSHOT_PERSIST_RECOVERED',
        path: this.kaSnapshotPath,
        msg: 'KA snapshot file is writable again',
      })
    }
  }

  /**
   * Startup: revive KA engines for sessions whose cache is provably still
   * warm. A snapshot too stale to revive is DROPPED — never re-armed (firing
   * KA on a dead cache is itself a cold write = quota burn). Each dropped
   * lineage is recorded in `kaReviveDropped` so the next real request for it
   * is surfaced as a genuine rewrite, not silently passed as proxy-restart.
   */
  private reviveKaSnapshots(): void {
    let sessions: Record<string, PersistedSession>
    try {
      sessions = loadKaSnapshots(this.kaSnapshotPath).sessions
    } catch {
      return
    }
    const ssot = loadKeepaliveConfig()
    const intervalMs = this.config.kaIntervalSec !== undefined
      ? this.config.kaIntervalSec * 1000
      : ssot.intervalMs
    const opts = {
      safetyMarginMs: ssot.safetyMarginMs,
      intervalMs,
      maxAgeMs: KA_SNAPSHOT_MAX_AGE_MS,
      fireBudgetMs: ssot.healthProbeTimeoutMs,
    }
    const now = Date.now()
    for (const [sid, ps] of Object.entries(sessions)) {
      // Owner-PID gate first — never revive a session whose consumer exited
      // (pid 1 = reparented to init = parent dead).
      if (ps.ownerPid != null && (ps.ownerPid === 1 || !this.liveness.isAlive(ps.ownerPid))) {
        this.recordReviveDrop(sid, ps, 'owner-dead')
        continue
      }
      const verdict = assessRevival(ps, now, opts)
      if (!verdict.revive) {
        this.recordReviveDrop(sid, ps, verdict.reason)
        continue
      }
      try {
        const session = this.store.getOrCreate(sid, ps.ownerPid, () => this.createEngine(sid))
        session.model = ps.model
        if (this.restorePinForRevivedSession(sid, ps.orgId) === 'account-unavailable') {
          this.recordReviveDrop(sid, ps, 'account-unavailable')
          continue
        }
        session.engine.revive(ps)
        this.kaSnapshotDirty = true
        this.events.emit({
          level: 'info',
          kind: 'KA_REVIVED',
          sessionId: sid,
          lineageCount: ps.registry.length,
          model: ps.model,
          cacheAgeMs: now - ps.cacheWrittenAt,
          msg: `KA revived for session ${sid.slice(0, 8)} — ${ps.registry.length} lineage(s), `
            + `cache ${Math.round((now - ps.cacheWrittenAt) / 1000)}s old`,
        })
      } catch {
        this.recordReviveDrop(sid, ps, 'revive-error')
      }
    }
  }

  /**
   * Give a revived session back the account its cache belongs to.
   *
   * Anthropic caches per account. Until now the binding was restored only on
   * the session's next REAL request — and the sessions that keepalive exists
   * for are precisely the ones that send none, so a revived warm-up fired
   * against whatever account happened to be active and bought the whole prefix
   * again. The same shape of error as the disarm that could only be undone by a
   * request an idle agent never makes.
   *
   * Measured 2026-08-13..20: 21.8% of fires in the first ten minutes after a
   * restart paid a full rewrite against 0.12% three hours later — about a
   * million tokens per restart across 27 restarts.
   *
   * No token is minted here: the pin carries the vault's current token and the
   * fire path still goes through withFreshOrgToken, which is the only place
   * allowed to check-and-refresh.
   */
  private restorePinForRevivedSession(sessionId: string, orgId: string | null): 'ok' | 'account-unavailable' {
    try {
      if (!orgId) return 'ok'                               // old snapshot — nothing claimed
      if (this.sessionPins.has(sessionId)) return 'ok'      // a live binding wins
      if (orgId === this.orgIdResolver.current()) return 'ok'   // already the right account
      const ve = this.orgVault.get(orgId)
      if (!ve || (ve.expiresAt !== null && ve.expiresAt <= Date.now())) {
        // The account that owns this cache cannot be spoken for right now.
        // Warming on whatever account happens to be active is not a partial
        // success — it is a guaranteed full-price purchase of a prefix that the
        // session will never read, repeated every interval. Say so and let the
        // caller drop the snapshot; the session re-warms honestly on its return.
        return 'account-unavailable'
      }
      this.sessionPins.set(sessionId, { orgId: ve.orgId, token: ve.accessToken, expiresAt: ve.expiresAt })
      this.events.emit({
        level: 'info',
        kind: 'ORG_PIN_RESTORED',
        sessionId,
        msg: `revived session re-bound to the account its cache belongs to (${orgId.slice(0, 8)}) `
          + `— without it the warm-up would have paid for the whole prefix again`,
      })
      return 'ok'
    } catch {
      // A failed re-bind must not stop the other revivals — but it must not be
      // read as success either: without the binding this session would warm the
      // wrong account.
      return 'account-unavailable'
    }
  }

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
  private static readonly AVOIDABLE_DROP_REASONS = new Set([
    'cache-dies-before-ka',
    'revive-error',
  ])

  private recordReviveDrop(sessionId: string, ps: PersistedSession, reason: string): void {
    const avoidable = ProxyClient.AVOIDABLE_DROP_REASONS.has(reason)
    if (avoidable) {
      for (const e of ps.registry ?? []) {
        if (e && typeof e.lineageKey === 'string') {
          this.kaReviveDropped.add(`${sessionId}:${e.lineageKey}`)
        }
      }
    }
    this.events.emit({
      level: 'info',
      kind: 'KA_REVIVE_DROP',
      sessionId,
      reason,
      lineageCount: ps.registry?.length ?? 0,
      msg: `KA snapshot not revived for session ${sessionId.slice(0, 8)} — ${reason}`
        + (avoidable ? ' [blockable]' : ' [unavoidable downtime — guard will pass]'),
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
    // Whose keepalive this is. Passed from the engine wiring (the `doFetch`
    // closure already holds it) so a 429 on the KA path can name the session
    // AND its account — without it the event carried `sessionId: null` and the
    // busiest source of 429s in the log was unattributable to any account.
    sessionId?: string,
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
          sessionId: sessionId ?? null,
          org: sessionId ? this.resolveServedOrg(sessionId) : null,
          util5h: rl.utilization5h,
          util7d: rl.utilization7d,
          resetAt: rl.resetAt,
          resetAt7d: rl.resetAt7d ?? null,
          retryAfterSec: rl.retryAfter,
          requestKind: 'ka',
          status: 429,
        })
      }
      throw err
    }

    if (!response.body) throw new Error('No response body')

    // 🔴 ПОКАЗАНИЯ СЧЁТЧИКА ПОДПИСКИ СНИМАЮТСЯ И НА УСПЕХЕ, А НЕ ТОЛЬКО НА 429.
    //
    // Замер 29.08.2026: из 31 506 служебных ударов в журнале НИ ОДИН не нёс
    // util5h/util7d — заголовки разбирались только в ветке отказа выше. А
    // именно эти удары и есть единственные запросы, идущие НОЧЬЮ, когда никто
    // не работает: каждый из них приносил ответ на вопрос «тратит ли прогрев
    // квоту», и мы его выбрасывали. Без этого вопрос неразрешим в принципе —
    // счётчик виден только на настоящих ходах, то есть всякое ночное окно
    // измеряется через своих соседей и уплывает вместе со скользящим окном
    // недели.
    //
    // Заголовки уже в руках, тело не трогается: цена — разбор пяти полей.
    try { this.lastRateLimit = parseRateLimitHeaders(response.headers) } catch { /* учёт не должен ронять прогрев */ }

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
    // Frozen at call time from THIS request's upstream response — emitting the
    // shared this.lastRateLimit here would race with concurrent other-org
    // requests (cross-org quota contamination). See handleRequest's reqRateLimit.
    reqRateLimit: RateLimitSnapshot,
    // Anthropic's id for this request, from the `request-id` response header —
    // frozen at call time like reqRateLimit. See the capture site in
    // handleRequest for why a SUCCESS carrying it is the point.
    upstreamRequestId: string | null,
  ): Promise<void> {
    try {
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      let buffer = ''
      // Non-streaming fallback: a consumer (e.g. the tixi agent-sidecar) may POST
      // WITHOUT stream:true, so the upstream body is a single Anthropic Message
      // JSON, not an SSE event stream. We accumulate the raw body (only until SSE
      // usage is seen, to bound memory on real streams) and parse it as JSON after
      // the loop when the data:-line scan found no `message_start`. Without this,
      // usage stays 0 for every non-streaming request → the engine never records
      // the warm cache → perpetual `expected:cold-start` mispredictions and
      // cache-metrics hitRate=0, even while Anthropic serves 40k+ cache reads.
      let rawAll = ''
      let sawSseUsage = false
      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          const r = await reader.read()
          done = r.done
          value = r.value
        } catch (readErr: any) {
          // An ABORT, not an error — and it must say so, because for a year it
          // said the opposite. Measured 2026-08-24: this line emitted
          // kind REAL_REQUEST_ERROR at level 'debug', so the logger (info)
          // never wrote it while the bus still delivered it to every
          // subscriber. The session-stuck alarm counted nine of these as
          // refusals and announced "12 consecutive failures" where the log
          // held three — a number no reader could reconcile, from events that
          // by design leave no trace. A kind that lies to counters and hides
          // from the journal is the worst of both; the abort family already
          // exists, so this belongs in it.
          this.events.emit({
            level: 'debug',
            kind: 'REAL_REQUEST_ABORTED',
            sessionId,
            phase: 'stream-read',
            msg: `stream read aborted: ${readErr?.message}`,
          })
          return
        }
        if (done) break
        if (!value) continue
        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk
        if (!sawSseUsage) rawAll += chunk
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') continue
          try {
            const p = JSON.parse(raw)
            if (p.type === 'message_start' && p.message?.usage) {
              sawSseUsage = true
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

      // Flush the decoder and handle a NON-streaming JSON response: when the
      // data:-line scan above saw no `message_start`, the body is a single
      // Anthropic Message object — parse it and lift `usage` so the engine and
      // rolling metrics see the real cache tokens (otherwise REAL_REQUEST_COMPLETE
      // reports 0 and every request mispredicts cold-start).
      rawAll += decoder.decode()
      if (!sawSseUsage) {
        try {
          const msg = JSON.parse(rawAll.trim())
          const u = msg?.usage
          if (u && typeof u === 'object') {
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
            }
            const cc = u.cache_creation
            if (cc && typeof cc === 'object') {
              if (typeof cc.ephemeral_5m_input_tokens === 'number') usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
              if (typeof cc.ephemeral_1h_input_tokens === 'number') usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
            }
            if (typeof u.cache_deleted_input_tokens === 'number') usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
          }
        } catch { /* not JSON (e.g. an SSE stream that simply carried no usage) — leave zero */ }
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
        // See the capture site above: the control group the failure-only ids lacked.
        requestId: upstreamRequestId,
        // lineageKey lets offline analysis attribute a cache hit/rewrite to a
        // specific agent (main vs each sub-agent) — needed to verify the main
        // agent's cache survives a sub-agent (Task-tool) excursion.
        lineageKey,
        // Organization that actually served this request (multi-org: the
        // session's pinned org) — the quota pipeline attributes per-org by it.
        // The account that ACTUALLY served this fire — the pin when the session has
            // one, otherwise whichever account the pool is currently serving. The
            // narrower `sessionPins` alone left this null on 88 of 91 paid warm-ups
            // over the week of 2026-08-13..20, which is exactly the field needed to
            // test whether a restart re-serves a session from the OTHER account —
            // whose cache is worthless to it. Same source the auth path already uses.
            org: this.resolveServedOrg(sessionId),
        model,
        durationMs: Date.now() - t0,
        usage,
        rateLimit: {
          util5h: reqRateLimit.utilization5h,
          util7d: reqRateLimit.utilization7d,
          status: reqRateLimit.status,
          // 🔴 ИСТОК ПОТЕРИ ВРЕМЕНИ СБРОСА. Заголовок приходит на КАЖДОМ ответе и разбирается
          // строкой выше (`parseRateLimitHeaders`), но в событие клались три поля из четырёх — а
          // дальше по цепочке взять его уже неоткуда. Итог был виден всем: `resetAt: null` во всех
          // аккаунтах и предупреждение «Reset in nullmin. STOP NEW WORK», то есть механизм, который
          // пытается назвать время и печатает пустоту.
          //
          // Замерено 2026-08-17: `anthropic-ratelimit-unified-reset: 1787016000` вместе с
          // `unified-5h-reset` того же значения; в собственном логе заголовков обе формы по 12054
          // раза. Ни один шов ниже не был виноват — терялось здесь, при сборке события.
          resetAt: reqRateLimit.resetAt,
          resetAt7d: reqRateLimit.resetAt7d ?? null,
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

  /** Does this session's KA engine hold a live, still-warm snapshot for the
   *  lineage? Second source of truth for the rewrite-guard — see the
   *  isFirstRequest consultation in assessCacheMiss. Never throws. */
  private kaHoldsWarmLineage(sessionId: string, lineageKeyArg: string): boolean {
    try {
      const s = this.store.list().find((x) => x.sessionId === sessionId)
      return !!s?.engine.hasWarmLineage(lineageKeyArg)
    } catch { return false }
  }

  /**
   * Pure assessment of whether this request incurs a cache rewrite — does NOT
   * mutate prefix history. Returns a `commit` payload (always, so the PROCEED
   * path can advance history) and an `assessment` (null on an expected cache
   * HIT — nothing to surface/block). A blocked request calls this and skips
   * commit, so an unconsented rewrite never advances state or poisons the
   * marker-carrying retry's classification.
   */
  private assessCacheMiss(
    sessionId: string,
    lineageKey: string,
    body: Record<string, unknown>,
    bodyBytes: number,
  ): {
    commit: { key: string; ph: ReturnType<typeof prefixHashes>; now: number; orgId: string | null; prevLastKaAt: number | undefined; system: unknown; tools: unknown }
    assessment: {
      rewriteClass: string
      expected: boolean
      predictedTokens: number
      signals: { systemChanged: boolean; toolsChanged: boolean; orgChanged: boolean; prevOrgId?: string | null; idleMs: number | null; ttlMs: number }
      /** Previous cacheable prefix of this lineage (for a guard-block dump). */
      prevPrefix: CachePrefix | null
    } | null
  } | null {
    try {
      const key = `${sessionId}:${lineageKey}`
      const now = Date.now()
      const ph = prefixHashes(body)
      const prev = this.prefixHistory.get(key)
      // Org of record for this lineage: the session's PIN org when present
      // (multi-org sessions must not flap the guard against the global org),
      // else the global resolver as before.
      const orgId = this.sessionPins.get(sessionId)?.orgId ?? this.orgIdResolver.current()
      // Capture the previous cacheable prefix (read-only) so a guard-block dump
      // can diff old vs new system/tools. The actual history WRITE is deferred
      // to commitPrefixHistory (proceed path only).
      const prevPrefix = this.lineagePrefix.get(key) ?? null
      // commit payload — caller persists this ONLY when the request proceeds.
      const commit = { key, ph, now, orgId, prevLastKaAt: prev?.lastKaAt, system: body.system, tools: body.tools }

      const isFirstRequest = !prev
      const systemChanged = !!prev && prev.hashes.system !== ph.system
      const toolsChanged = !!prev && prev.hashes.toolNames !== ph.toolNames
      // Effective idle = time since the cache was last WARMED — by a real
      // request OR a KA fire. KA fires replay the prefix and refresh its
      // Anthropic-side TTL, so a lineage that KA kept warm must NOT read as
      // idle-past-TTL (that false `avoidable:ttl-expiry` made the rewrite
      // guard block requests whose cache was in fact hot).
      const lastWarmAt = prev ? Math.max(prev.lastReqAt, prev.lastKaAt ?? 0) : undefined
      const idleMs = lastWarmAt !== undefined ? now - lastWarmAt : undefined
      // TTL the guard measures idle against = the cache lifetime actually on the
      // wire, read from THIS request's cache_control markers (post-1h-upgrade if
      // the proxy lifted them). The static kaCacheTtlSec is only a fallback for
      // a body that carries no cache_control marker at all. Reading the wire —
      // not a config constant — is what stops a 1h-cached lineage idle 19 min
      // from false-classifying as avoidable:ttl-expiry (the 405d1df5 block).
      const ttlMs = detectCacheTtlFromBody(body).minTtlMs ?? this.config.kaCacheTtlSec * 1000
      // The cache's last warm-up predates this proxy process → the TTL gap
      // spans a restart. KA could not have kept it warm (its engine did not
      // exist), so an expiry here is NOT avoidable — see classifyRewrite.
      const spansProxyRestart = lastWarmAt !== undefined && lastWarmAt < this.proxyStartedAt
      // ...UNLESS KA-persistence had a snapshot for this lineage and dropped it
      // as already-dead at startup — then the rewrite IS blockable. One-shot:
      // consume the flag so only the first post-restart request is surfaced.
      // Read-only here; the one-shot consume (delete) is deferred to
      // commitPrefixHistory so a blocked request does not consume it — the
      // marker-carrying retry must still see the dropped-snapshot signal.
      const kaRevivalDropped = this.kaReviveDropped.has(key)
      // org-switch: this lineage's prefix was last cached under a different
      // org than the one billing the current request. Tripped ONLY when both
      // org-ids are known and differ — an unknown org (`null`) never trips it.
      // This is deliberate: a routine ~8h same-org token refresh leaves
      // `oauthAccount.organizationUuid` untouched, so it never false-blocks;
      // and a transient read failure (null) degrades to "can't prove a
      // switch" rather than to a false 400.
      const prevOrgId = prev?.orgId ?? null
      const orgChanged = !!prev && orgId !== null && prevOrgId !== null && orgId !== prevOrgId

      // Warm-sibling detection (the avoidable:lineage-shift signal). A FIRST
      // request for a NEW lineageKey is normally a genuine cold start — UNLESS a
      // still-warm sibling lineage of the SAME session and SAME system-hash (a
      // DIFFERENT tool-set) was warmed within TTL. That means the lineageKey
      // changed only because the TOOL SET flicked (e.g. a transient MCP tool drop
      // on /login/resume) while KA was keeping the old prefix warm — an avoidable
      // re-cache the guard must surface, not a cold start. Detected purely from
      // the stable head (system⊕tools via lineageKey), NEVER from the volatile
      // message tail, so normal turn-growth + injected notifications/reminders
      // (which keep the same lineageKey) never trip it. Read-only (purity).
      let warmSiblingExists = false
      let siblingKey: string | undefined
      let warmSiblingKind: 'tools' | 'system' | undefined
      if (isFirstRequest) {
        const sep = lineageKey.indexOf(':')
        const sysHash = lineageKey.slice(0, sep)
        const toolsHash = lineageKey.slice(sep + 1)
        // Look BOTH ways. The original search matched a shared system hash only — it saw a
        // tool flick and was blind to its mirror image, a system move with a stable tool
        // set. Measured 2026-07-26 (session 8420a526): entering a git worktree rewrote
        // `Primary working directory` inside the CACHED system block, so the same 163 tools
        // produced a new lineage; the predecessor had completed 1.011s earlier — the prefix
        // was hot — and the turn was still called `expected:cold-start` at ~370k tokens and
        // blocked. Half a detector reports half the drift.
        let bestWarm = -1
        for (const [k, e] of this.prefixHistory) {
          if (k === key || !k.startsWith(`${sessionId}:`)) continue
          const rest = k.slice(sessionId.length + 1)
          const kSep = rest.indexOf(':')
          if (kSep < 0) continue
          const sameSystem = rest.slice(0, kSep) === sysHash
          const sameTools = rest.slice(kSep + 1) === toolsHash
          // Exactly ONE half must match: sharing neither is an unrelated lineage, and
          // sharing both is impossible (that would be this very key).
          if (sameSystem === sameTools) continue
          const warmAt = Math.max(e.lastReqAt, e.lastKaAt ?? 0)
          if (now - warmAt <= ttlMs && warmAt > bestWarm) {
            warmSiblingExists = true
            siblingKey = k
            // Name the half that MOVED, not the half that matched — the reader needs to know
            // what changed. Same system ⇒ the tools moved; same tools ⇒ the system moved.
            warmSiblingKind = sameSystem ? 'tools' : 'system'
            bestWarm = warmAt
          }
        }
      }
      // Observability (NOT enforcement): when the tool set changed vs a still-warm
      // sibling, compute the exact tool diff so the user sees WHAT changed and
      // ~how much re-caches — once per flick (isFirstRequest), no per-request storm.
      let toolDrift = ''
      if (warmSiblingExists && siblingKey && warmSiblingKind === 'system') {
        // A SYSTEM move: say so plainly, and say what it costs. This is the line whose
        // absence made "entering a worktree re-caches your whole context" unknowable.
        toolDrift = ` [system-prompt drift, same tool set → ~${Math.round(bodyBytes / 4)} tok re-cache`
          + ` — e.g. a cwd/worktree switch or a CLI upgrade rewrites the cached system block]`
      } else if (warmSiblingExists && siblingKey) {
        const sib = toolNameSet(this.lineagePrefix.get(siblingKey)?.tools)
        const now2 = toolNameSet(body.tools)
        const removed = [...sib].filter((t) => !now2.has(t))
        const added = [...now2].filter((t) => !sib.has(t))
        toolDrift = ` [tool-set drift${removed.length ? ' −[' + removed.join(',') + ']' : ''}`
          + `${added.length ? ' +[' + added.join(',') + ']' : ''} → ~${Math.round(bodyBytes / 4)} tok re-cache]`
      }

      // FIRST request by the guard's books — but the KA engine holds a LIVE
      // warm snapshot for the very same lineage. The guard's prefix-history is
      // the weaker record (lost to restart pruning or a session reap), while a
      // warm KA snapshot proves the Anthropic-side prefix is hot: this request
      // is a cache READ, not a rewrite. Stay quiet and let the commit re-seed
      // the history. (2026-06-13 93ef0df0: a KA-kept-warm 381k session was
      // false-blocked as expected:cold-start after a restart pruned its entry.)
      if (isFirstRequest && this.kaHoldsWarmLineage(sessionId, lineageKey)) {
        return { commit, assessment: null }
      }

      // Prefix unchanged + within TTL + same org → a cache HIT is expected; stay
      // quiet. Still return the commit payload so the proceed path advances
      // lastReqAt (a normal hit must refresh the idle clock).
      if (!isFirstRequest && !systemChanged && !toolsChanged && !orgChanged
          && (idleMs === undefined || idleMs <= ttlMs)) {
        return { commit, assessment: null }
      }

      const verdict = classifyRewrite({ isFirstRequest, toolsChanged, idleMs, ttlMs, orgChanged, spansProxyRestart, kaRevivalDropped, warmSiblingExists, warmSiblingKind })
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
        orgChanged,
        // The account this lineage's cache was actually built under. Carried out
        // so a block can tell the reader whether the expensive rewrite is
        // avoidable — see the free-read hint below.
        prevOrgId,
        predictedTokens,
        idleMs: idleMs ?? null,
        ttlMs,
        // Same distinction as the guard message: a cold start is a FIRST write,
        // not a re-write. Saying "rewrite" for both is what made a 448 104-token
        // first write read as discarded work in the log.
        spendKind: verdict.class === 'expected:cold-start' ? 'first-write' : 'rewrite',
        msg: `predicted `
          + (verdict.class === 'expected:cold-start' ? 'FIRST cache write' : 'cache REwrite')
          + ` — ${verdict.class} (~${predictedTokens} tok)`
          + (systemChanged ? ' [system changed]' : '')
          + (toolsChanged ? ' [tools changed]' : '')
          + (orgChanged ? ' [org switched]' : '')
          + toolDrift
          + (spansProxyRestart ? ' [spans proxy restart]' : '')
          + (kaRevivalDropped ? ' [ka snapshot dropped — unrevivable]' : '')
          + (idleMs !== undefined && idleMs > ttlMs
              ? ` [idle ${Math.round(idleMs / 1000)}s > ttl ${Math.round(ttlMs / 1000)}s]` : ''),
      })
      return {
        commit,
        assessment: {
          rewriteClass: verdict.class,
          expected: verdict.expected,
          predictedTokens,
          signals: { systemChanged, toolsChanged, orgChanged, idleMs: idleMs ?? null, ttlMs },
          prevPrefix,
        },
      }
    } catch {
      // Predictor is observability-only — never affect the request path.
      return null
    }
  }

  /** Persist this lineage's new prefix fingerprint + advance its idle clock.
   *  Call ONLY when the request PROCEEDS (never when the rewrite guard blocks
   *  it — a blocked, unconsented request must not advance history or it poisons
   *  the marker-carrying retry's classification). Also consumes the one-shot
   *  ka-revival-dropped flag. */
  private commitPrefixHistory(c: {
    key: string; ph: ReturnType<typeof prefixHashes>; now: number
    orgId: string | null; prevLastKaAt: number | undefined; system: unknown; tools: unknown
  }): void {
    this.lineagePrefix.set(c.key, { system: c.system, tools: c.tools })
    // Carry prevLastKaAt forward — a real request resets lastReqAt, but the
    // KA-fire timeline is independent and must survive this overwrite.
    this.prefixHistory.set(c.key, { hashes: c.ph, lastReqAt: c.now, orgId: c.orgId, lastKaAt: c.prevLastKaAt })
    this.kaReviveDropped.delete(c.key)
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
  'x-api-key',        // strip consumer API key — proxy injects its own OAuth bearer
  'accept-encoding',  // force uncompressed SSE
]

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
])

/** Epoch-seconds out of the FIRST header that carries one.
 *
 * 🔴 ЗДЕСЬ ЖЕ ЗАПИСАНА ОШИБКА, С КОТОРОЙ ЭТА ПРАВКА НАЧАЛАСЬ, — она дороже самой правки. Сначала
 * было заявлено: «заголовка `…unified-reset` не существует, парсер спрашивает пустоту». НЕВЕРНО.
 * Живой запрос 2026-08-17 вернул ОБА имени с одинаковым значением (`unified-reset: 1787016000` и
 * `unified-5h-reset: 1787016000`), и в собственном логе заголовков обе формы встречаются по 12054
 * раза. Вывод был сделан по списку, обрезанному на двенадцатой строке.
 *
 * Настоящая потеря была НЕ ЗДЕСЬ, а при сборке события REAL_REQUEST_COMPLETE, которое клало три
 * поля из четырёх (починено там же). Эта функция остаётся полезной по другой причине: окна — разные
 * часы, и недельное время не читалось вовсе. */
function firstEpochSeconds(headers: Headers, names: readonly string[]): number | null {
  for (const n of names) {
    const raw = headers.get(n)
    if (!raw) continue
    const v = Number(raw)
    if (Number.isFinite(v)) return v
  }
  return null
}

export function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot {
  return {
    status: headers.get('anthropic-ratelimit-unified-status'),
    // The 5h window first: it is the one that actually stops work, and the one every consumer means
    // by «when does the quota reset». The bare name is kept LAST rather than dropped — it costs one
    // lookup and covers an upstream that goes back to a single unified reset.
    resetAt: firstEpochSeconds(headers, [
      'anthropic-ratelimit-unified-5h-reset',
      'anthropic-ratelimit-unified-reset',
    ]),
    /** The 7d window's own reset, alongside the 5h one — they are different clocks (measured the
     * same day: 5h reset 13 minutes out, 7d reset 142 hours out), so one number cannot stand for
     * both and a consumer showing «quota resets at …» must say WHICH. */
    resetAt7d: firstEpochSeconds(headers, ['anthropic-ratelimit-unified-7d-reset']),
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

function loadPrefixHistory(path: string): Map<string, PrefixHistoryEntry> {
  const m = new Map<string, PrefixHistoryEntry>()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Partial<PrefixHistoryEntry>>
    const cutoff = Date.now() - PREFIX_HISTORY_MAX_AGE_MS
    for (const [k, v] of Object.entries(raw)) {
      // Age by the LAST WARM-UP — a real request OR a KA fire. Pruning by
      // lastReqAt alone dropped every KA-kept-warm idle session's entry on a
      // proxy restart (user idle >1h while KA refreshed the cache every ~28m),
      // so its next real request read as isFirstRequest → expected:cold-start —
      // and since minColdStartTokens that FALSE-BLOCKED a warm cache-read
      // (2026-06-13 93ef0df0: lastReq 65min old, lastKaAt 9min old, ~381k
      // "rewrite" predicted for what was a hot cache hit).
      const warmAt = v && typeof v.lastReqAt === 'number'
        ? Math.max(v.lastReqAt, typeof v.lastKaAt === 'number' ? v.lastKaAt : 0)
        : 0
      if (v && typeof v.lastReqAt === 'number' && warmAt >= cutoff && v.hashes) {
        // `orgId` is absent in entries written before org-awareness — normalize
        // to `null` so a pre-upgrade prefix never reads as a (false) org-switch.
        m.set(k, {
          hashes: v.hashes,
          lastReqAt: v.lastReqAt,
          orgId: typeof v.orgId === 'string' ? v.orgId : null,
          lastKaAt: typeof v.lastKaAt === 'number' ? v.lastKaAt : undefined,
        })
      }
    }
  } catch { /* missing or corrupt → start empty */ }
  return m
}

function savePrefixHistory(m: Map<string, PrefixHistoryEntry>, path: string): void {
  try {
    writeFileSync(path, JSON.stringify(Object.fromEntries(m)))
  } catch { /* best-effort — never break the request path */ }
}

/** Sorted unique tool-name set of a request body's `tools` array — for the
 *  observability tool-set-drift diff. Never throws. */
function toolNameSet(tools: unknown): Set<string> {
  const out = new Set<string>()
  if (Array.isArray(tools)) {
    for (const t of tools) {
      const n = (t && typeof t === 'object') ? (t as { name?: unknown }).name : undefined
      if (typeof n === 'string') out.add(n)
    }
  }
  return out
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON },
  })
}

/**
 * Extract the Claude Code version from a request body's billing header.
 * Claude Code prepends a `x-anthropic-billing-header: cc_version=X.Y.Z.<fp>`
 * text block to `system`; the trailing `.<fp>` is a per-request fingerprint
 * (volatile) — we return only the stable `X.Y.Z`. Never throws.
 */
function extractCcVersion(body: unknown): string | null {
  try {
    const system = (body as { system?: unknown })?.system
    if (!Array.isArray(system)) return null
    for (const b of system) {
      const t = b && typeof b === 'object' ? (b as { text?: unknown }).text : undefined
      if (typeof t === 'string' && t.includes('x-anthropic-billing-header')) {
        const m = t.match(/cc_version=(\d+\.\d+\.\d+)/)
        if (m) return m[1]
      }
    }
    return null
  } catch {
    return null
  }
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
export function extractSessionIdFromBody(
  rawBody: ArrayBuffer | Uint8Array | string,
): string | null {
  try {
    const s = typeof rawBody === 'string'
      ? rawBody
      : new TextDecoder().decode(rawBody as ArrayBuffer)
    if (!s.includes('session')) return null              // cheap bail-out
    const body = JSON.parse(s) as { metadata?: { user_id?: unknown } }
    const uid = body?.metadata?.user_id
    if (typeof uid !== 'string') return null
    // Matches both `"session_id":"<uuid>"` and `..._session_<uuid>` — the
    // optional `_id` covers the JSON `session_id` key.
    const m = uid.match(
      /session(?:_?id)?["'_:\s]*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})/,
    )
    return m ? m[1].toLowerCase() : null
  } catch {
    return null
  }
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
  // KA fires (engineDoFetch) replay a NON-streaming snapshot — the agent's real
  // request has no stream:true — so the upstream response is a single Anthropic
  // Message JSON, not an SSE stream. The data:-line scan finds no message_stop →
  // the engine gets no usage → KA_FIRE_COMPLETE logs cacheRead=0 even when the
  // fire HIT the warm cache, so the engine cannot tell a healthy refresh from a
  // miss (and the eviction guard can't work). Accumulate the body and, when no
  // SSE message_stop arrived, parse it as JSON and synthesize the terminal event.
  let rawAll = ''
  let yieldedStop = false

  try {
    while (true) {
      if (signal?.aborted) { reader.cancel(); return }
      const { done, value } = await reader.read()
      if (done) break
      const chunk = decoder.decode(value, { stream: true })
      buffer += chunk
      rawAll += chunk
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
          yieldedStop = true
          yield { type: 'message_stop', usage, stopReason: null }
        }
      }
    }
    // Non-streaming fallback (KA replays a non-streaming snapshot): no SSE
    // message_stop arrived → parse the whole body as one Anthropic Message, lift
    // usage (incl 5m/1h/deleted subfields), and synthesize the terminal event the
    // engine waits for — so KA fires report real cacheRead and the eviction guard
    // can distinguish a healthy refresh from a stale-snapshot miss.
    if (!yieldedStop) {
      try {
        const msg = JSON.parse(rawAll.trim())
        const u = msg?.usage
        if (u && typeof u === 'object') {
          usage = {
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
            cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
          }
          const cc = u.cache_creation
          if (cc && typeof cc === 'object') {
            if (typeof cc.ephemeral_5m_input_tokens === 'number') usage.cacheCreation5mInputTokens = cc.ephemeral_5m_input_tokens
            if (typeof cc.ephemeral_1h_input_tokens === 'number') usage.cacheCreation1hInputTokens = cc.ephemeral_1h_input_tokens
          }
          if (typeof u.cache_deleted_input_tokens === 'number') usage.cacheDeletedInputTokens = u.cache_deleted_input_tokens
        }
      } catch { /* not JSON — yield the zero-usage terminal so the engine still completes */ }
      yield { type: 'message_stop', usage, stopReason: null }
    }
  } finally {
    reader.releaseLock()
  }
}
