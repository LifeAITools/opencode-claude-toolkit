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

/** Default persistence location. */
export const DEFAULT_KA_SNAPSHOT_PATH = join(homedir(), '.claude-local', 'proxy-ka-snapshots.json')

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
export function saveKaSnapshots(sessions: Record<string, PersistedSession>, path: string): void {
  try {
    const file: KaSnapshotFile = {
      version: KA_SNAPSHOT_SCHEMA_VERSION,
      savedAt: Date.now(),
      sessions,
    }
    writeFileSync(path, JSON.stringify(file))
  } catch {
    /* best-effort — never break the request path */
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
    const remainingWait = Math.max(0, 0.9 * opts.intervalMs - age)
    if (now + remainingWait + opts.fireBudgetMs >= cacheDiesAt) {
      return { revive: false, reason: 'cache-dies-before-ka' }
    }
    return { revive: true }
  } catch {
    return { revive: false, reason: 'no-snapshot' }
  }
}
