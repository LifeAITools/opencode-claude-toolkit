/**
 * rewrite-dump.ts — persist a guard-blocked request for offline analysis.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * When the rewrite guard blocks a request it returns a 400 and the request
 * is gone — there is nothing left to inspect. But a block is exactly the
 * moment a human (or another agent) wants to SEE: what was the request, why
 * did the predictor think it would re-cache, and HOW does its cacheable
 * prefix differ from the previous one of the same lineage.
 *
 * On every block we therefore write one self-contained JSON artifact:
 *   - the full blocked request body (the one the proxy believes triggers
 *     the rewrite),
 *   - the previous request's cacheable prefix (system + tools) for that
 *     lineage, when known,
 *   - a computed prefix diff + the predictor's verdict & signals.
 *
 * An analysing agent reads ONE file and has everything. The proxy also
 * "saves the diff itself" — `prefixDiff` is pre-computed so no second pass
 * is needed for the common questions (which tools changed, did system move,
 * or was it purely a TTL/idle event with no content change at all).
 *
 * Every function here is best-effort and NEVER THROWS — a dump failure must
 * not affect the request path (the request is already being rejected; a
 * broken dump must not turn a 400 into a 500).
 */

import { createHash } from 'crypto'
import { mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** Default location for guard-block dumps. */
export const DEFAULT_REWRITE_DUMP_DIR = join(homedir(), '.claude-local', 'rewrite-guard-blocks')

function md5(s: string, len = 12): string {
  return createHash('md5').update(s).digest('hex').slice(0, len)
}

function safeStr(v: unknown): string {
  try { return JSON.stringify(v) } catch { return '' }
}

/** Sorted tool-name list of a request body's `tools`. */
function toolNameList(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  const out: string[] = []
  for (const t of tools) {
    const n = t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined
    if (typeof n === 'string') out.push(n)
  }
  return out.sort()
}

/** A request's cacheable prefix — system + tools are what define cache identity. */
export interface CachePrefix {
  system: unknown
  tools: unknown
}

export interface PrefixDiff {
  /** No previous prefix on record (first request of the lineage). */
  noBaseline: boolean
  systemChanged: boolean
  toolsChanged: boolean
  /** system block-text length, previous vs current. */
  systemLen: { prev: number; cur: number }
  /** Tool-name set deltas. */
  tools: { added: string[]; removed: string[]; definitionChanged: string[] }
  /** Human summary — the one-line "what differs". */
  summary: string
}

/**
 * Structured diff of two cacheable prefixes. Pure, never throws. When `prev`
 * is null the request is the lineage's first — `noBaseline` is set and the
 * caller knows the rewrite is an unavoidable cold start, not a divergence.
 */
export function diffPrefix(prev: CachePrefix | null, cur: CachePrefix): PrefixDiff {
  try {
    const curSys = safeStr(cur.system)
    const curTools = toolNameList(cur.tools)
    if (!prev) {
      return {
        noBaseline: true, systemChanged: false, toolsChanged: false,
        systemLen: { prev: 0, cur: curSys.length },
        tools: { added: curTools, removed: [], definitionChanged: [] },
        summary: 'no previous prefix on record — first request of this lineage',
      }
    }
    const prevSys = safeStr(prev.system)
    const prevTools = toolNameList(prev.tools)
    const systemChanged = prevSys !== curSys
    const prevSet = new Set(prevTools)
    const curSet = new Set(curTools)
    const added = curTools.filter((n) => !prevSet.has(n))
    const removed = prevTools.filter((n) => !curSet.has(n))
    // tools present in both but whose full definition (description etc.) moved
    const defChanged: string[] = []
    if (Array.isArray(prev.tools) && Array.isArray(cur.tools)) {
      const byName = (arr: unknown[]) => {
        const m = new Map<string, string>()
        for (const t of arr) {
          if (t && typeof t === 'object') {
            const n = (t as { name?: unknown }).name
            if (typeof n === 'string') m.set(n, md5(safeStr(t), 16))
          }
        }
        return m
      }
      const pm = byName(prev.tools), cm = byName(cur.tools)
      for (const [n, h] of cm) {
        if (pm.has(n) && pm.get(n) !== h) defChanged.push(n)
      }
    }
    const toolsChanged = added.length > 0 || removed.length > 0 || defChanged.length > 0
    const parts: string[] = []
    if (systemChanged) parts.push(`system changed (${prevSys.length}->${curSys.length} chars)`)
    if (added.length) parts.push(`tools added: ${added.join(',')}`)
    if (removed.length) parts.push(`tools removed: ${removed.join(',')}`)
    if (defChanged.length) parts.push(`tool defs changed: ${defChanged.join(',')}`)
    return {
      noBaseline: false, systemChanged, toolsChanged,
      systemLen: { prev: prevSys.length, cur: curSys.length },
      tools: { added, removed, definitionChanged: defChanged },
      summary: parts.length
        ? parts.join('; ')
        : 'cacheable prefix IDENTICAL — rewrite is not content-driven '
          + '(TTL/idle, org-switch, or stale-KA), not a system/tools change',
    }
  } catch {
    return {
      noBaseline: false, systemChanged: false, toolsChanged: false,
      systemLen: { prev: 0, cur: 0 },
      tools: { added: [], removed: [], definitionChanged: [] },
      summary: 'diff failed',
    }
  }
}

export interface RewriteBlockDumpInput {
  sessionId: string
  lineageKey: string
  rewriteClass: string
  predictedTokens: number
  /** Predictor signals that drove the verdict. */
  signals: {
    systemChanged: boolean
    toolsChanged: boolean
    orgChanged: boolean
    idleMs: number | null
    ttlMs: number
  }
  /** The full request body the guard rejected. */
  blockedRequest: unknown
  /** Previous cacheable prefix of this lineage, or null if none on record. */
  previousPrefix: CachePrefix | null
}

/**
 * Write one guard-block dump artifact. Returns the file path, or null on any
 * failure (logged by the caller). Never throws.
 *
 * Layout — one JSON file per block:
 *   <dir>/<ISO-compact ts>-<sid8>-<rewriteClass>.json
 */
export function writeRewriteBlockDump(
  dir: string,
  input: RewriteBlockDumpInput,
): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const body = (input.blockedRequest && typeof input.blockedRequest === 'object')
      ? input.blockedRequest as Record<string, unknown>
      : {}
    const curPrefix: CachePrefix = { system: body.system, tools: body.tools }
    const prefixDiff = diffPrefix(input.previousPrefix, curPrefix)

    const tsIso = new Date().toISOString()
    const fname = `${tsIso.replace(/[:.]/g, '-')}-${input.sessionId.slice(0, 8)}`
      + `-${input.rewriteClass.replace(/[^a-zA-Z0-9-]+/g, '_')}.json`
    const path = join(dir, fname)

    const artifact = {
      ts: tsIso,
      sessionId: input.sessionId,
      lineageKey: input.lineageKey,
      verdict: {
        rewriteClass: input.rewriteClass,
        predictedTokens: input.predictedTokens,
        signals: input.signals,
      },
      // pre-computed so an analysing agent needs no second pass
      prefixDiff,
      // both sides of the comparison, full content
      previousPrefix: input.previousPrefix,
      blockedRequest: input.blockedRequest,
    }
    writeFileSync(path, JSON.stringify(artifact, null, 2) + '\n')
    return path
  } catch {
    return null
  }
}
