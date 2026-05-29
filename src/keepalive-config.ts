/**
 * keepalive-config.ts — SSOT for cache TTL + keepalive parameters.
 *
 * Hot-reloads from `~/.claude/keepalive.json` on every read (mtime-cached).
 * Falls back to safe defaults if file missing or malformed.
 *
 * Why a single file:
 *   The 5m vs 1h cache TTL story is encoded in NINE different places in
 *   keepalive-engine.ts plus three consumer defaults (proxy-client,
 *   claude-max-proxy/config, opencode-claude/provider). Without this SSOT,
 *   bumping TTL means hunting hardcodes across 4 packages.
 *
 * Discovered evidence (2026-04-30):
 *   * Anthropic's `prompt-caching-scope-2026-01-05` beta now honors
 *     `cache_control: { type: 'ephemeral', ttl: '1h' }` on the OAuth
 *     subscription endpoint. Empirically validated: WRITE @ T+0 →
 *     READ @ T+5m30s and T+10m both return cache_read=39220 tokens.
 *   * 56.2% of MESSAGE_START events in claude-max-headers.log report
 *     ephemeral_1h_input_tokens > 0 — the SDK was writing 1h cache all
 *     along, but engine was tearing it down at 5m boundary.
 *
 * Backward-compat:
 *   If keepalive.json is absent or `cacheTtlSec` is unset, defaults to
 *   the legacy 5m TTL so existing deployments keep their proven behavior.
 *   Activate 1h by writing { "cacheTtlSec": 3600, ... } to keepalive.json.
 *   Hot-reload picks it up on the next mtime-check (next request or KA tick).
 */

import { statSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { DEFAULT_ROLE_WEIGHTS, type RoleWeights } from './lineage.js'

// ──────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────

export interface DumpConfig {
  /** Master switch — disable all body dumps. Default: true. */
  readonly enabled: boolean
  /** Always dump first N calls of each PID (initial baseline). Default: 3. */
  readonly initialCalls: number
  /**
   * Tier-1 rolling ring: keep recent body dumps for post-hoc analysis.
   * After ringRetentionMs, oldest dumps are deleted. 0 = disabled.
   * Default: 2*60*60*1000 (2 hours).
   */
  readonly ringRetentionMs: number
  /**
   * Tier-1 rolling ring: max disk size in MB. If reached, oldest dumps removed.
   * Default: 300 MB. 0 = no cap (only retentionMs matters).
   */
  readonly ringMaxMb: number
  /**
   * Tier-2 suspicious archive: when a "suspicious" event happens (cold,
   * sysHash drift, tool drift, large cw without proportional cr), preserve
   * THIS dump + the previous N dumps from ring into a separate archive
   * directory that survives ring rotation. Default: 5 (this + 4 previous).
   */
  readonly suspiciousContextSize: number
  /**
   * Tier-2 archive retention. Default: 24*60*60*1000 (24 hours).
   */
  readonly suspiciousRetentionMs: number
  /**
   * Tier-2 archive max disk size in MB. Default: 100 MB.
   */
  readonly suspiciousMaxMb: number
  /**
   * Detect cold-start events: cw > coldCwThreshold AND cr == 0 AND
   * callNum > initialCalls (not the first few). Default: 10000 tokens.
   */
  readonly coldCwThreshold: number
  /**
   * Tier-3 metadata retention. Default: 7 days. (Was 24h via env;
   * we extend it because metadata is tiny — ~440 B per call.)
   */
  readonly metadataRetentionMs: number
}

export interface ResolvedKeepaliveConfig {
  /** Cache TTL in milliseconds. Default: 5*60*1000 (legacy). Recommend: 60*60*1000 (1h). */
  readonly cacheTtlMs: number

  /** Safety margin subtracted from TTL when scheduling fires/retries. Default: 60_000. */
  readonly safetyMarginMs: number

  /** Keepalive interval — how often KA fires when idle. Default: 1800_000 (30min) when 1h TTL active, else 120_000. */
  readonly intervalMs: number

  /** Lower clamp for intervalMs. Default: 60_000. */
  readonly intervalClampMin: number

  /** Upper clamp for intervalMs. Computed: cacheTtlMs - safetyMarginMs - 60_000. */
  readonly intervalClampMax: number

  /** Retry delays for transient KA failures, in ms. Cumulative budget should fit in (cacheTtlMs - safetyMarginMs). */
  readonly retryDelaysMs: readonly number[]

  /** Idle threshold to emit a rewrite-warning event. Default: 300_000 (5min, unchanged). */
  readonly rewriteWarnIdleMs: number

  /** Token threshold for rewrite-warning. Default: 50_000 (unchanged). */
  readonly rewriteWarnTokens: number

  /** Network probe escalating intervals after a network-related disarm. */
  readonly healthProbeIntervalsMs: readonly number[]

  /** TCP probe per-attempt timeout. Default: 3_000. */
  readonly healthProbeTimeoutMs: number

  /** Whether keepalive is enabled at all. */
  readonly enabled: boolean

  /** Idle timeout — stop KA if no real request for this long. 0 / Infinity = never stop. */
  readonly idleTimeoutMs: number

  /** Minimum input tokens for a request to register a snapshot. Default: 2000. */
  readonly minTokens: number

  /** Block real requests with too-aggressive cache rewrites (rare safety net). Default: false. */
  readonly rewriteBlockEnabled: boolean

  /** Body-dump policy with rotation. See DumpConfig docs. */
  readonly dump: DumpConfig

  /** Agent-role detector weights + thresholds. Fully SSOT-tunable and
   *  hot-reloaded — tune `~/.claude/keepalive.json` → `roleDetector` without
   *  a rebuild. See RoleWeights (lineage.ts) for field semantics. */
  readonly roleDetector: RoleWeights

  /** Rewrite-guard policy — opt-in block-until-confirmed for uncontrolled
   *  rewrites. SSOT-tunable + hot-reloaded via `~/.claude/keepalive.json`
   *  → `rewriteGuard`. See RewriteGuardConfig. */
  readonly rewriteGuard: RewriteGuardConfig

  /** Context tokens above which rotation enters deferred mode (REQ-06). Default 150000. */
  readonly tokenRotationContextThreshold: number

  /** Fallback mtime poll interval if fs.watch misses an event (REQ-02). Default 30000. */
  readonly tokenRotationPollIntervalMs: number

  /** How long an extracted org-id is cached to avoid per-request JWT decode overhead (REQ-14). Default 300000. */
  readonly orgIdCacheTtlMs: number

  /** Audit log rotation threshold (~10MB) (US-03 AC-3.4). Default 10485760. */
  readonly tokenRotationLogMaxBytes: number

  /** Audit log retention before cleanup (US-03 AC-3.4). Default 7. */
  readonly tokenRotationLogRetentionDays: number

  /** Source of truth — where we read this config from (for diagnostics). */
  readonly _source: 'defaults' | 'file' | 'mixed'
}

// ──────────────────────────────────────────────────────────────
// Hardcoded fallback (legacy 5m TTL — what production has been running)
// ──────────────────────────────────────────────────────────────

const DEFAULT_DUMP: DumpConfig = {
  enabled:               true,
  initialCalls:          3,
  // Tier-1 ring: 2 hours OR 300 MB, whichever hits first.
  // Sized so that ~1000 requests/h × 270 KB avg = 270 MB ≈ 300 cap.
  ringRetentionMs:       2 * 60 * 60 * 1000,
  ringMaxMb:             300,
  // Tier-2 archive: when something looks suspicious, keep it + N preceding
  // dumps for forensic comparison. 5 dumps gives N-1, N-2, N-3, N-4 + the
  // event itself — enough to spot a structural change.
  suspiciousContextSize: 5,
  suspiciousRetentionMs: 24 * 60 * 60 * 1000,
  suspiciousMaxMb:       100,
  // Cold-start trigger: cache_creation_input_tokens > this AND cache_read=0
  // (and not first N calls). 10k matches the cw=116k mid-session cold seen
  // 2026-04-30 14:46:55 — well above the threshold.
  coldCwThreshold:       10_000,
  metadataRetentionMs:   7 * 24 * 60 * 60 * 1000,
}

/**
 * Rewrite-guard policy — opt-in protection against spontaneous, uncontrolled
 * cache rewrites. When `enabled`, a request predicted to incur an
 * avoidable/anomalous cache_creation above `minRewriteTokens` — and NOT the
 * first request of the session — is rejected with HTTP 400 until the user's
 * latest message contains `overrideMarker`.
 *
 * IMPORTANT — what this does and does NOT do:
 *   - It does NOT save the rewrite cost. The user still needs an answer, so
 *     they re-send (with the marker) and the SAME re-cache happens.
 *   - It DOES turn a silent quota spend into an explicit, consented one — a
 *     "confirm large spend" checkpoint. Cost: one rejected round-trip per block.
 *   - `expected:*` rewrites (cold-start / compact / tools-changed) are NEVER
 *     blocked — only `avoidable:ttl-expiry` / `anomalous:*`.
 * Default: disabled (opt-in).
 */
export interface RewriteGuardConfig {
  /** Master switch. Default false — must be explicitly opted into. */
  readonly enabled: boolean
  /** Only block when predicted cache_creation exceeds this many tokens. Default 50000. */
  readonly minRewriteTokens: number
  /** Substring in the LATEST user message that overrides the block (fresh-consent:
   *  only the current turn's message is scanned, not history). Default below. */
  readonly overrideMarker: string
  /** On a block, write the rejected request + prefix diff to a JSON artifact
   *  (rewrite-guard-blocks/) so it can be analysed offline. Default true. */
  readonly dumpBlocked: boolean
  /**
   * Apply guard blocking ONLY to interactive (native Claude Code) requests.
   * Programmatic endpoint clients — OpenAI-compat /v1/chat/completions and
   * external Anthropic-API consumers — cannot re-send with an override marker,
   * so a hard 400 just strands them; when true they are let through (logged).
   * Set false to enforce the guard on ALL traffic regardless of client kind.
   * Default true.
   */
  readonly interactiveOnly: boolean
}

const DEFAULT_REWRITE_GUARD: RewriteGuardConfig = {
  enabled: false,
  minRewriteTokens: 50_000,
  overrideMarker: '[%cache-rewrite-ok%]',
  dumpBlocked: true,
  interactiveOnly: true,
}

const LEGACY_DEFAULTS: Omit<ResolvedKeepaliveConfig, '_source' | 'intervalClampMax'> = {
  cacheTtlMs:                5 * 60 * 1000,        // 5 min — legacy Anthropic behavior
  safetyMarginMs:            15 * 1000,            // 15 s — legacy
  intervalMs:                120 * 1000,           // 2 min — legacy KA cadence
  intervalClampMin:          60 * 1000,
  retryDelaysMs:             [2,3,5,7,10,12,15,17,20,20,20,20,20].map(s => s * 1000),
  rewriteWarnIdleMs:         300 * 1000,
  rewriteWarnTokens:         50_000,
  healthProbeIntervalsMs:    [3_000, 5_000, 7_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000, 10_000],
  healthProbeTimeoutMs:      3_000,
  enabled:                   true,
  idleTimeoutMs:             Infinity,
  minTokens:                 2000,
  rewriteBlockEnabled:       false,
  dump:                      DEFAULT_DUMP,
  roleDetector:              DEFAULT_ROLE_WEIGHTS,
  rewriteGuard:              DEFAULT_REWRITE_GUARD,
  // Token-rotation defaults (REQ-13). Hot-reloadable via ~/.claude/keepalive.json.
  tokenRotationContextThreshold: 150_000,
  tokenRotationPollIntervalMs:   30_000,
  orgIdCacheTtlMs:               300_000,
  tokenRotationLogMaxBytes:      10_485_760,
  tokenRotationLogRetentionDays: 7,
}

/**
 * Recommended values when 1h cache is active.
 *
 * Activate by writing this to ~/.claude/keepalive.json:
 *   { "cacheTtlSec": 3600, "safetyMarginSec": 60, "intervalSec": 1800,
 *     "retryDelaysSec": [2,3,5,10,15,20,30,60,120,300] }
 */
export const RECOMMENDED_1H_CONFIG = {
  cacheTtlSec:        3600,
  safetyMarginSec:    60,
  intervalSec:        1800,
  retryDelaysSec:     [2, 3, 5, 10, 15, 20, 30, 60, 120, 300],
} as const

// ──────────────────────────────────────────────────────────────
// File location + hot-reload cache
// ──────────────────────────────────────────────────────────────

const DEFAULT_CONFIG_PATH = join(homedir(), '.claude', 'keepalive.json')
// Env override — tests/CI can point to a fixture without touching real ~/.claude
const CONFIG_PATH = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH || DEFAULT_CONFIG_PATH
let _cachedMtimeMs = 0
let _cachedConfig: ResolvedKeepaliveConfig | null = null
let _warnedKeys = new Set<string>()

function readRawConfig(): Record<string, unknown> | null {
  try {
    const st = statSync(CONFIG_PATH)
    if (st.mtimeMs === _cachedMtimeMs && _cachedConfig) {
      return null  // unchanged — caller will reuse _cachedConfig
    }
    _cachedMtimeMs = st.mtimeMs
    _warnedKeys.clear()  // reset on file change
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────
// Validation helpers
// ──────────────────────────────────────────────────────────────

function num(raw: unknown, key: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === null) return fallback
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) {
    if (!_warnedKeys.has(key)) {
      console.error(`[keepalive-config] ${key}=${JSON.stringify(raw)} is not a number — using fallback ${fallback}`)
      _warnedKeys.add(key)
    }
    return fallback
  }
  if (n < min || n > max) {
    if (!_warnedKeys.has(key)) {
      console.error(`[keepalive-config] ${key}=${n} out of range [${min}, ${max}] — clamping`)
      _warnedKeys.add(key)
    }
    return Math.max(min, Math.min(max, n))
  }
  return n
}

function numArray(raw: unknown, key: string, fallback: number[], minLen = 1, maxLen = 30): number[] {
  if (raw === undefined || raw === null) return fallback
  if (!Array.isArray(raw)) {
    if (!_warnedKeys.has(key)) {
      console.error(`[keepalive-config] ${key} is not an array — using fallback`)
      _warnedKeys.add(key)
    }
    return fallback
  }
  const arr = raw.map(v => typeof v === 'number' ? v : Number(v)).filter(n => Number.isFinite(n) && n > 0)
  if (arr.length < minLen || arr.length > maxLen) {
    if (!_warnedKeys.has(key)) {
      console.error(`[keepalive-config] ${key} length ${arr.length} out of [${minLen}, ${maxLen}] — using fallback`)
      _warnedKeys.add(key)
    }
    return fallback
  }
  return arr
}

function bool(raw: unknown, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'string') return raw === 'true' || raw === '1' || raw === 'yes'
  return Boolean(raw)
}

