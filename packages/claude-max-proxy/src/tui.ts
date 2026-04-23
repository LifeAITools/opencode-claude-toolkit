#!/usr/bin/env bun
/**
 * claude-max watch — live TUI dashboard.
 *
 * Polls http://127.0.0.1:PORT/stats every 1s, also tails
 * ~/.claude/claude-max-proxy.log for event stream.
 *
 * Layout:
 *   ┌─ Header (proxy info) ──────────────────┐
 *   ├─ Sessions table ───────────┬─ Quota ───┤
 *   │                            ├─ Token ───┤
 *   │                            ├─ KA stats ┤
 *   ├─ Event log (tailed) ───────────────────┤
 *   └─ Footer (keys) ────────────────────────┘
 */

import blessed from 'blessed'
import { loadConfig } from './config.js'
import { readDiscoveryState } from './discovery.js'
import { spawn } from 'bun'

const cfg = loadConfig()

// Read current endpoint from discovery file; fall back to config defaults.
function currentProxyUrl(): string {
  const d = readDiscoveryState()
  if (d) return d.endpoint
  return `http://${cfg.proxyHost}:${cfg.proxyPort}`
}

// Initial URL — but we also re-resolve on each poll, in case proxy restarts on a different port.
let PROXY_URL = currentProxyUrl()

// ─── Helpers ──────────────────────────────────────────────────

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return `${h}h ${m}m`
}

function progressBar(pct: number | null, width = 20, color = 'cyan'): string {
  if (pct == null) return '{gray-fg}' + '░'.repeat(width) + '{/}  ?'
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)))
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const c = pct > 0.8 ? 'red' : pct > 0.5 ? 'yellow' : color
  return `{${c}-fg}${bar}{/} ${(pct * 100).toFixed(1).padStart(5)}%`
}

function timeUntil(epochSec: number): string {
  const sec = Math.max(0, epochSec - Math.floor(Date.now() / 1000))
  return formatDuration(sec)
}

// ─── Screen setup ─────────────────────────────────────────────

const screen = blessed.screen({
  smartCSR: true,
  title: 'claude-max-proxy watch',
  fullUnicode: true,
})

const header = blessed.box({
  top: 0, left: 0, right: 0, height: 3,
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' } },
  content: '{center}{bold}claude-max-proxy{/bold}  loading...{/center}',
})

const sessionsBox = blessed.box({
  top: 3, left: 0, width: '60%', bottom: 12,
  label: ' Sessions ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan' } },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
})

const quotaBox = blessed.box({
  top: 3, left: '60%', right: 0, height: 6,
  label: ' Quota ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta' } },
})

const tokenBox = blessed.box({
  top: 9, left: '60%', right: 0, height: 5,
  label: ' Token Health ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow' } },
})

const kaBox = blessed.box({
  top: 14, left: '60%', right: 0, bottom: 12,
  label: ' KA Activity ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green' } },
})

const eventLog = blessed.log({
  bottom: 3, left: 0, right: 0, height: 9,
  label: ' Event Log (tail) ',
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'white' }, label: { fg: 'white' } },
  scrollable: true,
  alwaysScroll: true,
  scrollOnInput: false,
  mouse: true,
  keys: true,
  vi: true,
})

const footer = blessed.box({
  bottom: 0, left: 0, right: 0, height: 3,
  tags: true,
  border: { type: 'line' },
  style: { border: { fg: 'gray' } },
  content: '{center}[q]uit  [r]efresh  [c]lear log  [PgUp/PgDn] scroll log  [L]evel  {/center}',
})

screen.append(header)
screen.append(sessionsBox)
screen.append(quotaBox)
screen.append(tokenBox)
screen.append(kaBox)
screen.append(eventLog)
screen.append(footer)

screen.key(['q', 'C-c'], () => { cleanup(); process.exit(0) })
screen.key(['r'], () => { poll() })
screen.key(['c'], () => { eventLog.setContent(''); screen.render() })

// ─── Stats polling ─────────────────────────────────────────────

