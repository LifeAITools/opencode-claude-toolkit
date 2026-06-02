/**
 * Logger — subscribes to event-bus, writes human-readable + JSONL streams.
 *
 * Human format: [ts] LEVEL KIND  key=val key=val   — one line per event
 * JSON format:  full event object per line
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { dirname } from 'path'
import type { ProxyEvent, UsageEventPayload } from './event-bus.js'
import { bus } from './event-bus.js'
import type { ProxyConfig } from './config.js'

// ═══ Stats-line compact usage shape ═══════════════════════════════════
//
// Producer-facing helper that converts a UsageEventPayload (verbose,
// long-key form used inside the proxy event bus) into the short-key
// compact shape consumed by `~/.claude-local/claude-max-stats.jsonl`
// readers (quota-report.ts, cache-config.ts, opencode-claude/provider.ts,
// signal-wire.ts).
//
// Existing required keys (`in`, `out`, `cacheRead`, `cacheWrite`) are
// always present. The new optional TTL-split + cache-deleted keys
// (`cacheWrite5m`, `cacheWrite1h`, `cacheDeleted`) are emitted ONLY when
// the underlying Anthropic response included the corresponding subfield —
// per plan §527-528 we MUST omit (not zero / null) when absent so legacy
// readers continue to parse old + new entries without conditional logic
// and so `cacheWrite5m + cacheWrite1h === cacheWrite` invariant is never
// silently violated by zero-padding.
//
// REQ-05, CR-06 (separate fields), CN-09 (no bare catch — pure
// transform, no I/O).

export interface CompactStatsUsage {
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  cacheWrite5m?: number
  cacheWrite1h?: number
  cacheDeleted?: number
}

/**
 * Render the compact usage shape written to claude-max-stats.jsonl.
 *
 * @param u UsageEventPayload from REAL_REQUEST_COMPLETE / KA_FIRE_COMPLETE
 * @returns object with omit-when-absent optional subfields
 */
export function toCompactStatsUsage(u: UsageEventPayload): CompactStatsUsage {
  const out: CompactStatsUsage = {
    in: u.inputTokens,
    out: u.outputTokens,
    cacheRead: u.cacheReadInputTokens,
    cacheWrite: u.cacheCreationInputTokens,
  }
  if (typeof u.cacheCreation5mInputTokens === 'number') {
    out.cacheWrite5m = u.cacheCreation5mInputTokens
  }
  if (typeof u.cacheCreation1hInputTokens === 'number') {
    out.cacheWrite1h = u.cacheCreation1hInputTokens
  }
  if (typeof u.cacheDeletedInputTokens === 'number') {
    out.cacheDeleted = u.cacheDeletedInputTokens
  }
  return out
}

const LEVEL_RANK: Record<string, number> = { error: 0, info: 1, debug: 2 }

// ANSI colors (stdout only — file gets plain)
const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  blue: '\x1b[34m',
  gray: '\x1b[90m',
}

function levelColor(level: string): string {
  if (level === 'error') return C.red
  if (level === 'debug') return C.gray
  return C.cyan
}

function kindColor(kind: string): string {
  if (kind.startsWith('KA_FIRE_COMPLETE')) return C.green
  if (kind.startsWith('KA_') && (kind.includes('ERROR') || kind.includes('DISARM'))) return C.red
  if (kind.startsWith('KA_')) return C.cyan
  if (kind.startsWith('REAL_REQUEST')) return C.blue
  if (kind.startsWith('TOKEN_') && (kind.includes('EXPIRED') || kind.includes('FAILED') || kind.includes('RELOGIN'))) return C.red
  if (kind.startsWith('TOKEN_')) return C.magenta
  if (kind.startsWith('NETWORK_DEGRADED') || kind.startsWith('REWRITE_')) return C.yellow
  if (kind.startsWith('NETWORK_HEALTHY')) return C.green
  if (kind.startsWith('SESSION_DEAD')) return C.yellow
  if (kind.startsWith('SESSION_TRACKED')) return C.green
  return C.dim
}

function formatHuman(e: ProxyEvent, withColor: boolean): string {
  const ts = e.ts.slice(11, 23)  // HH:mm:ss.SSS
  const level = e.level.toUpperCase().padEnd(5)
  const kind = e.kind.padEnd(22)

  // Extract known keys for compact display, skip ts/level/kind/msg
  const extras: string[] = []
  for (const [k, v] of Object.entries(e as any)) {
    if (['ts', 'level', 'kind', 'msg'].includes(k)) continue
    if (v === null || v === undefined) continue
    // Nested objects — stringify short
    if (typeof v === 'object') {
      const compact = JSON.stringify(v)
      if (compact.length <= 120) extras.push(`${k}=${compact}`)
      else extras.push(`${k}=<${Object.keys(v).length}keys>`)
    } else {
      extras.push(`${k}=${v}`)
    }
  }

  const msg = (e as any).msg ? ` ${(e as any).msg}` : ''
  const kv = extras.length ? ' ' + extras.join(' ') : ''

  if (withColor) {
    return `${C.dim}${ts}${C.reset} ${levelColor(e.level)}${level}${C.reset} ${kindColor(e.kind)}${kind}${C.reset}${msg}${C.dim}${kv}${C.reset}`
  }
  return `${ts} ${level} ${kind}${msg}${kv}`
}