// ──────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────

/**
 * Resolve current keepalive config. Hot-reloads from ~/.claude/keepalive.json on every call.
 *
 * Behaviour:
 *   1. If file unchanged since last read → return cached config (cheap).
 *   2. If file missing → return LEGACY_DEFAULTS (5m TTL).
 *   3. If file present → merge with defaults, validate ranges, log warnings on bad values.
 *   4. NEVER throws. Bad config → falls back per-key.
 */
export function loadKeepaliveConfig(): ResolvedKeepaliveConfig {
  const raw = readRawConfig()
  if (raw === null && _cachedConfig) {
    return _cachedConfig
  }
  // BUG FIX 2026-05-18: `_cachedConfig` was declared but never assigned in
  // the success path. `readRawConfig()` always returns the parsed raw on a
  // fresh process and our cache hit-condition (`raw === null && _cachedConfig`)
  // was therefore never reached — we re-parsed and re-resolved on every call.
  // Worse, in test runs across multiple engine instances the re-resolve
  // produced slightly drifted values (depending on whether SSOT fixture was
  // present), leaking into the engine's live-reload code in `tick()` and
  // overwriting test-pinned intervalMs/cacheTtlMs — exact mechanism of the
  // Layer 5 flake. Caching the resolved config closes the loop the comment
  // on line 4 promised ("mtime-cached").
  const resolved = _resolve(raw ?? null)
  _cachedConfig = resolved
  return resolved
}

