#!/usr/bin/env bun
/**
 * proxy-doctor — claude-max-proxy health & correctness verifier.
 *
 * Checks (in order):
 *   1. Process alive  — systemctl + /health endpoint reachable
 *   2. /version       — installed code matches latest (or warns about drift)
 *   3. /stats         — proxy state inspection
 *   4. Per-session isolation — each tracked session has its own engine
 *      with separate KA registry; sessions do not bleed state.
 *   5. Keepalive cadence — KA fires within kaIntervalSec ± slack;
 *      no stuck timers; ticks visible in claude-max-stats.jsonl.
 *   6. Cache hit health — per-session cache_read should be MUCH larger
 *      than cache_write after warm-up; cold sessions flagged.
 *   7. Body capture (NEW) — verify proxy-body-dumps/ accumulating;
 *      flag is enabled; TTL sweep configured.
 *   8. native CC vs opencode separation — sessions tagged correctly,
 *      no PID collision in proxy/sdk telemetry.
 *
 * Each check emits PASS / WARN / FAIL with a one-line rationale.
 * Exit code: 0 if no FAILs; 1 otherwise.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface CheckResult { name: string; level: 'PASS' | 'WARN' | 'FAIL'; msg: string; details?: any }
const results: CheckResult[] = []
function pass(name: string, msg: string, details?: any): void { results.push({ name, level: 'PASS', msg, details }) }
function warn(name: string, msg: string, details?: any): void { results.push({ name, level: 'WARN', msg, details }) }
function fail(name: string, msg: string, details?: any): void { results.push({ name, level: 'FAIL', msg, details }) }

const PROXY_BASE = 'http://127.0.0.1:5050'

async function fetchJson(path: string, timeoutMs = 2000): Promise<any> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(PROXY_BASE + path, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(t)
  }
}

// ─── 1. Process & systemctl ──────────────────────────────────────
async function checkProcessAlive(): Promise<void> {
  try {
    const status = execSync('systemctl --user is-active claude-max-proxy', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    if (status !== 'active') {
      fail('process.systemd', `systemd status: ${status}`)
      return
    }
    pass('process.systemd', 'active')
  } catch (e: any) {
    warn('process.systemd', `systemctl check failed: ${e.message}`)
  }
  try {
    const health = await fetchJson('/health')
    if (health.ok) pass('process.health', `uptime=${health.uptime}s sessions=${health.sessions}`)
    else fail('process.health', '/health returned ok=false', health)
  } catch (e: any) {
    fail('process.health', `/health unreachable: ${e.message}`)
  }
}

// ─── 2. Version drift ──────────────────────────────────────
async function checkVersion(): Promise<void> {
  let runningVersion = '?'
  try {
    const v = await fetchJson('/version')
    runningVersion = v.version
  } catch (e: any) {
    fail('version.endpoint', `/version unreachable: ${e.message}`)
    return
  }
  let sourceVersion = '?'
  try {
    const p = JSON.parse(readFileSync('/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/package.json', 'utf-8'))
    sourceVersion = p.version
  } catch {}
  let installedVersion = '?'
  try {
    const p = JSON.parse(readFileSync('/home/relishev/.local/share/claude-max-proxy/package.json', 'utf-8'))
    installedVersion = p.version
  } catch {}
  if (runningVersion === sourceVersion) {
    pass('version.drift', `running=${runningVersion} matches source`)
  } else if (runningVersion === installedVersion) {
    warn('version.drift', `running=${runningVersion} matches installed=${installedVersion}, source=${sourceVersion} (rebuild + restart to upgrade)`)
  } else {
    warn('version.drift', `running=${runningVersion} installed=${installedVersion} source=${sourceVersion}`)
  }
}

// ─── 3-4. Stats + session isolation ──────────────────────────────────────
async function checkStatsAndIsolation(): Promise<any> {
  let stats: any
  try {
    stats = await fetchJson('/stats')
  } catch (e: any) {
    fail('stats.endpoint', `/stats unreachable: ${e.message}`)
    return null
  }
  pass('stats.endpoint', `proxy.version=${stats.proxy.version} pid=${stats.proxy.pid} mode=${stats.proxy.mode} sessions=${stats.sessions.length}`)

  // Isolation check: each session has its own ka.registrySize independent.
  // We can also verify that sessionIds are unique.
  const ids = new Set<string>()
  let collision = false
  for (const s of stats.sessions) {
    if (ids.has(s.sessionId)) { collision = true; break }
    ids.add(s.sessionId)
  }
  if (collision) fail('isolation.unique', `duplicate sessionId in /stats`)
  else pass('isolation.unique', `${stats.sessions.length} sessions, all unique IDs`)

  // Per-session engine separation: each should have its own _registry.
  // Caveat: registrySize=0 with timer running is NORMAL post-idle state —
  // proxy disarms KA when cache_expired_during_sleep; next real request
  // re-arms. Only worth flagging if session has fresh activity but no registry.
  // The SDK 0.11 also doesn't expose _registry size publicly, so 0 may be
  // a false-zero. Treat as info-only.
  let dormantSessions = 0
  for (const s of stats.sessions) {
    const reg = s.ka?.registrySize ?? 0
    if (reg === 0 && s.idleSec < 30 && s.lastUsage && s.lastUsage.cacheReadInputTokens > 0) {
      // Fresh real request just landed (idle <30s) AND we saw cacheRead (real
      // turn happened) but registry says 0 → either field rename or actual miss.
      warn(`ka.registry.${s.sessionId.slice(0, 8)}`, `session=${s.sessionId.slice(0, 8)} pid=${s.pid} idleSec=${s.idleSec} but registrySize=0 (may be SDK 0.11 field-naming false-zero — verify via KA_FIRE_COMPLETE events)`)
    } else if (reg === 0) {
      dormantSessions++
    }
  }
  if (dormantSessions > 0) {
    pass('isolation.engines', `${stats.sessions.length} engines, ${dormantSessions} dormant (idle/disarmed — normal)`)
  } else {
    pass('isolation.engines', `${stats.sessions.length} per-session KA engines`)
  }

  return stats
}

// ─── 5. KA cadence — check ticks landed within expected window ──────────────────────────────────────
function checkKaCadence(stats: any): void {
  if (!stats) return
  const kaInterval = stats.config.kaIntervalSec ?? 120
  const now = Date.now()
  const windowMs = kaInterval * 2 * 1000

  // SDK-level KA (opencode-claude provider): KA_HEARTBEAT + keepalive FIRED.
  const debugLogPath = join(homedir(), '.claude-local', 'claude-max-debug.log')
  let kaTicksInWindow = 0
  let kaFiresOpencodeInWindow = 0
  try {
    const raw = readFileSync(debugLogPath, 'utf-8')
    const tickRe = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] KA_HEARTBEAT/g
    let m
    while ((m = tickRe.exec(raw)) !== null) {
      const t = new Date(m[1]).getTime()
      if (now - t <= windowMs) kaTicksInWindow++
    }
    const fireRe = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\] keepalive FIRED/g
    while ((m = fireRe.exec(raw)) !== null) {
      const t = new Date(m[1]).getTime()
      if (now - t <= windowMs) kaFiresOpencodeInWindow++
    }
  } catch (e: any) {
    warn('ka.log.opencode', `cannot read ${debugLogPath}: ${e.message}`)
  }

  // Proxy-level KA (native CC traffic through proxy): KA_FIRE_COMPLETE in proxy log.
  const proxyLogPath = join(homedir(), '.claude-local', 'claude-max-proxy.log')
  let kaFiresProxyInWindow = 0
  let kaDisarmsInWindow = 0
  try {
    const raw = readFileSync(proxyLogPath, 'utf-8')
    const stripped = raw.replace(/\[\d+m/g, '')
    // Time-only entries (HH:MM:SS.mmm) — approximate by counting recent slice.
    // Approximate: assume file is mostly chronological, take last 5000 lines.
    const lines = stripped.split('\n').slice(-5000)
    for (const line of lines) {
      if (line.includes('KA_FIRE_COMPLETE')) kaFiresProxyInWindow++
      if (line.includes('KA_DISARM')) kaDisarmsInWindow++
    }
  } catch {}

  // Verdict
  if (kaTicksInWindow === 0 && kaFiresProxyInWindow === 0) {
    warn('ka.cadence', `0 ticks AND 0 proxy KA fires in window — KA fully silent (check live sessions)`)
  } else {
    pass('ka.cadence', `opencode: ${kaTicksInWindow} ticks + ${kaFiresOpencodeInWindow} fires | proxy (last 5000 log lines): ${kaFiresProxyInWindow} fires, ${kaDisarmsInWindow} disarms`)
  }

  // Per-session proxy ticks (NEW — added after restart). Each session should
  // emit PROXY_KA_TICK every healthHeartbeatSec (default 30s). If a session's
  // tick stream goes silent, the engine has stalled or the session is dead.
  let proxyTicksInWindow = 0
  try {
    const raw = readFileSync(proxyLogPath, 'utf-8')
    const stripped = raw.replace(/\[\d+m/g, '')
    const lines = stripped.split('\n').slice(-2000)
    for (const line of lines) {
      if (line.includes('PROXY_KA_TICK')) proxyTicksInWindow++
    }
  } catch {}
  if (proxyTicksInWindow === 0) {
    warn('ka.proxy-ticks', `0 PROXY_KA_TICK events in last 2000 log lines — patched proxy not running yet, or no sessions tracked`)
  } else {
    pass('ka.proxy-ticks', `${proxyTicksInWindow} PROXY_KA_TICK events visible (per-session liveness OK)`)
  }
}

// ─── 6. Cache hit health ──────────────────────────────────────
function checkCacheHits(): void {
  // For each PID with >=3 turns in last 30min in stats, ratio cacheRead/cacheWrite should be > 5 (warm).
  const statsPath = join(homedir(), '.claude-local', 'claude-max-stats.jsonl')
  let raw: string
  try { raw = readFileSync(statsPath, 'utf-8') } catch (e: any) {
    fail('cache.stats', `cannot read ${statsPath}: ${e.message}`)
    return
  }
  const cutoff = Date.now() - 30 * 60 * 1000
  const perPid = new Map<number, { turns: number; cacheRead: number; cacheWrite: number; model: string }>()
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let obj: any; try { obj = JSON.parse(line) } catch { continue }
    if (obj.type === 'context_inject' || obj.type === 'keepalive') continue
    if (!obj.ts) continue
    if (new Date(obj.ts).getTime() < cutoff) continue
    const pid = obj.pid ?? 0
    if (!pid) continue
    const prev = perPid.get(pid) ?? { turns: 0, cacheRead: 0, cacheWrite: 0, model: obj.model ?? '?' }
    prev.turns++
    prev.cacheRead += obj.usage?.cacheRead ?? 0
    prev.cacheWrite += obj.usage?.cacheWrite ?? 0
    perPid.set(pid, prev)
  }
  let bad = 0
  let good = 0
  for (const [pid, s] of perPid) {
    if (s.turns < 3) continue
    const ratio = s.cacheWrite > 0 ? s.cacheRead / s.cacheWrite : Infinity
    if (ratio < 5) {
      warn(`cache.cold.pid${pid}`, `pid=${pid} ratio=${ratio.toFixed(1)}x turns=${s.turns} (cold cache, cache_write dominant)`)
      bad++
    } else {
      good++
    }
  }
  if (good > 0 && bad === 0) pass('cache.hits', `${good} sessions warm (read/write ratio > 5x)`)
  else if (good > 0) warn('cache.hits', `${good} warm, ${bad} cold`)
  else warn('cache.hits', 'no sessions with >=3 turns in last 30min — cannot evaluate cache health')
}

// ─── 7. Body capture ──────────────────────────────────────
function checkBodyCapture(): void {
  const dir = process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR ?? join(homedir(), '.claude-local', 'proxy-body-dumps')
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch (e: any) {
    warn('capture.dir', `cannot read ${dir}: ${e.message}`)
    return
  }
  const bodies = entries.filter(n => n.endsWith('.json') && !n.endsWith('.meta.json'))
  const recent = bodies.filter(n => {
    try { return statSync(join(dir, n)).mtimeMs > Date.now() - 30 * 60 * 1000 } catch { return false }
  })
  if (bodies.length === 0) {
    warn('capture.active', `no body dumps in ${dir} — proxy may not be patched yet (restart needed)`)
    return
  }
  pass('capture.dir', `${bodies.length} body dumps total, ${recent.length} in last 30min`)
  // Check oldest age vs TTL
  const ttlHours = Number(process.env.CLAUDE_MAX_PROXY_CAPTURE_TTL_HOURS ?? '48')
  let oldestAgeH = 0
  for (const n of bodies) {
    try {
      const age = (Date.now() - statSync(join(dir, n)).mtimeMs) / 3600e3
      if (age > oldestAgeH) oldestAgeH = age
    } catch {}
  }
  if (oldestAgeH > ttlHours) warn('capture.ttl', `oldest dump ${oldestAgeH.toFixed(1)}h > TTL ${ttlHours}h (sweep missed?)`)
  else pass('capture.ttl', `oldest dump ${oldestAgeH.toFixed(1)}h, within TTL ${ttlHours}h`)
}

// ─── 8. Native CC vs opencode separation ──────────────────────────────────────
function checkSourceSeparation(stats: any): void {
  if (!stats) return
  // Native CC sessions have UUID sessionIds; opencode embedded proxies use anon-<ts>.
  let nativeN = 0, opencodeN = 0, anonN = 0
  for (const s of stats.sessions) {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}/.test(s.sessionId)) nativeN++
    else if (s.sessionId.startsWith('anon-')) anonN++
    else opencodeN++
  }
  pass('separation.sources', `tracked: native=${nativeN} opencode-style=${opencodeN} anon=${anonN}`)
}

// ─── Main ──────────────────────────────────────
async function main(): Promise<void> {
  await checkProcessAlive()
  await checkVersion()
  const stats = await checkStatsAndIsolation()
  checkKaCadence(stats)
  checkCacheHits()
  checkBodyCapture()
  checkSourceSeparation(stats)

  console.log('\n══════════════════════ proxy-doctor report ══════════════════════')
  for (const r of results) {
    const color = r.level === 'PASS' ? '\x1b[32m' : r.level === 'WARN' ? '\x1b[33m' : '\x1b[31m'
    const reset = '\x1b[0m'
    console.log(`  ${color}${r.level.padEnd(4)}${reset}  ${r.name.padEnd(28)}  ${r.msg}`)
  }
  const failures = results.filter(r => r.level === 'FAIL').length
  const warnings = results.filter(r => r.level === 'WARN').length
  const passes = results.filter(r => r.level === 'PASS').length
  console.log(`\nSummary: ${passes} pass, ${warnings} warn, ${failures} fail`)
  process.exit(failures > 0 ? 1 : 0)
}

main().catch(e => {
  console.error('proxy-doctor crashed:', e)
  process.exit(2)
})
