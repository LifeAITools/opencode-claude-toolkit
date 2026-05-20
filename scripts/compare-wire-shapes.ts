#!/usr/bin/env bun
/**
 * compare-wire-shapes — byte/structural comparator between
 * (A) native Claude Code body dumps  → ~/.claude-local/proxy-body-dumps/
 * (B) opencode/our-SDK body dumps    → ~/.claude-local/body-dumps/
 *
 * Goal: surface every wire-format difference that could explain server-side
 * behavior divergence (e.g. SSE stalls). Focuses on cache_control shape,
 * scope field presence, beta lists, system block layout, and top-level
 * body fields (context_management / output_config / cache_edits).
 *
 * Output: human-readable diff per matched pair + a summary table.
 *
 * Usage:
 *   bun run compare-wire-shapes.ts                    # full report
 *   bun run compare-wire-shapes.ts --model opus-4-7   # filter by model
 *   bun run compare-wire-shapes.ts --since 30m        # last 30 minutes
 *   bun run compare-wire-shapes.ts --pair native-PID:opencode-PID
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const NATIVE_DIR = join(homedir(), '.claude-local', 'proxy-body-dumps')
const OPENCODE_DIR = join(homedir(), '.claude-local', 'body-dumps')

interface DumpSummary {
  source: 'native' | 'opencode'
  path: string
  mtimeMs: number
  pidOrPort: string
  turn: string
  ts: number
  model: string
  toolCount: number
  sysCount: number
  msgCount: number
  bytes: number
  thinking: any
  maxTokens?: number
  hasContextMgmt: boolean
  hasOutputConfig: boolean
  hasCacheEdits: boolean
  betas: string  // joined string for diff readability
  cacheControlsSystem: any[]   // per-block cache_control
  cacheControlsTools: number   // count
  cacheControlsMsgs: number    // count
  scopeFieldsPresent: number   // count of cache_control with scope:* (any)
  scopeGlobalCount: number
  scopeOrgCount: number
  bareCacheControlNoScope: number // cache_control without scope at all
}

function inferSourceFromFilename(name: string): 'native' | 'opencode' {
  return name.startsWith('proxy-') ? 'native' : 'opencode'
}

function parseDump(path: string, source: 'native' | 'opencode'): DumpSummary | null {
  let body: any
  try {
    body = JSON.parse(readFileSync(path, 'utf-8'))
  } catch { return null }
  if (!body || typeof body !== 'object') return null

  const name = path.split('/').pop() ?? ''
  // proxy-<port>-<turn>-<ts>.json  |  <pid>-<turn>-<ts>.json
  const parts = name.replace(/\.json$/, '').split('-')
  const pidOrPort = source === 'native' ? (parts[1] ?? '?') : (parts[0] ?? '?')
  const turn = source === 'native' ? (parts[2] ?? '?') : (parts[1] ?? '?')

  const sys = Array.isArray(body.system) ? body.system : []
  const tools = Array.isArray(body.tools) ? body.tools : []
  const msgs = Array.isArray(body.messages) ? body.messages : []

  const ccSystem = sys.map((b: any) => b?.cache_control ?? null)
  let scopeGlobal = 0
  let scopeOrg = 0
  let bareNoScope = 0
  let scopePresent = 0
  for (const cc of ccSystem) {
    if (!cc) continue
    if ('scope' in cc) {
      scopePresent++
      if (cc.scope === 'global') scopeGlobal++
      else if (cc.scope === 'org') scopeOrg++
    } else {
      bareNoScope++
    }
  }
  // Also count tool/msg cache_controls
  let toolsCC = 0
  for (const t of tools) if (t?.cache_control) toolsCC++
  let msgsCC = 0
  for (const m of msgs) {
    const content = Array.isArray(m?.content) ? m.content : []
    for (const c of content) if (c?.cache_control) msgsCC++
  }

  // betas come from metadata or sidecar — try to read sidecar for native
  let betas = ''
  if (source === 'native') {
    const metaPath = path.replace(/\.json$/, '.meta.json')
    try {
      const m = JSON.parse(readFileSync(metaPath, 'utf-8'))
      betas = m?.headers?.['anthropic-beta'] ?? ''
    } catch {}
  }

  let st
  try { st = statSync(path) } catch { return null }

  return {
    source,
    path,
    mtimeMs: st.mtimeMs,
    pidOrPort,
    turn,
    ts: Number(parts[parts.length - 1]) || st.mtimeMs,
    model: body.model ?? '?',
    toolCount: tools.length,
    sysCount: sys.length,
    msgCount: msgs.length,
    bytes: st.size,
    thinking: body.thinking ?? null,
    maxTokens: body.max_tokens,
    hasContextMgmt: !!body.context_management,
    hasOutputConfig: !!body.output_config,
    hasCacheEdits: !!body.cache_edits || sys.some((b: any) => b?.type === 'cache_edits'),
    betas,
    cacheControlsSystem: ccSystem,
    cacheControlsTools: toolsCC,
    cacheControlsMsgs: msgsCC,
    scopeFieldsPresent: scopePresent,
    scopeGlobalCount: scopeGlobal,
    scopeOrgCount: scopeOrg,
    bareCacheControlNoScope: bareNoScope,
  }
}

function loadAll(): DumpSummary[] {
  const out: DumpSummary[] = []
  for (const [dir, src] of [[NATIVE_DIR, 'native' as const], [OPENCODE_DIR, 'opencode' as const]]) {
    let entries: string[] = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries) {
      if (!name.endsWith('.json') || name.endsWith('.meta.json')) continue
      const s = parseDump(join(dir, name), src)
      if (s) out.push(s)
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function parseSinceArg(arg: string | undefined): number | null {
  if (!arg) return null
  const m = arg.match(/^(\d+)\s*(s|m|h|d)?$/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = (m[2] ?? 's').toLowerCase()
  const ms = unit === 's' ? n * 1e3 : unit === 'm' ? n * 60e3 : unit === 'h' ? n * 3600e3 : n * 86400e3
  return Date.now() - ms
}

function summarize(d: DumpSummary): string {
  const t = d.thinking ? (d.thinking.type ?? JSON.stringify(d.thinking)) : 'none'
  return `${d.source.padEnd(8)} ${d.pidOrPort.padStart(8)} turn=${String(d.turn).padStart(4)} model=${d.model.padEnd(28)} bytes=${String(d.bytes).padStart(8)} tools=${String(d.toolCount).padStart(3)} sys=${d.sysCount} msgs=${String(d.msgCount).padStart(4)} thinking=${t.padEnd(10)} maxTok=${d.maxTokens ?? '?'}`
}

function formatCC(cc: any): string {
  if (!cc) return '∅'
  if ('scope' in cc) return `{${cc.type}, ttl:${cc.ttl ?? '5m-default'}, scope:${cc.scope}}`
  return `{${cc.type}, ttl:${cc.ttl ?? '5m-default'}}`
}

function diffPair(a: DumpSummary, b: DumpSummary): void {
  console.log('\n' + '═'.repeat(96))
  console.log(`PAIR  ${a.source} ${a.pidOrPort}/turn=${a.turn}  ⟷  ${b.source} ${b.pidOrPort}/turn=${b.turn}`)
  console.log('  ' + a.path)
  console.log('  ' + b.path)
  console.log('─'.repeat(96))
  console.log(`  model:           ${a.model.padEnd(35)} | ${b.model}`)
  console.log(`  bytes:           ${String(a.bytes).padEnd(35)} | ${b.bytes}`)
  console.log(`  tools:           ${String(a.toolCount).padEnd(35)} | ${b.toolCount}`)
  console.log(`  sys blocks:      ${String(a.sysCount).padEnd(35)} | ${b.sysCount}`)
  console.log(`  messages:        ${String(a.msgCount).padEnd(35)} | ${b.msgCount}`)
  console.log(`  thinking:        ${JSON.stringify(a.thinking).padEnd(35)} | ${JSON.stringify(b.thinking)}`)
  console.log(`  max_tokens:      ${String(a.maxTokens).padEnd(35)} | ${b.maxTokens}`)
  console.log(`  context_mgmt:    ${String(a.hasContextMgmt).padEnd(35)} | ${b.hasContextMgmt}`)
  console.log(`  output_config:   ${String(a.hasOutputConfig).padEnd(35)} | ${b.hasOutputConfig}`)
  console.log(`  cache_edits:     ${String(a.hasCacheEdits).padEnd(35)} | ${b.hasCacheEdits}`)
  console.log(`  scope=global:    ${String(a.scopeGlobalCount).padEnd(35)} | ${b.scopeGlobalCount}`)
  console.log(`  scope=org:       ${String(a.scopeOrgCount).padEnd(35)} | ${b.scopeOrgCount}`)
  console.log(`  cc without scope:${String(a.bareCacheControlNoScope).padEnd(35)} | ${b.bareCacheControlNoScope}`)
  console.log(`  cc on tools:     ${String(a.cacheControlsTools).padEnd(35)} | ${b.cacheControlsTools}`)
  console.log(`  cc on msgs:      ${String(a.cacheControlsMsgs).padEnd(35)} | ${b.cacheControlsMsgs}`)
  console.log(`  betas:           ${a.betas.slice(0, 80)}${a.betas.length > 80 ? '…' : ''}`)
  console.log(`                   ${b.betas.slice(0, 80)}${b.betas.length > 80 ? '…' : ''}  (opencode betas not in dumps)`)
  console.log(`  system cache_control layout:`)
  const maxBlocks = Math.max(a.cacheControlsSystem.length, b.cacheControlsSystem.length)
  for (let i = 0; i < maxBlocks; i++) {
    const ca = formatCC(a.cacheControlsSystem[i])
    const cb = formatCC(b.cacheControlsSystem[i])
    const mark = ca === cb ? '  ' : '⚡'
    console.log(`    block[${i}]: ${mark} ${ca.padEnd(50)} | ${cb}`)
  }
}

// ─── CLI ─────────────────────────────────────────────────────
const args = process.argv.slice(2)
const modelArg = args.find(a => a.startsWith('--model='))?.split('=')[1]
  ?? (args.includes('--model') ? args[args.indexOf('--model') + 1] : null)
const sinceArg = args.find(a => a.startsWith('--since='))?.split('=')[1]
  ?? (args.includes('--since') ? args[args.indexOf('--since') + 1] : null)
const sinceMs = parseSinceArg(sinceArg ?? undefined)
const pairArg = args.find(a => a.startsWith('--pair='))?.split('=')[1]
  ?? (args.includes('--pair') ? args[args.indexOf('--pair') + 1] : null)

const all = loadAll()
const filtered = all.filter(d => {
  if (modelArg && !d.model.includes(modelArg)) return false
  if (sinceMs && d.mtimeMs < sinceMs) return false
  return true
})

console.log(`Loaded ${all.length} dumps total; filtered to ${filtered.length}.`)
console.log(`  native (proxy-body-dumps):    ${filtered.filter(d => d.source === 'native').length}`)
console.log(`  opencode (body-dumps):        ${filtered.filter(d => d.source === 'opencode').length}`)

if (pairArg) {
  const [nativePid, opencodePid] = pairArg.split(':')
  const a = filtered.find(d => d.source === 'native' && d.pidOrPort === nativePid)
  const b = filtered.find(d => d.source === 'opencode' && d.pidOrPort === opencodePid)
  if (!a || !b) {
    console.error(`could not find pair: native=${nativePid} opencode=${opencodePid}`)
    process.exit(1)
  }
  diffPair(a, b)
  process.exit(0)
}

// Default: emit a brief catalog of recent dumps, then auto-pair best matches.
console.log('\n── recent dumps (most-recent first, capped 20) ──')
for (const d of filtered.slice(0, 20)) console.log('  ' + summarize(d))

// Auto-pairing: pick 1 native + 1 opencode of same model + thinking type + similar tool count
const natives = filtered.filter(d => d.source === 'native').slice(0, 50)
const opencodes = filtered.filter(d => d.source === 'opencode').slice(0, 50)
const pairs: Array<[DumpSummary, DumpSummary, number]> = []
for (const n of natives) {
  for (const o of opencodes) {
    if (n.model !== o.model) continue
    const thinkN = n.thinking?.type ?? 'none'
    const thinkO = o.thinking?.type ?? 'none'
    if (thinkN !== thinkO) continue
    // score by tool-count proximity + byte proximity
    const toolDiff = Math.abs(n.toolCount - o.toolCount)
    const byteDiff = Math.abs(n.bytes - o.bytes)
    const score = toolDiff * 10000 + byteDiff
    pairs.push([n, o, score])
  }
}
pairs.sort((a, b) => a[2] - b[2])

console.log('\n── top auto-paired matches (≤3 emitted) ──')
for (const [n, o] of pairs.slice(0, 3)) diffPair(n, o)
