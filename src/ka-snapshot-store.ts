/**
 * ka-snapshot-store.ts — persist the KA snapshot registry across a proxy restart.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * The proxy keeps Anthropic prompt caches warm by firing periodic keepalive
 * (KA) requests. When the proxy process restarts, every KeepaliveEngine — and
 * with it every armed KA snapshot — is destroyed. A session that was idle
 * between turns across the restart has no fresh real request to re-arm its
 * engine, so KA stops, the cache TTL lapses, and the user's next request is a
 * full cold cache rewrite (~100K+ cache_creation tokens).
 *
 * REQ-1 persists `prefixHistory` (small fingerprints) so the rewrite PREDICTOR
 * survives a restart. This module extends that to the KA ENGINE: it serialises
 * each session's snapshot registry + the timing scalars needed to decide,
 * after a restart, whether the cache is still alive.
 *
 * ──────────────────────────────────────────────────────────────
 *  THE CORRECTNESS HAZARD
 * ──────────────────────────────────────────────────────────────
 *
 * Re-arming KA on a snapshot whose cache has already expired is WORSE than not
 * reviving at all: the first KA fire replays an evicted prefix → a full cold
 * `cache_creation` write → quota burned on a request the user never made
 * (the `anomalous:stale-ka-snapshot` failure mode). Therefore `assessRevival`
 * decides revive-vs-drop from the ABSOLUTE server-confirmed warm-up timestamp
 * (`cacheWrittenAt`, set only after the KA/real response's `message_stop`) and
 * the MINIMUM observed cache TTL — with a safety margin AND the unavoidable
 * wait before a revived engine's first tick can fire. When in doubt: drop.
 *
 * Every function here is best-effort and NEVER THROWS — a persistence failure
 * must never break a request or a fire.
 */

import { readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Schema version — a mismatch on load discards the file (clean upgrade). */
export const KA_SNAPSHOT_SCHEMA_VERSION = 1

/**
 * Default persistence location.
 *
 * `CLAUDE_KA_SNAPSHOT_PATH` overrides it — same escape hatch as
 * `CLAUDE_KEEPALIVE_CONFIG_PATH`, and the test preload sets it. Without one, a
 * ProxyClient built in a test reads the LIVE fleet's 70-MB snapshot file,
 * revives every session in it inside the test process, and writes the file back
 * on `stop()` — an accident that only stays harmless while nobody's test
 * happens to hold a shorter view of the fleet than the daemon does.
 */
export const DEFAULT_KA_SNAPSHOT_PATH = process.env.CLAUDE_KA_SNAPSHOT_PATH
  || join(homedir(), '.claude-local', 'proxy-ka-snapshots.json')

/** Entries older than this (since last warm-up) are never revived — bounds
 *  file growth and discards anything that cannot be a live 5m/1h cache. */
export const KA_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000

// ──────────────────────────────────────────────────────────────
// Serialisable shapes
// ──────────────────────────────────────────────────────────────

/** One KA registry entry — mirrors KeepaliveEngine's internal RegistryEntry. */
export interface PersistedRegistryEntry {
  body: Record<string, unknown>
  headers: Record<string, string>
  model: string
  lineageKey: string
  role: string
  inputTokens: number
  hasCacheControl: boolean
}

/** Engine-wide state required to revive an armed KeepaliveEngine. */
export interface PersistedEngineState {
  /** Absolute ms of the last SERVER-CONFIRMED cache warm-up (real req or KA). */
  cacheWrittenAt: number
  /** Effective cache TTL the engine was using (already wire-downlocked). */
  cacheTtlMs: number
  cacheTtlOverridden: boolean
  cacheTtlObservedLocked: boolean
  lastObservedTtlMs: number | null
  ttlEverObserved: boolean
  /** Largest observed cache size per model — feeds the rewrite-cost estimate. */
  lastKnownCacheTokensByModel: Record<string, number>
  registry: PersistedRegistryEntry[]
}

/** A persisted session = engine state + the identity needed to recreate it. */
export interface PersistedSession extends PersistedEngineState {
  sessionId: string
  ownerPid: number | null
  model: string | null
  /**
   * The ACCOUNT this session's cache belongs to.
   *
   * Anthropic caches per account, so a prefix bought under one account is worth
   * nothing to the other. Without this field the registry could say which
   * session a snapshot belonged to but not whose cache it was, and a revived
   * keepalive fired against whatever account happened to be active — buying the
   * whole prefix again.
   *
   * Measured 2026-08-13..20: 21.8% of keepalive fires in the first ten minutes
   * after a proxy restart paid for a full rewrite, against 0.12% three hours
   * later — about a million tokens per restart, 27 restarts in the week. The
   * founder named this cause before the code was read; the field is what lets a
   * revived session be warmed on the account that owns its cache.
   *
   * Null when the session had no account resolved at save time.
   */
  orgId: string | null
}

export interface KaSnapshotFile {
  version: number
  savedAt: number
  sessions: Record<string, PersistedSession>
}

function emptyFile(): KaSnapshotFile {
  return { version: KA_SNAPSHOT_SCHEMA_VERSION, savedAt: 0, sessions: {} }
}

// ──────────────────────────────────────────────────────────────
// Load / save — never throw
// ──────────────────────────────────────────────────────────────

/**
 * Load the persisted KA snapshot file. A missing, corrupt, or wrong-version
 * file yields an empty result — the proxy then simply starts with no revived
 * sessions (degrades to pre-feature behaviour). Never throws.
 */
export function loadKaSnapshots(path: string): KaSnapshotFile {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<KaSnapshotFile>
    if (!raw || raw.version !== KA_SNAPSHOT_SCHEMA_VERSION
        || !raw.sessions || typeof raw.sessions !== 'object') {
      return emptyFile()
    }
    const sessions: Record<string, PersistedSession> = {}
    for (const [sid, s] of Object.entries(raw.sessions)) {
      // Shape-validate each session — a half-written entry is skipped, not fatal.
      if (s && typeof s === 'object'
          && typeof (s as PersistedSession).cacheWrittenAt === 'number'
          && typeof (s as PersistedSession).cacheTtlMs === 'number'
          && Array.isArray((s as PersistedSession).registry)
          && (s as PersistedSession).registry.length > 0) {
        sessions[sid] = s as PersistedSession
      }
    }
    return {
      version: KA_SNAPSHOT_SCHEMA_VERSION,
      savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
      sessions,
    }
  } catch {
    return emptyFile()
  }
}

