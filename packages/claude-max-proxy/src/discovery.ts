/**
 * Service discovery via shared state file.
 *
 * File: ~/.claude/claude-max-proxy.json
 * Contents: { port, host, pid, startedAt, version, endpoint }
 *
 * ## Write path (proxy server startup)
 *   1. Try to read existing file.
 *   2. If it points to a healthy proxy → don't start, exit.
 *   3. Otherwise pick a free port (try preferred, then scan range).
 *   4. Bind port FIRST, then write state file (O_EXCL for race guard).
 *   5. Delete file on shutdown.
 *
 * ## Read path (claude-max wrapper, TUI, status)
 *   1. Read file → get port.
 *   2. If missing → proxy not running anywhere.
 *   3. If stale (pid dead OR /health broken) → treat as not running.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, openSync, closeSync } from 'fs'
import { dirname } from 'path'
import { join } from 'path'
import { homedir } from 'os'

export interface DiscoveryState {
  port: number
  host: string
  pid: number
  startedAt: string        // ISO timestamp
  version: string          // proxy version
  endpoint: string         // convenience: "http://host:port"
}

const STATE_FILE = join(homedir(), '.claude', 'claude-max-proxy.json')

// Port scan range — try preferred first, then walk the range.
const DEFAULT_PORT = parseInt(process.env.PROXY_PORT ?? '5050')
const PORT_SCAN_MIN = 5050
const PORT_SCAN_MAX = 5099

// ─── File operations ────────────────────────────────────────

export function getStateFilePath(): string { return STATE_FILE }

export function readDiscoveryState(): DiscoveryState | null {
  if (!existsSync(STATE_FILE)) return null
  try {
    const raw = readFileSync(STATE_FILE, 'utf8')
    const d = JSON.parse(raw) as DiscoveryState
    // Sanity: required fields present
    if (typeof d.port !== 'number' || typeof d.pid !== 'number') return null
    return d
  } catch {
    return null
  }
}

function writeDiscoveryStateAtomic(state: DiscoveryState): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true })
  // Write to temp + rename (atomic on POSIX)
  const tmp = STATE_FILE + '.tmp.' + process.pid
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n')
  const { renameSync } = require('fs') as typeof import('fs')
  renameSync(tmp, STATE_FILE)
}

export function clearDiscoveryState(): void {
  try { unlinkSync(STATE_FILE) } catch {}
}

// ─── Process + health checks ────────────────────────────────

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export async function probeHealth(host: string, port: number, timeoutMs = 800): Promise<{
  alive: boolean
  pid?: number
  uptime?: number
  sessions?: number
  version?: string
}> {
  try {
    const r = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return { alive: false }
    const stats = await r.json() as any
    return {
      alive: true,
      uptime: stats.uptime,
      sessions: stats.sessions,
    }
  } catch {
    return { alive: false }
  }
}

/** True iff state file points to a healthy live proxy. */
export async function isDiscoveredProxyHealthy(): Promise<{
  state: DiscoveryState | null
  healthy: boolean
  reason?: string
}> {
  const state = readDiscoveryState()
  if (!state) return { state: null, healthy: false, reason: 'no state file' }

  // Stale check 1: PID dead
  if (!processAlive(state.pid)) {
    return { state, healthy: false, reason: `pid ${state.pid} dead` }
  }

  // Stale check 2: /health probe
  const h = await probeHealth(state.host, state.port)
  if (!h.alive) {
    return { state, healthy: false, reason: `/health not responding on ${state.host}:${state.port}` }
  }

  return { state, healthy: true }
}

// ─── Port availability ───────────────────────────────────────

/**
 * Check if a TCP port is bindable by trying to bind it ephemerally.
 * Returns true if port is FREE (can bind), false if occupied.
 */
async function isPortFree(host: string, port: number): Promise<boolean> {
  try {
    const { createServer } = await import('node:net')
    return await new Promise<boolean>((resolve) => {
      const srv = createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => {
        srv.close(() => resolve(true))
      })
      srv.listen(port, host)
    })
  } catch {
    return false
  }
}

/**
 * Find a free port in a scan range, preferring `preferred` if free.
 *   - host: interface to bind test
 *   - preferred: try this port first
 *   - rangeMin, rangeMax: fallback scan range (inclusive)
 *
 * Defaults to global range 5050-5099 for backward compat; embedded mode
 * supplies 5100-5199 explicitly.
 *
 * Returns null if no port in range is bindable.
 */
export async function findFreePort(
  host: string,
  preferred: number = DEFAULT_PORT,
  rangeMin: number = PORT_SCAN_MIN,
  rangeMax: number = PORT_SCAN_MAX,
): Promise<number | null> {
  if (await isPortFree(host, preferred)) return preferred
  for (let p = rangeMin; p <= rangeMax; p++) {
    if (p === preferred) continue
    if (await isPortFree(host, p)) return p
  }
  return null
}

// ─── Publish current process as the discovered proxy ─────────

export function publishDiscoveryState(params: {
  port: number
  host: string
  version: string
}): DiscoveryState {
  const state: DiscoveryState = {
    port: params.port,
    host: params.host,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: params.version,
    endpoint: `http://${params.host}:${params.port}`,
  }
  writeDiscoveryStateAtomic(state)
  return state
}

/**
 * Startup gate: returns either
 *   - { shouldStart: false, existing } — healthy proxy already exists, bail out
 *   - { shouldStart: true, port } — we're clear to start on this port
 *
 * Uses a PID-prefixed tmp-file-write-then-rename to avoid 2 processes racing
 * to bind the same port: the one that binds first wins (via isPortFree),
 * the other scans for another free port.
 */
export async function acquireStartSlot(preferredHost: string, preferredPort: number): Promise<
  | { shouldStart: false; existing: DiscoveryState; reason: 'healthy' }
  | { shouldStart: true; port: number; host: string }
  | { shouldStart: false; reason: 'no_free_port' }
> {
  // Check for existing healthy proxy
  const { healthy, state } = await isDiscoveredProxyHealthy()
  if (healthy && state) {
    return { shouldStart: false, existing: state, reason: 'healthy' }
  }

  // Either no state file, or stale → clean it up, find port, go.
  // (Cleanup is safe: if actually alive but unresponsive, we won't rebind its
  // port anyway because isPortFree will see it as occupied.)
  if (state && !healthy) {
    clearDiscoveryState()
  }

  const port = await findFreePort(preferredHost, preferredPort)
  if (port === null) {
    return { shouldStart: false, reason: 'no_free_port' }
  }

  return { shouldStart: true, port, host: preferredHost }
}