function ensureDir(path: string): void {
  try { mkdirSync(dirname(path), { recursive: true }) } catch {}
}

// ═══ Size-based log rotation ══════════════════════════════════════════
//
// The human + JSONL streams are append-only and were otherwise unbounded —
// the JSONL alone was observed at ~196 MB (every KA tick across ~13 live
// sessions, every 30s, adds up fast). We rotate per-stream on a byte
// threshold: active → .1 → .2 → … → .<keep>, dropping the oldest.
//
// Design choices (match body-capture.ts's simple, non-blocking idiom):
//   • renameSync is an atomic metadata op — instant even for a 196 MB file,
//     unlike gzipping it inline which would stall the event loop serving
//     live sessions. (Compression is left as a future opt-in.)
//   • An in-memory byte counter (seeded once from statSync at startup) avoids
//     a statSync syscall on every single event in the hot path.
//   • Disk is bounded at ~(keep + 1) × maxMb per stream. maxMb = 0 disables.

interface RotatingSink {
  path: string
  bytes: number      // running size of the active file (bytes)
  maxBytes: number   // rotate threshold; 0 = never rotate
  keep: number       // number of .N backups retained
}

/** Build a sink, seeding the byte counter from the existing file (if any). */
function makeSink(path: string, maxMb: number, keep: number): RotatingSink {
  let bytes = 0
  try { bytes = statSync(path).size } catch { /* fresh file → 0 */ }
  return { path, bytes, maxBytes: maxMb > 0 ? maxMb * 1024 * 1024 : 0, keep }
}

/**
 * Shift backups and move the active file aside: drop .<keep>, then
 * .<keep-1>→.<keep>, …, .1→.2, active→.1. Every rename is best-effort — a
 * missing intermediate (e.g. keep was raised between runs, or a stream that
 * never reached .N yet) is skipped, not fatal. The active path is left absent;
 * the next appendFileSync recreates it.
 */
function rotateSink(sink: RotatingSink): void {
  const { path, keep } = sink
  try { unlinkSync(`${path}.${keep}`) } catch { /* may not exist */ }
  for (let i = keep - 1; i >= 1; i--) {
    try { renameSync(`${path}.${i}`, `${path}.${i + 1}`) } catch { /* gap — skip */ }
  }
  try { renameSync(path, `${path}.1`) } catch { /* active not created yet */ }
  sink.bytes = 0
}

/** Append a line (must already include its trailing newline), rotating first
 *  if the write would breach the cap. Never throws into the hot path. */
function writeRotating(sink: RotatingSink, line: string): void {
  const len = Buffer.byteLength(line)
  // Rotate BEFORE the breaching write — but never rotate an empty active file:
  // a single line larger than maxBytes must still land, else we'd rotate
  // forever while writing nothing.
  if (sink.maxBytes > 0 && sink.bytes > 0 && sink.bytes + len > sink.maxBytes) {
    rotateSink(sink)
  }
  try {
    appendFileSync(sink.path, line)
    sink.bytes += len
  } catch { /* swallow — logging must never break request handling */ }
}

// Exported for unit tests (test/logger-rotation.test.ts). Not part of the
// public logger API — startLogger is the only intended runtime entry point.
export const __rotationInternals = { makeSink, rotateSink, writeRotating }

export function startLogger(cfg: ProxyConfig): () => void {
  const minRank = LEVEL_RANK[cfg.logLevel] ?? 1

  ensureDir(cfg.logFile)
  ensureDir(cfg.logJsonl)

  const humanSink = makeSink(cfg.logFile, cfg.logMaxMb, cfg.logKeep)
  const jsonlSink = makeSink(cfg.logJsonl, cfg.logMaxMb, cfg.logKeep)

  const unsub = bus.onEvent((e) => {
    const rank = LEVEL_RANK[e.level] ?? 1
    if (rank > minRank) return

    // Human stdout (colored)
    if (cfg.logFormat === 'human' || cfg.logFormat === 'both') {
      process.stdout.write(formatHuman(e, true) + '\n')
      // File (no color) — rotated
      writeRotating(humanSink, formatHuman(e, false) + '\n')
    }

    // Structured JSONL — rotated
    if (cfg.logFormat === 'json' || cfg.logFormat === 'both') {
      writeRotating(jsonlSink, JSON.stringify(e) + '\n')
    }
  })

  return unsub
}