/**
 * Persist the KA snapshot file. Best-effort — a write failure is swallowed so
 * it can never break the request path. The `version`/`savedAt` are stamped here.
 */
/**
 * Persist the KA registry. Never throws — but it now SAYS when it failed.
 *
 * A silent failure here is invisible until the next restart, and then it costs
 * the whole fleet its warmth at once: every session revives from this file, so
 * an unwritten file means every idle agent wakes into a full cold rewrite. A
 * full disk, a permission change or a bad path produced exactly the same
 * nothing as a healthy write — the same shape of blindness that cost a morning
 * on 2026-08-19, when a keepalive fire recorded only its successes.
 *
 * Returns true on a written file, false on a swallowed failure, so the caller
 * can report it once per episode instead of writing every 10 seconds into the
 * void. The error itself rides along for the report.
 */
export function saveKaSnapshots(
  sessions: Record<string, PersistedSession>,
  path: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const file: KaSnapshotFile = {
      version: KA_SNAPSHOT_SCHEMA_VERSION,
      savedAt: Date.now(),
      sessions,
    }
    // 0600: the file describes every live session and must not be readable by
    // other users of the machine. It sat at 0664 in a 0777 directory until
    // 2026-08-20.
    writeFileSync(path, JSON.stringify(file), { mode: 0o600 })
    return { ok: true }
  } catch (e) {
    // Still never breaks the request path — the caller decides what to say.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ──────────────────────────────────────────────────────────────
// Revive-vs-drop decision — pure, clock-only
// ──────────────────────────────────────────────────────────────

export type RevivalDropReason =
  | 'no-snapshot'            // nothing registered — nothing to revive
  | 'too-old'               // last warm-up older than the max-age bound
  | 'cache-already-dead'    // now >= cacheDiesAt — cache has already lapsed
  | 'cache-dies-before-ka'  // cache alive now, but dies before a KA could land
  | 'owner-dead'            // owner PID is gone (decided by the caller, not here)

export type RevivalVerdict =
  | { revive: true }
  | { revive: false; reason: RevivalDropReason }

export interface RevivalAssessmentOpts {
  /** Margin subtracted from the hard TTL — the cache is treated dead this early. */
  safetyMarginMs: number
  /** The engine's KA interval — a revived engine fires at ~0.9 of it. */
  intervalMs: number
  /** Max age since last warm-up beyond which a snapshot is never revived. */
  maxAgeMs: number
  /** Allowance for the KA fire round-trip itself. */
  fireBudgetMs: number
}

/**
 * Decide whether a persisted engine's cache is still warm enough to revive KA
 * for. Pure, clock-only, never throws. Owner-PID liveness is NOT checked here
 * (the caller does that — it needs an injectable liveness checker); a dead
 * owner is reported by the caller as `owner-dead`.
 *
 *   cacheDiesAt = cacheWrittenAt + cacheTtlMs - safetyMarginMs   (engine's own formula)
 *
 * A revived engine cannot fire instantly — its first eligible tick fires when
 * idle >= 0.9*intervalMs. Since `lastActivityAt` is seeded to `cacheWrittenAt`
 * on revive, the remaining wait is `max(0, 0.9*intervalMs - age)`. The cache
 * must still be alive AFTER that wait plus the fire round-trip — otherwise the
 * fire would land on a dead cache and cold-write it.
 */
export function assessRevival(
  s: PersistedEngineState,
  now: number,
  opts: RevivalAssessmentOpts,
): RevivalVerdict {
  try {
    if (!s.registry || s.registry.length === 0) {
      return { revive: false, reason: 'no-snapshot' }
    }
    const age = now - s.cacheWrittenAt
    if (age > opts.maxAgeMs || age < 0) {
      return { revive: false, reason: 'too-old' }
    }
    const cacheDiesAt = s.cacheWrittenAt + s.cacheTtlMs - opts.safetyMarginMs
    if (now >= cacheDiesAt) {
      return { revive: false, reason: 'cache-already-dead' }
    }
    // The revived engine clamps its KA interval exactly as KeepaliveEngine
    // does — to [60s, cacheTtl - safetyMargin - 60s]. Use that EFFECTIVE
    // interval, NOT the raw SSOT value: a 30-min SSOT interval would make
    // 0.9*interval ≈ 27 min and falsely fail every still-warm snapshot.
    const clampMax = Math.max(60_000, s.cacheTtlMs - opts.safetyMarginMs - 60_000)
    const effIntervalMs = Math.min(Math.max(opts.intervalMs, 60_000), clampMax)
    const remainingWait = Math.max(0, 0.9 * effIntervalMs - age)
    if (now + remainingWait + opts.fireBudgetMs >= cacheDiesAt) {
      return { revive: false, reason: 'cache-dies-before-ka' }
    }
    return { revive: true }
  } catch {
    return { revive: false, reason: 'no-snapshot' }
  }
}
