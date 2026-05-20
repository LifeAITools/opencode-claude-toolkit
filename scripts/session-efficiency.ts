#!/usr/bin/env bun
/**
 * session-efficiency — per-session token-efficiency analyzer.
 *
 * Compares native Claude Code vs opencode through the SAME claude-max-proxy
 * endpoint (same OAuth subscription, same Anthropic billing path) — but
 * normalized by output produced. The key metric the operator cares about:
 *
 *   `quota_per_output_token` — how much util5h % is burned per 1k output tokens
 *
 * Why session-level: util5h is a single sliding global counter, so we cannot
 * subtract sessions in parallel — we have to look at idle gaps. We use a
 * per-session aggregation over its own request stream: sum tokens within
 * the session and the Δutil5h between session's first vs last sample.
 *
 * Data source:
 *   `~/.claude-local/claude-max-stats.jsonl` — line-oriented JSONL with per-turn
 *   model/usage/rateLimit. Includes both opencode (writes from provider.ts) and
 *   native CC (writes from claude-max-proxy SSE-tee). Differentiated by `pid`
 *   field and (when present) `ses` session id.
 *
 * Output:
 *   - Per-session table: source kind, model, turn count, in/out tokens, cache
 *     read/write, Δutil5h, cost-per-1k-output (lower = more efficient).
 *   - Comparison summary: native median vs opencode median for the same model.
 *
 * Usage:
 *   bun run session-efficiency.ts                     # last 24h
 *   bun run session-efficiency.ts --since 1h          # last hour
 *   bun run session-efficiency.ts --model opus-4-7    # filter
 *   bun run session-efficiency.ts --session 81be0994  # one session only
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const STATS_PATH = process.env.CLAUDE_MAX_STATS_PATH
  ?? join(homedir(), '.claude-local', 'claude-max-stats.jsonl')

interface StatEntry {
  ts: string
  type: string
  model: string
  pid?: number
  ses?: string
  dur?: number
  usage?: {
    in?: number; out?: number
    cacheRead?: number; cacheWrite?: number
    cacheWrite5m?: number; cacheWrite1h?: number; cacheDeleted?: number
  }
  rateLimit?: {
    status?: string
    claim?: string
    util5h?: number; util7d?: number
  }
}

interface SessionAgg {
  key: string                 // pid or pid+ses
  pid: number
  ses: string
  source: 'native' | 'opencode' | 'unknown'
  model: string
  turns: number
  firstTs: number
  lastTs: number
  durTotalMs: number
  in: number
  out: number
  cacheRead: number
  cacheWrite: number
  cacheWrite5m: number
  cacheWrite1h: number
  firstUtil5h: number
  lastUtil5h: number
  maxUtil5h: number
  minUtil5h: number
}

function classifySource(e: StatEntry): 'native' | 'opencode' | 'unknown' {
  // Attribution priority (in order):
  // 1. Tag set during load() from the source file.
  // 2. ses field shape (uuid = native CC; ses_… = opencode).
  // 3. pid presence (opencode tags pid; native does not).
  const tagged = (e as any).__source
  if (tagged === 'native-proxy-log') return 'native'
  if (tagged === 'opencode-stats') {
    // opencode-stats may include both real opencode AND some keep-alive
    // entries written by claude-max-proxy. Distinguish:
    //   - has pid > 0 + ses="?" → opencode provider.ts logStats()
    //   - no pid OR ses=uuid → could be proxy-written
    if ((e.pid ?? 0) > 0) return 'opencode'
  }
  const ses = e.ses ?? ''
  if (ses.startsWith('ses_')) return 'opencode'
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(ses)) return 'native'
  return 'unknown'
}

function load(): StatEntry[] {
  const out: StatEntry[] = []

  // Source 1: opencode stats (pure JSONL, written by provider.ts logStats)
  try {
    const raw = readFileSync(STATS_PATH, 'utf-8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let obj: any
      try { obj = JSON.parse(line) } catch {
        const m = line.match(/\{.*\}\s*$/)
        if (!m) continue
        try { obj = JSON.parse(m[0]) } catch { continue }
      }
      if (!obj || typeof obj !== 'object') continue
      // Tag inferred source so classifySource can use it
      ;(obj as any).__source = 'opencode-stats'
      out.push(obj)
    }
  } catch {}

  // Source 2: claude-max-proxy.log REAL_REQUEST_COMPLETE → native CC traffic
  // Lines look like: `<ANSI?>17:42:25.142<ANSI?> INFO <ANSI?>REAL_REQUEST_COMPLETE<ANSI?> sessionId=<uuid> model=<m> durationMs=<n> usage={...} rateLimit={...}`
  const proxyLogPath = join(homedir(), '.claude-local', 'claude-max-proxy.log')
  try {
    const raw = readFileSync(proxyLogPath, 'utf-8')
    // Strip ANSI codes for simpler regex
    const stripped = raw.replace(/\[\d+m/g, '')
    const re = /(\d{2}:\d{2}:\d{2}\.\d+)\s+INFO\s+REAL_REQUEST_COMPLETE\s+sessionId=([0-9a-f-]+)\s+model=(\S+)\s+durationMs=(\d+)\s+usage=(\{[^}]+\})\s+rateLimit=(\{[^}]+\})/g
    // We don't have the date in the line — proxy log timestamps are time-of-day only.
    // Estimate date from file mtime; for current-day traffic this is accurate enough.
    let baseDate = ''
    try {
      const st = require('node:fs').statSync(proxyLogPath)
      baseDate = new Date(st.mtimeMs).toISOString().slice(0, 10)
    } catch {
      baseDate = new Date().toISOString().slice(0, 10)
    }
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped)) !== null) {
      const [, time, sessionId, model, dur, usageJson, rateLimitJson] = m
      let usage: any, rl: any
      try { usage = JSON.parse(usageJson) } catch { continue }
      try { rl = JSON.parse(rateLimitJson) } catch { continue }
      out.push({
        ts: `${baseDate}T${time}Z`,
        type: 'stream',
        model,
        ses: sessionId,
        dur: Number(dur),
        usage: {
          in: usage.inputTokens,
          out: usage.outputTokens,
          cacheRead: usage.cacheReadInputTokens,
          cacheWrite: usage.cacheCreationInputTokens,
        },
        rateLimit: {
          status: rl.status,
          util5h: rl.util5h,
          util7d: rl.util7d,
        },
        // tag for classifySource
        ...({ __source: 'native-proxy-log' } as any),
      } as any)
    }
  } catch {}

  return out
}

function parseSinceArg(arg: string | undefined): number | null {
  if (!arg) return null
  const m = arg.match(/^(\d+)\s*(s|m|h|d)?$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 'h').toLowerCase()
  const ms = unit === 's' ? n * 1e3 : unit === 'm' ? n * 60e3 : unit === 'h' ? n * 3600e3 : n * 86400e3
  return Date.now() - ms
}

function aggregate(entries: StatEntry[], modelFilter?: string, sessionFilter?: string): SessionAgg[] {
  const map = new Map<string, SessionAgg>()
  for (const e of entries) {
    if (!e.usage || !e.rateLimit) continue
    if (modelFilter && !e.model?.includes(modelFilter)) continue
    if (e.type === 'context_inject') continue  // not a real turn

    const pid = e.pid ?? 0
    const ses = e.ses ?? '?'
    const key = `${pid}:${ses}`
    if (sessionFilter && !ses.includes(sessionFilter)) continue

    const ts = new Date(e.ts).getTime()
    const util = e.rateLimit.util5h ?? 0

    let agg = map.get(key)
    if (!agg) {
      agg = {
        key, pid, ses, model: e.model ?? '?',
        source: classifySource(e),
        turns: 0,
        firstTs: ts, lastTs: ts,
        durTotalMs: 0,
        in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cacheWrite5m: 0, cacheWrite1h: 0,
        firstUtil5h: util, lastUtil5h: util,
        maxUtil5h: util, minUtil5h: util,
      }
      map.set(key, agg)
    }
    agg.turns++
    agg.lastTs = ts
    agg.durTotalMs += e.dur ?? 0
    agg.in += e.usage.in ?? 0
    agg.out += e.usage.out ?? 0
    agg.cacheRead += e.usage.cacheRead ?? 0
    agg.cacheWrite += e.usage.cacheWrite ?? 0
    agg.cacheWrite5m += e.usage.cacheWrite5m ?? 0
    agg.cacheWrite1h += e.usage.cacheWrite1h ?? 0
    agg.lastUtil5h = util
    agg.maxUtil5h = Math.max(agg.maxUtil5h, util)
    agg.minUtil5h = Math.min(agg.minUtil5h, util)
  }
  return Array.from(map.values()).sort((a, b) => b.lastTs - a.lastTs)
}

function fmtNum(n: number, w = 8): string {
  return String(n).padStart(w)
}
function fmtPct(p: number, w = 6): string {
  return (p * 100).toFixed(2).padStart(w - 1) + '%'
}

function row(s: SessionAgg): string {
  const dur = (s.lastTs - s.firstTs) / 1000
  const dUtil5h = s.maxUtil5h - s.minUtil5h
  // efficiency: util5h spent per 1k output tokens
  const perKOut = s.out > 0 ? (dUtil5h / (s.out / 1000)) : NaN
  // cache leverage: how many cache_read tokens per cache_write token (higher = better caching)
  const cacheLeverage = s.cacheWrite > 0 ? s.cacheRead / s.cacheWrite : NaN
  return [
    s.source.padEnd(8),
    `pid=${String(s.pid).padStart(7)}`,
    s.ses.slice(0, 12).padEnd(13),
    s.model.slice(0, 22).padEnd(22),
    `t=${fmtNum(s.turns, 4)}`,
    `out=${fmtNum(s.out, 7)}`,
    `read=${fmtNum(s.cacheRead, 9)}`,
    `write=${fmtNum(s.cacheWrite, 8)}`,
    `Δutil5h=${fmtPct(dUtil5h, 7)}`,
    `quota/1k-out=${isFinite(perKOut) ? (perKOut * 100).toFixed(4) + '%' : '   n/a'}`,
    `read-leverage=${isFinite(cacheLeverage) ? cacheLeverage.toFixed(1) + 'x' : ' n/a'}`,
    `dur=${(dur / 60).toFixed(1)}m`,
  ].join('  ')
}

function median(arr: number[]): number {
  if (arr.length === 0) return NaN
  const a = [...arr].sort((x, y) => x - y)
  const m = Math.floor(a.length / 2)
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

// ─── CLI ─────────────────────────────────────────────────────
const args = process.argv.slice(2)
const since = args.find(a => a.startsWith('--since='))?.split('=')[1]
  ?? (args.includes('--since') ? args[args.indexOf('--since') + 1] : null)
const modelFilter = args.find(a => a.startsWith('--model='))?.split('=')[1]
  ?? (args.includes('--model') ? args[args.indexOf('--model') + 1] : null)
const sessionFilter = args.find(a => a.startsWith('--session='))?.split('=')[1]
  ?? (args.includes('--session') ? args[args.indexOf('--session') + 1] : null)

const sinceMs = parseSinceArg(since ?? undefined) ?? (Date.now() - 24 * 3600e3)

const all = load()
const recent = all.filter(e => {
  if (!e.ts) return false
  const t = new Date(e.ts).getTime()
  return t >= sinceMs
})
const agg = aggregate(recent, modelFilter ?? undefined, sessionFilter ?? undefined)

console.log(`Stats file: ${STATS_PATH}`)
console.log(`Total entries: ${all.length}, after time filter: ${recent.length}, sessions found: ${agg.length}`)
if (modelFilter) console.log(`Filtered by model: ${modelFilter}`)
console.log(`Time window: since ${new Date(sinceMs).toISOString()}\n`)

if (agg.length === 0) {
  console.log('(no sessions matched)')
  process.exit(0)
}

console.log('── per-session efficiency ────────────────────────────────────────────────────────────')
for (const s of agg) console.log(row(s))

// Compare native vs opencode within same model
console.log('\n── native vs opencode comparison (median quota_per_1k_out, lower = more efficient) ──')
const byModel = new Map<string, { native: number[]; opencode: number[] }>()
for (const s of agg) {
  if (s.out <= 0) continue
  const dUtil = s.maxUtil5h - s.minUtil5h
  if (dUtil <= 0) continue
  const eff = dUtil / (s.out / 1000)
  if (!isFinite(eff)) continue
  if (!byModel.has(s.model)) byModel.set(s.model, { native: [], opencode: [] })
  const slot = byModel.get(s.model)!
  if (s.source === 'native') slot.native.push(eff)
  else if (s.source === 'opencode') slot.opencode.push(eff)
}
for (const [model, { native, opencode }] of byModel) {
  const mN = median(native)
  const mO = median(opencode)
  const ratio = isFinite(mN) && isFinite(mO) && mO > 0 ? (mN / mO).toFixed(2) : 'n/a'
  console.log(`  ${model.padEnd(28)} native_n=${String(native.length).padStart(3)} median=${isFinite(mN) ? (mN * 100).toFixed(4) + '%' : '  n/a  '}   | opencode_n=${String(opencode.length).padStart(3)} median=${isFinite(mO) ? (mO * 100).toFixed(4) + '%' : '  n/a  '}   | ratio_n/o=${ratio}`)
}
