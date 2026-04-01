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

// ─── Start proxy ───────────────────────────────────────────

console.log(`\n🔌 Starting opencode-proxy on port ${port}...`)

const proxy = spawn({
  cmd: [BUN, 'run', serverPath],
  env: {
    ...process.env,
    PROXY_PORT: String(port),
  },
  stdout: 'pipe',
  stderr: 'pipe',
})

// Forward proxy logs with prefix
;(async () => {
  const reader = proxy.stdout.getReader()
  const dec = new TextDecoder()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    process.stdout.write(`\x1b[2m[proxy] ${dec.decode(value)}\x1b[0m`)
  }
})()

// ─── Wait for proxy ready ──────────────────────────────────

const proxyUrl = `http://localhost:${port}`
const ready = await waitForProxy(proxyUrl)

if (!ready) {
  console.error('❌ Proxy failed to start. Check bun is installed.')
  proxy.kill()
  process.exit(1)
}

console.log(`✅ Proxy ready at ${proxyUrl}/v1`)
console.log(`📋 Models: claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-5-20251001\n`)

// ─── Setup cleanup ─────────────────────────────────────────

function cleanup(exitCode = 0) {
  if (!proxy.killed) {
    process.stdout.write('\n🛑 Stopping proxy...\n')
    proxy.kill('SIGTERM')
  }
  process.exit(exitCode)
}

process.on('SIGINT', () => cleanup(0))
process.on('SIGTERM', () => cleanup(0))
process.on('exit', () => { if (!proxy.killed) proxy.kill() })

// ─── Launch opencode ───────────────────────────────────────

if (!opencodeCmd) {
  console.log(`⚠️  opencode not found in PATH.`)
  console.log(`   Set LOCAL_ENDPOINT=${proxyUrl}/v1 and run opencode manually.`)
  console.log(`   Proxy is running. Press Ctrl+C to stop.\n`)
  await proxy.exited
  cleanup(0)
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
  cleanup(exitCode)
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
  const candidates = [
    'opencode',                                          // PATH
    '/usr/local/bin/opencode',
    '/home/relishev/.local/bin/opencode',
    '/home/relishev/.npm-global/bin/opencode',
    // Dev: build from source
    join(dirname(import.meta.url.replace('file://', '')), '../../..', 'kiberos-code', 'opencode'),
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
