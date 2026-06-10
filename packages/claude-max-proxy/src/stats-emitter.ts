/**
 * stats-emitter — Stage 1 of the quota pipeline (the EMITTER).
 *
 * Subscribes to the proxy event-bus and appends a NARROW, VERSIONED, STABLE
 * stats line to `claude-max-stats.jsonl` for every upstream response that
 * carries rate-limit utilisation. This file is the *only* writer of that
 * stream and the single coupling point to the downstream processor.
 *
 * ─── Why a dedicated stream (not the verbose proxy log) ───────────────
 *
 * logger.ts already writes EVERY bus event to the verbose JSONL log. We do
 * NOT make the processor tail that, because its shape changes whenever proxy
 * logging evolves — and a shape change must never break a running quota
 * processor. Instead this emitter projects only the fields the processor's
 * contract needs, stamped with `v: STATS_SCHEMA_VERSION`. The verbose log can
 * change freely; this contract does not.
 *
 * ─── Contract (one line per qualifying response) ─────────────────────
 *
 *   { v, ts, pid, type:"stream", model,
 *     usage:    { in, out, cacheRead, cacheWrite },
 *     rateLimit:{ status, util5h, util7d, resetAt? } }
 *
 *   - pid       : the proxy process pid (single writer).
 *   - type      : always "stream" — the processor filters on this.
 *   - resetAt   : unix-SECONDS, present only when upstream gave a reset hint.
 *
 * ─── Failure policy ──────────────────────────────────────────────────
 *
 * A write failure must never propagate into the event bus (which would
 * cascade into request handling). Every append is wrapped: on error we emit a
 * single throttled bus warning and drop the line. The pipeline degrades to
 * "stale quota-status" — which the injector already tolerates — rather than
 * destabilising the proxy.
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type {
  ProxyEvent,
  RealRequestCompleteEvent,
  KaFireCompleteEvent,
  UsageEventPayload,
} from './event-bus.js'
import { bus, emit } from './event-bus.js'
import { STATS_JSONL, STATS_SCHEMA_VERSION, orgKeyFromOauth } from './quota-paths.js'

const PROXY_PID = process.pid

// Throttle write-failure warnings so a persistent fs problem (e.g. disk full)
// can't itself firehose the log. One warning per WRITE_WARN_THROTTLE_MS.
const WRITE_WARN_THROTTLE_MS = 30_000
let lastWriteWarnAt = 0

interface StatsLineUsage {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
}

interface StatsLine {
  v: number
  ts: string
  pid: number
  type: 'stream'
  model: string
  /** Proxy session id of the request — lets quota consumers attribute a
   *  CLAUDE SESSION to its org (multi-org hosts). */
  ses?: string
  /** Stable per-ORGANIZATION key (additive, multi-org hosts). Today derived
   *  from the credentials this proxy instance serves — when several proxy
   *  instances with different org tokens share one stats.jsonl, each stamps
   *  its own org and the processor attributes quota to the right one.
   *  FUTURE multi-token-in-one-proxy: the org of the token ACTUALLY used per
   *  request must ride on RealRequestCompleteEvent and be used here instead. */
  org?: string
  usage: StatsLineUsage
  rateLimit: {
    status: string | null
    util5h: number | null
    util7d: number | null
    resetAt?: number // unix-seconds; omitted when unknown
  }
}

// ─── Org identity of the credentials THIS proxy serves ────────────────
// The credentials file has no organization uuid, so the stable basis is the
// refreshToken (outlives access-token rotation; rotations are migrated by the
// processor's creds watcher). Cached by file mtime, re-stat'ed ≤ once / 5s.
const CREDS_PATH = join(homedir(), '.claude', '.credentials.json')
let orgCache = { key: null as string | null, mtimeMs: 0, checkedAt: 0 }

function currentOrgKey(): string | null {
  const now = Date.now()
  if (now - orgCache.checkedAt < 5_000) return orgCache.key
  orgCache.checkedAt = now
  try {
    const st = statSync(CREDS_PATH)
    if (st.mtimeMs === orgCache.mtimeMs) return orgCache.key
    const oauth = JSON.parse(readFileSync(CREDS_PATH, 'utf8'))?.claudeAiOauth
    orgCache = { key: orgKeyFromOauth(oauth), mtimeMs: st.mtimeMs, checkedAt: now }
  } catch {
    orgCache = { key: null, mtimeMs: 0, checkedAt: now }
  }
  return orgCache.key
}

function projectUsage(u: UsageEventPayload | undefined): StatsLineUsage {
  return {
    in: u?.inputTokens ?? 0,
    out: u?.outputTokens ?? 0,
    cacheRead: u?.cacheReadInputTokens ?? 0,
    cacheWrite: u?.cacheCreationInputTokens ?? 0,
  }
}

function appendStatsLine(line: StatsLine): void {
  try {
    appendFileSync(STATS_JSONL, JSON.stringify(line) + '\n')
  } catch (e: any) {
    const now = Date.now()
    if (now - lastWriteWarnAt >= WRITE_WARN_THROTTLE_MS) {
      lastWriteWarnAt = now
      // Best-effort warning; if the bus itself throws we still don't crash.
      try {
        emit({
          level: 'error',
          kind: 'ERROR',
          msg: `stats-emitter: append to ${STATS_JSONL} failed: ${e?.message ?? String(e)}`,
        })
      } catch {}
    }
  }
}

function ensureDir(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true }) } catch {}
}

/**
 * Start the stats emitter. Returns an unsubscribe fn (for hot-stop / tests).
 * Mirrors startLogger(cfg)'s lifecycle so server.ts wires it the same way.
 */
export function startStatsEmitter(): () => void {
  ensureDir(STATS_JSONL)

  const unsub = bus.onEvent((e: ProxyEvent) => {
    // Only responses carrying rate-limit utilisation feed the quota processor.
    if (e.kind !== 'REAL_REQUEST_COMPLETE' && e.kind !== 'KA_FIRE_COMPLETE') return

    const ev = e as RealRequestCompleteEvent | KaFireCompleteEvent
    const util5h = ev.rateLimit?.util5h ?? null
    const util7d = ev.rateLimit?.util7d ?? null
    // The processor skips lines with no util on both axes — don't bother writing them.
    if (util5h === null && util7d === null) return

    // Org precedence: the EVENT's per-request org (multi-org proxy — the org
    // whose token actually served this request) wins; the credentials-file
    // fallback covers pre-multi-org SDK builds / unpinned sessions.
    const org = ev.org ?? currentOrgKey()
    const line: StatsLine = {
      v: STATS_SCHEMA_VERSION,
      ts: ev.ts,
      pid: PROXY_PID,
      type: 'stream',
      model: ev.model ?? '?',
      ...(org ? { org } : {}),
      ...(ev.sessionId ? { ses: ev.sessionId } : {}),
      usage: projectUsage(ev.usage),
      rateLimit: {
        status: (ev.rateLimit as any)?.status ?? null,
        util5h,
        util7d,
      },
    }
    appendStatsLine(line)
  })

  emit({
    level: 'info',
    kind: 'INFO',
    msg: `stats-emitter armed → ${STATS_JSONL} (schema v${STATS_SCHEMA_VERSION}, pid ${PROXY_PID})`,
  })

  return unsub
}