interface StatsResponse {
  proxy: { version: string; pid: number; uptime: number; port: number }
  sessions: Array<{
    sessionId: string
    pid: number | null
    firstSeenAt: string
    lastRequestAt: string
    idleSec: number
    model: string | null
    lastUsage: any
    ka: { registrySize: number; timerRunning: boolean }
  }>
  rateLimit: {
    status: string | null
    resetAt: number | null
    claim: string | null
    utilization5h: number | null
    utilization7d: number | null
  }
  config: any
}

// Track rolling KA fire history (from event log tail)
const fireCounts = { lastHour: 0, lastMinute: 0 }
const fireHistory: Array<{ ts: number; cacheRead: number; cacheWrite: number }> = []

async function poll(): Promise<void> {
  // Re-resolve proxy URL from discovery file each poll — if proxy restarts on
  // a different port (e.g. original port was occupied), we pick up the new one.
  PROXY_URL = currentProxyUrl()

  let stats: StatsResponse
  try {
    const r = await fetch(`${PROXY_URL}/stats`, { signal: AbortSignal.timeout(2000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    stats = await r.json() as StatsResponse
  } catch (e: any) {
    header.setContent(`{center}{bold}claude-max-proxy{/bold}  {red-fg}PROXY UNREACHABLE{/} @ ${PROXY_URL} — ${e?.message ?? e}{/center}`)
    screen.render()
    return
  }

  // Prune fire history
  const hourAgo = Date.now() - 3600_000
  const minAgo = Date.now() - 60_000
  while (fireHistory.length && fireHistory[0].ts < hourAgo) fireHistory.shift()
  fireCounts.lastHour = fireHistory.length
  fireCounts.lastMinute = fireHistory.filter(f => f.ts > minAgo).length

  // Header
  header.setContent(
    `{center}{bold}claude-max-proxy{/bold}  v${stats.proxy.version}  ` +
    `pid=${stats.proxy.pid}  ` +
    `port=${stats.proxy.port}  ` +
    `uptime={cyan-fg}${formatDuration(stats.proxy.uptime)}{/}{/center}`
  )

  // Sessions
  if (stats.sessions.length === 0) {
    sessionsBox.setContent('\n  {gray-fg}No sessions yet.{/}\n  {gray-fg}Launch Claude Code through the proxy to see activity.{/}')
  } else {
    let out = '\n'
    out += '  {bold}SESSION       PID     IDLE    MODEL                       KA   CACHE_READ{/}\n'
    out += '  ──────────────────────────────────────────────────────────────────────────\n'
    for (const s of stats.sessions) {
      const sid = s.sessionId.slice(0, 12).padEnd(12)
      const pid = (s.pid ? String(s.pid) : '?').padEnd(6)
      const idle = formatDuration(s.idleSec).padEnd(6)
      const model = (s.model ?? '?').padEnd(28)
      const ka = s.ka.timerRunning ? '{green-fg}🟢{/}' : '{red-fg}⚫{/}'
      const cr = s.lastUsage?.cacheReadInputTokens ?? 0
      const cw = s.lastUsage?.cacheCreationInputTokens ?? 0
      const cacheIcon = cr > 0 && cw === 0 ? '{green-fg}✓{/}' : cw > 0 ? '{yellow-fg}W{/}' : ' '
      out += `  ${sid}  ${pid}  ${idle}  ${model}  ${ka}   ${cacheIcon} R:${cr} W:${cw}\n`
    }
    sessionsBox.setContent(out)
  }

  // Quota
  const q = stats.rateLimit
  const status5h = q.status === 'allowed' ? '{green-fg}allowed{/}' :
                    q.status === 'near_limit' ? '{yellow-fg}near_limit{/}' :
                    q.status ? `{red-fg}${q.status}{/}` : '{gray-fg}?{/}'
  const reset5h = q.resetAt ? timeUntil(q.resetAt) : '?'
  quotaBox.setContent(
    `\n  5h: ${progressBar(q.utilization5h, 28, 'cyan')}   reset in ${reset5h}\n` +
    `  7d: ${progressBar(q.utilization7d, 28, 'magenta')}\n\n` +
    `  status: ${status5h}    claim: ${q.claim ?? '?'}`
  )

  // Token (read from credentials file + compute countdown)
  let tokenLine = '  {gray-fg}?{/}'
  try {
    const { readFileSync } = await import('node:fs')
    const creds = JSON.parse(readFileSync(cfg.credentialsPath, 'utf8'))
    const expAt = creds?.claudeAiOauth?.expiresAt
    if (expAt) {
      const remaining = Math.max(0, expAt - Date.now())
      const pct = remaining / (11 * 3600_000)  // assume 11h lifetime
      const sec = Math.floor(remaining / 1000)
      const color = sec < 300 ? 'red' : sec < 1800 ? 'yellow' : 'green'
      tokenLine =
        `\n  lifetime: ${progressBar(Math.min(1, pct), 28, color)}\n` +
        `  expires in: {${color}-fg}${formatDuration(sec)}{/}  (${new Date(expAt).toISOString().slice(11, 19)} UTC)`
    }
  } catch {}
  tokenBox.setContent(tokenLine)

  // KA Activity
  const avgCacheRead = fireHistory.length > 0
    ? Math.round(fireHistory.reduce((a, b) => a + b.cacheRead, 0) / fireHistory.length)
    : 0
  const zeroWrites = fireHistory.filter(f => f.cacheWrite === 0).length
  const writeRatio = fireHistory.length > 0 ? (zeroWrites / fireHistory.length) : 0
  kaBox.setContent(
    `\n  fires last hour:   {green-fg}${fireCounts.lastHour}{/}\n` +
    `  fires last min:    {green-fg}${fireCounts.lastMinute}{/}\n` +
    `  avg cacheRead:     ${avgCacheRead.toLocaleString()} tokens\n` +
    `  zero cacheWrite:   ${zeroWrites}/${fireHistory.length}` +
    (writeRatio === 1 ? '  {green-fg}✓ PERFECT{/}' : fireHistory.length > 0 ? '  {yellow-fg}!{/}' : '')
  )

  screen.render()
}

// ─── Event log tailer ──────────────────────────────────────────

function startLogTail(): () => void {
  const proc = spawn({
    cmd: ['tail', '-F', '-n', '30', cfg.logFile],
    stdout: 'pipe',
    stderr: 'inherit',
    stdin: 'ignore',
  })

  ;(async () => {
    try {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          // Color heuristic based on tag
          let colored = line
          if (line.includes('KA_FIRE_COMPLETE')) colored = `{green-fg}${line}{/}`
          else if (line.includes('KA_DISARM') || line.includes('ERROR') || line.includes('NEEDS_RELOGIN')) colored = `{red-fg}${line}{/}`
          else if (line.includes('REAL_REQUEST')) colored = `{cyan-fg}${line}{/}`
          else if (line.includes('REWRITE_WARN') || line.includes('NETWORK_DEGRADED')) colored = `{yellow-fg}${line}{/}`
          else if (line.includes('SESSION_TRACKED') || line.includes('TOKEN_ROTATED')) colored = `{magenta-fg}${line}{/}`
          else if (line.includes('HEALTH_HEARTBEAT')) colored = `{gray-fg}${line}{/}`
          eventLog.log(colored)

          // Parse KA fires for rolling history
          if (line.includes('KA_FIRE_COMPLETE')) {
            const crM = line.match(/cacheReadInputTokens":(\d+)/)
            const cwM = line.match(/cacheCreationInputTokens":(\d+)/)
            fireHistory.push({
              ts: Date.now(),
              cacheRead: crM ? parseInt(crM[1]) : 0,
              cacheWrite: cwM ? parseInt(cwM[1]) : 0,
            })
          }
        }
        screen.render()
      }
    } catch {}
  })()

  return () => { try { proc.kill() } catch {} }
}

// ─── Main loop ────────────────────────────────────────────────

const stopTail = startLogTail()

const pollInterval = setInterval(poll, 1000)
poll()  // immediate

function cleanup(): void {
  clearInterval(pollInterval)
  stopTail()
  screen.destroy()
}

process.on('SIGINT', () => { cleanup(); process.exit(0) })
process.on('SIGTERM', () => { cleanup(); process.exit(0) })