/**
 * Force re-read (for tests or admin ops). Bypasses mtime cache.
 */
export function reloadKeepaliveConfig(): ResolvedKeepaliveConfig {
  _cachedMtimeMs = 0
  _cachedConfig = null
  return loadKeepaliveConfig()
}

/**
 * Internal resolver — exported only for tests.
 */
export function _resolve(raw: Record<string, unknown> | null): ResolvedKeepaliveConfig {
  const source: 'defaults' | 'file' | 'mixed' = raw === null ? 'defaults'
    : Object.keys(raw).length > 0 ? 'mixed' : 'defaults'

  // Cache TTL: accept cacheTtlSec (preferred) or cacheTtlMs (escape hatch)
  const cacheTtlMs = num(
    (raw?.cacheTtlMs ?? (typeof raw?.cacheTtlSec === 'number' ? raw.cacheTtlSec * 1000 : undefined)),
    'cacheTtlMs',
    LEGACY_DEFAULTS.cacheTtlMs,
    60_000,            // min 1 min — anything less is meaningless
    7_200_000,         // max 2 h — Anthropic doesn't support beyond
  )

  const safetyMarginMs = num(
    (raw?.safetyMarginMs ?? (typeof raw?.safetyMarginSec === 'number' ? raw.safetyMarginSec * 1000 : undefined)),
    'safetyMarginMs',
    LEGACY_DEFAULTS.safetyMarginMs,
    1_000,
    300_000,
  )

  // Default interval = scale with TTL: 5m TTL → 120s; 1h TTL → 1800s.
  // Formula: max(60s, min(TTL/2, 1800s)).
  const defaultInterval = Math.max(60_000, Math.min(cacheTtlMs / 2, 1_800_000))

  let intervalMs = num(
    (raw?.intervalMs ?? (typeof raw?.intervalSec === 'number' ? raw.intervalSec * 1000 : undefined)),
    'intervalMs',
    defaultInterval,
    60_000,
    cacheTtlMs - safetyMarginMs - 1_000,  // must complete before TTL
  )

  const intervalClampMin = LEGACY_DEFAULTS.intervalClampMin
  const intervalClampMax = Math.max(intervalClampMin + 1, cacheTtlMs - safetyMarginMs - 60_000)
  if (intervalMs < intervalClampMin) intervalMs = intervalClampMin
  if (intervalMs > intervalClampMax) intervalMs = intervalClampMax

  const retryDelaysMsRaw = raw?.retryDelaysMs ?? (
    Array.isArray(raw?.retryDelaysSec)
      ? (raw.retryDelaysSec as unknown[]).map(v => typeof v === 'number' ? v * 1000 : NaN)
      : undefined
  )
  const retryDelaysMs = numArray(
    retryDelaysMsRaw,
    'retryDelaysMs',
    LEGACY_DEFAULTS.retryDelaysMs as number[],
  )

  // Role-detector weights/thresholds — every field validated, hot-reloadable.
  const rd = (raw?.roleDetector && typeof raw.roleDetector === 'object')
    ? raw.roleDetector as Record<string, unknown> : {}
  const D = DEFAULT_ROLE_WEIGHTS
  const roleDetector: RoleWeights = {
    mainThreshold:    num(rd.mainThreshold,    'roleDetector.mainThreshold',    D.mainThreshold,    0, 100),
    baseline:         num(rd.baseline,         'roleDetector.baseline',         D.baseline,         0, 100),
    spawnTool:        num(rd.spawnTool,        'roleDetector.spawnTool',        D.spawnTool,        0, 100),
    resumedAfterIdle: num(rd.resumedAfterIdle, 'roleDetector.resumedAfterIdle', D.resumedAfterIdle, 0, 100),
    oldest:           num(rd.oldest,           'roleDetector.oldest',           D.oldest,           0, 100),
    richest:          num(rd.richest,          'roleDetector.richest',          D.richest,          0, 100),
    auxToolCountMax:  num(rd.auxToolCountMax,  'roleDetector.auxToolCountMax',  D.auxToolCountMax,  0, 10_000),
    spawnToolPatterns:
      Array.isArray(rd.spawnToolPatterns)
        && rd.spawnToolPatterns.length > 0
        && rd.spawnToolPatterns.every((p) => typeof p === 'string')
        ? rd.spawnToolPatterns as string[]
        : D.spawnToolPatterns,
  }

  // Rewrite-guard policy — validated, hot-reloadable. Default off (opt-in).
  const rg = (raw?.rewriteGuard && typeof raw.rewriteGuard === 'object')
    ? raw.rewriteGuard as Record<string, unknown> : {}
  const rewriteGuard: RewriteGuardConfig = {
    enabled: bool(rg.enabled, DEFAULT_REWRITE_GUARD.enabled),
    minRewriteTokens: num(rg.minRewriteTokens, 'rewriteGuard.minRewriteTokens',
      DEFAULT_REWRITE_GUARD.minRewriteTokens, 1_000, 10_000_000),
    overrideMarker: (typeof rg.overrideMarker === 'string' && rg.overrideMarker.length > 0)
      ? rg.overrideMarker
      : DEFAULT_REWRITE_GUARD.overrideMarker,
    dumpBlocked: bool(rg.dumpBlocked, DEFAULT_REWRITE_GUARD.dumpBlocked),
    interactiveOnly: bool(rg.interactiveOnly, DEFAULT_REWRITE_GUARD.interactiveOnly),
  }

  const config: ResolvedKeepaliveConfig = {
    cacheTtlMs,
    safetyMarginMs,
    intervalMs,
    intervalClampMin,
    intervalClampMax,
    retryDelaysMs,
    // Rewrite-warn threshold: when idle since last cache touch exceeds this,
    // the next real request is presumed to incur cache_write cost (cache TTL
    // expired). Auto-scales with cacheTtlMs: only warn when idle is close to
    // or beyond the actual TTL boundary (TTL - safetyMargin), otherwise the
    // banner fires while cache is still warm — false alarm.
    //
    // Examples:
    //   5m  TTL → warn at 240s idle (5m - 60s margin → close to expiry)
    //   1h  TTL → warn at 3540s idle (~59min — actually about to expire)
    //   2h  TTL → warn at 7140s idle
    // Override via rewriteWarnIdleSec/rewriteWarnIdleMs in keepalive.json.
    rewriteWarnIdleMs: num(
      raw?.rewriteWarnIdleMs ?? (typeof raw?.rewriteWarnIdleSec === 'number' ? raw.rewriteWarnIdleSec * 1000 : undefined),
      'rewriteWarnIdleMs',
      Math.max(60_000, cacheTtlMs - safetyMarginMs),
      1_000, 86_400_000),
    rewriteWarnTokens: num(raw?.rewriteWarnTokens, 'rewriteWarnTokens',
      LEGACY_DEFAULTS.rewriteWarnTokens, 100, 1_000_000),
    healthProbeIntervalsMs: numArray(raw?.healthProbeIntervalsMs, 'healthProbeIntervalsMs',
      LEGACY_DEFAULTS.healthProbeIntervalsMs as number[]),
    healthProbeTimeoutMs: num(raw?.healthProbeTimeoutMs, 'healthProbeTimeoutMs',
      LEGACY_DEFAULTS.healthProbeTimeoutMs, 500, 60_000),
    enabled: bool(raw?.enabled, LEGACY_DEFAULTS.enabled),
    idleTimeoutMs: (raw?.idleTimeoutMs === null || raw?.idleTimeoutSec === null)
      ? Infinity
      : num(
          raw?.idleTimeoutMs ?? (typeof raw?.idleTimeoutSec === 'number' ? raw.idleTimeoutSec * 1000 : undefined),
          'idleTimeoutMs', LEGACY_DEFAULTS.idleTimeoutMs === Infinity ? 86_400_000 : LEGACY_DEFAULTS.idleTimeoutMs,
          0, 86_400_000),
    minTokens: num(raw?.minTokens, 'minTokens', LEGACY_DEFAULTS.minTokens, 1, 1_000_000),
    rewriteBlockEnabled: bool(raw?.rewriteBlockEnabled, LEGACY_DEFAULTS.rewriteBlockEnabled),
    // Body-dump policy. NOTE: parsing of raw?.dump.* fields not yet implemented;
    // for now we emit DEFAULT_DUMP. Full parsing is the in-flight work that
    // accompanies this scaffolding (see DumpConfig interface above).
    dump: DEFAULT_DUMP,
    roleDetector,
    rewriteGuard,
    // Token-rotation knobs (REQ-13, CR-08). Hot-reloaded via mtime cache.
    tokenRotationContextThreshold: num(
      raw?.tokenRotationContextThreshold,
      'tokenRotationContextThreshold',
      LEGACY_DEFAULTS.tokenRotationContextThreshold,
      1_000,           // sanity floor — anything less is meaningless
      10_000_000,
    ),
    tokenRotationPollIntervalMs: num(
      raw?.tokenRotationPollIntervalMs,
      'tokenRotationPollIntervalMs',
      LEGACY_DEFAULTS.tokenRotationPollIntervalMs,
      5_000,           // sanity floor — don't hammer the FS
      3_600_000,
    ),
    orgIdCacheTtlMs: num(
      raw?.orgIdCacheTtlMs,
      'orgIdCacheTtlMs',
      LEGACY_DEFAULTS.orgIdCacheTtlMs,
      10_000,          // sanity floor
      86_400_000,
    ),
    tokenRotationLogMaxBytes: num(
      raw?.tokenRotationLogMaxBytes,
      'tokenRotationLogMaxBytes',
      LEGACY_DEFAULTS.tokenRotationLogMaxBytes,
      1_024,           // sanity floor — at least 1KB
      1_073_741_824,   // ceiling 1GB
    ),
    tokenRotationLogRetentionDays: num(
      raw?.tokenRotationLogRetentionDays,
      'tokenRotationLogRetentionDays',
      LEGACY_DEFAULTS.tokenRotationLogRetentionDays,
      1,               // sanity floor — at least 1 day
      3650,            // ceiling 10 years
    ),
    _source: source,
  }

  _cachedConfig = config
  return config
}

/**
 * Path of the config file (for diagnostics / endpoints).
 */
export function getConfigPath(): string {
  return CONFIG_PATH
}

/**
 * Fast getter for the most relevant value — used in keepalive-engine 12+ places.
 */
export function getCacheTtlMs(): number {
  return loadKeepaliveConfig().cacheTtlMs
}

export function getSafetyMarginMs(): number {
  return loadKeepaliveConfig().safetyMarginMs
}
