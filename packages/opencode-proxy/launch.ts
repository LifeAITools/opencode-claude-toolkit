#!/usr/bin/env bun
/**
 * opencode-claude launcher
 *
 * Starts the proxy, waits for it to be ready,
 * launches opencode with LOCAL_ENDPOINT set,
 * then cleanly stops proxy when opencode exits.
 *
 * Usage:
 *   bun launch.ts [opencode args...]
 *   bun launch.ts --port 4040 -- opencode --model claude-sonnet-4-6
 *
 * Install globally:
 *   bun install -g (from this directory)
 *   opencode-claude
 */

import { spawn } from 'bun'
import { existsSync } from 'fs'
import { join, dirname } from 'path'

// ─── Parse args ────────────────────────────────────────────

const args = process.argv.slice(2)

// --port N
const portIdx = args.indexOf('--port')
let port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 0
if (!port) port = await findFreePort(4040)

// --model M (default model to pre-select)
const modelIdx = args.indexOf('--model')
const defaultModel = modelIdx >= 0 ? args[modelIdx + 1] : undefined

// opencode binary (resolve from PATH or common locations)
const opencodeCmd = await resolveOpencode()

// remaining args passed to opencode (after --)
const separatorIdx = args.indexOf('--')
const opencodeArgs: string[] = separatorIdx >= 0 ? args.slice(separatorIdx + 1) : []
if (defaultModel) opencodeArgs.push('--model', `local.${defaultModel}`)

// ─── Server file path ──────────────────────────────────────

const thisDir = dirname(import.meta.url.replace('file://', ''))
const serverPath = join(thisDir, 'server.ts')

// Bun binary — use absolute path since spawn may not inherit PATH
const BUN = process.execPath  // path to the currently running bun

// ─── Check for existing proxy ──────────────────────────────

let proxyUrl = `http://localhost:${port}`

// Check if a proxy is already running on the target port
let proxyReady = false
try {
  const r = await fetch(`${proxyUrl}/health`, { signal: AbortSignal.timeout(1000) })
  if (r.ok) {
    const health = await r.json() as { status: string; pid?: number; activeStreams?: number }
    if (health.status === 'ok' || health.status === 'draining') {
      proxyReady = true
      console.log(`\n✅ Proxy running at ${proxyUrl}/v1 (pid=${health.pid}, streams=${health.activeStreams ?? 0})`)
    }
  }
} catch {
  // No existing proxy
}

if (!proxyReady) {
  // ─── Start proxy as detached daemon ────────────────────────

  console.log(`\n🔌 Starting opencode-proxy daemon on port ${port}...`)

  // Start detached — proxy lives independently of this launcher
  const proxyProc = spawn({
    cmd: [BUN, 'run', serverPath, '--port', String(port)],
    env: { ...process.env, PROXY_PORT: String(port) },
    stdout: 'ignore',
    stderr: 'ignore',
    // @ts-ignore — Bun supports detached option
    detached: true,
  })
  // Unref so this process can exit without waiting for the daemon
  proxyProc.unref?.()

  // ─── Wait for proxy ready ──────────────────────────────────

  const ready = await waitForProxy(proxyUrl)

  if (!ready) {
    console.error('❌ Proxy failed to start. Check bun is installed and ~/.claude/.credentials.json exists.')
    try { proxyProc.kill() } catch { /* ok */ }
    process.exit(1)
  }

  console.log(`✅ Proxy daemon started at ${proxyUrl}/v1 (pid=${proxyProc.pid})`)
}

console.log(`📋 Models: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001`)
console.log(`💡 Proxy runs as a daemon — it stays alive after opencode exits.`)
console.log(`   To stop: kill $(cat /tmp/opencode-proxy-${port}.pid)`)
console.log(`   To reload: bash safe-restart.sh\n`)

// ─── Launch opencode ───────────────────────────────────────

if (!opencodeCmd) {
  console.log(`⚠️  opencode not found in PATH.`)
  console.log(`   Set LOCAL_ENDPOINT=${proxyUrl}/v1 and run opencode manually.`)
  console.log(`   Proxy daemon is running in the background.\n`)
  process.exit(0)
} else {
  console.log(`🚀 Launching: ${opencodeCmd} ${opencodeArgs.join(' ')}\n`)

  const opencode = spawn({
    cmd: [opencodeCmd, ...opencodeArgs],
    env: {
      ...process.env,
      LOCAL_ENDPOINT: `${proxyUrl}/v1`,
    },
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await opencode.exited
  // Proxy daemon keeps running — just exit the launcher
  process.exit(exitCode)
}

// ─── Helpers ───────────────────────────────────────────────

async function waitForProxy(url: string, maxMs = 10_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return true
    } catch {
      // not ready yet
    }
    await Bun.sleep(200)
  }
  return false
}

async function findFreePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 20; port++) {
    try {
      const s = Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {}, open() {}, close() {}, error() {} } })
      s.stop()
      return port
    } catch {
      // port in use, try next
    }
  }
  return preferred
}

async function resolveOpencode(): Promise<string | null> {
  // Check common locations
  const home = process.env.HOME ?? '/home'
  const candidates = [
    'opencode',                                          // PATH
    '/usr/local/bin/opencode',
    join(home, '.local/bin/opencode'),
    join(home, '.npm-global/bin/opencode'),
    join(home, 'go/bin/opencode'),
  ]

  for (const cmd of candidates) {
    if (cmd === 'opencode') {
      // Check PATH
      const r = Bun.spawnSync({ cmd: ['/usr/bin/which', 'opencode'] })
      if (r.exitCode === 0) return r.stdout.toString().trim()
      continue
    }
    if (existsSync(cmd)) return cmd
  }
  return null
}
