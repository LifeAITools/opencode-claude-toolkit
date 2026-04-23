/**
 * Logger — subscribes to event-bus, writes human-readable + JSONL streams.
 *
 * Human format: [ts] LEVEL KIND  key=val key=val   — one line per event
 * JSON format:  full event object per line
 */

import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { ProxyEvent } from './event-bus.js'
import { bus } from './event-bus.js'
import type { ProxyConfig } from './config.js'

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

export function startLogger(cfg: ProxyConfig): () => void {
  const minRank = LEVEL_RANK[cfg.logLevel] ?? 1

  ensureDir(cfg.logFile)
  ensureDir(cfg.logJsonl)

  const unsub = bus.onEvent((e) => {
    const rank = LEVEL_RANK[e.level] ?? 1
    if (rank > minRank) return

    // Human stdout (colored)
    if (cfg.logFormat === 'human' || cfg.logFormat === 'both') {
      process.stdout.write(formatHuman(e, true) + '\n')
      // File (no color)
      try { appendFileSync(cfg.logFile, formatHuman(e, false) + '\n') } catch {}
    }

    // Structured JSONL
    if (cfg.logFormat === 'json' || cfg.logFormat === 'both') {
      try { appendFileSync(cfg.logJsonl, JSON.stringify(e) + '\n') } catch {}
    }
  })

  return unsub
}
