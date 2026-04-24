#!/usr/bin/env bun
/**
 * claude-max-proxy server — Bun HTTP with byte-level Anthropic passthrough.
 *
 * ──────────────────────────────────────────────────────────────
 *  TWO RUNTIME MODES
 * ──────────────────────────────────────────────────────────────
 *
 *  1. GLOBAL mode (default, systemd/launchd managed)
 *       • Singleton per host
 *       • Binds port 5050 (or scans 5050-5099)
 *       • Publishes discovery file (~/.claude/claude-max-proxy.json)
 *       • Refuses to start if another healthy global proxy exists
 *       • Serves ALL consumers: native claude CLI, opencode, Cursor, raw SDK
 *       • Dies only by explicit shutdown (systemctl stop, SIGTERM)
 *
 *  2. EMBEDDED mode (spawned as child by a consumer process)
 *       • Per-consumer instance (e.g. each opencode spawns its own)
 *       • Ignores discovery file, auto-picks free port (5100-5199 range)
 *       • Monitors PROXY_PARENT_PID env — self-terminates when parent dies
 *       • Does NOT write discovery file (wouldn't clash with global)
 *       • Prints {"mode":"embedded","port":N,"pid":M} to stdout on ready
 *
 *  ENV VARS controlling mode:
 *    PROXY_MODE=global|embedded  (default: global)
 *    PROXY_PARENT_PID=<pid>       (required in embedded; proxy dies when PID dies)
 *    PROXY_PORT=<port>            (preferred port; 0 = auto-pick)
 *
 * ──────────────────────────────────────────────────────────────
 *  Routes (same in both modes)
 * ──────────────────────────────────────────────────────────────
 *
 *   POST /v1/messages    — real request passthrough
 *   GET  /health         — quick health check
 *   GET  /stats          — full proxy state (JSON)
 *   GET  /admin/sessions — list all tracked sessions
 *   POST /admin/shutdown — graceful shutdown
 *
 *  Keepalive lifecycle (same in both modes, per X-Claude-Code-Session-Id):
 *   1. Real request arrives → snapshot rawBody+headers+usage
 *   2. engine.notifyRealRequestStart(...)
 *   3. Pipe SSE stream back to client byte-for-byte
 *   4. engine.notifyRealRequestComplete(usage) — starts KA timer
 *   5. Every ~120s: engine fires a KA replay with max_tokens=1
 *   6. On consumer PID death (global: per-session PID; embedded: parent PID):
 *      engine.stop() + in embedded mode, entire process exits.
 */

import { loadConfig } from './config.js'
import { emit, BusEventEmitterAdapter } from './event-bus.js'
import { startLogger } from './logger.js'
import { processAlive } from './session-tracker.js'
import { ProxyConfigCredentialsAdapter } from './upstream.js'
import { startHeartbeat } from './heartbeat.js'
import { acquireStartSlot, publishDiscoveryState, clearDiscoveryState, getStateFilePath, findFreePort } from './discovery.js'
import { ProxyClient } from '@life-ai-tools/claude-code-sdk'

const PROXY_VERSION = '0.5.1'

// ═══ Mode detection ═══════════════════════════════════════════════

/**
 * PROXY_MODE determines which runtime rules apply.
 *   'embedded' — consumer spawned us. We die with the consumer.
 *   'global'   — long-running singleton, systemd-managed.
 */
const PROXY_MODE: 'global' | 'embedded' =
  process.env.PROXY_MODE === 'embedded' ? 'embedded' : 'global'

const PARENT_PID = PROXY_MODE === 'embedded'
  ? parseInt(process.env.PROXY_PARENT_PID ?? '0', 10)
  : 0

if (PROXY_MODE === 'embedded' && (!PARENT_PID || PARENT_PID < 2)) {
  console.error('[claude-max-proxy] EMBEDDED mode requires PROXY_PARENT_PID env var (PID > 1)')
  process.exit(2)
}

// Port scan ranges differ per mode so global and embedded instances can coexist
// on the same host without stealing each other's ports.
//   global:   5050-5099 (reserved, systemd port)
//   embedded: 5100-5199 (per-process scratch)
const PORT_RANGE_MIN = PROXY_MODE === 'embedded' ? 5100 : 5050
const PORT_RANGE_MAX = PROXY_MODE === 'embedded' ? 5199 : 5099

const cfg = loadConfig()

// Start logger FIRST so all subsequent events are captured
const stopLogger = startLogger(cfg)

emit({
  level: 'info',
  kind: 'PROXY_MODE_START',
  mode: PROXY_MODE,
  parentPid: PARENT_PID || null,
  portRange: `${PORT_RANGE_MIN}-${PORT_RANGE_MAX}`,
})

// ═══ Port selection + discovery gate ═══════════════════════════════

let RUNTIME_PORT: number
let RUNTIME_HOST: string
let publishedDiscovery = false

if (PROXY_MODE === 'global') {
  // Global mode: use discovery to refuse double-start, publish state file.
  const slot = await acquireStartSlot(cfg.proxyHost, cfg.proxyPort)

  if (!slot.shouldStart && slot.reason === 'healthy') {
    const ex = slot.existing
    console.error(`[claude-max-proxy] Healthy GLOBAL proxy already running: pid=${ex.pid} port=${ex.port} since=${ex.startedAt}`)
    console.error(`[claude-max-proxy] State file: ${getStateFilePath()}`)
    console.error(`[claude-max-proxy] Refusing to start second GLOBAL instance. Exiting.`)
    stopLogger()
    process.exit(0)
  }

  if (!slot.shouldStart && slot.reason === 'no_free_port') {
    console.error(`[claude-max-proxy] No free port available in range ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}. Cannot start.`)
    stopLogger()
    process.exit(1)
  }

  RUNTIME_PORT = slot.shouldStart ? slot.port : cfg.proxyPort
  RUNTIME_HOST = slot.shouldStart ? slot.host : cfg.proxyHost
  publishedDiscovery = true  // will publish after bind

  if (RUNTIME_PORT !== cfg.proxyPort) {
    emit({
      level: 'info',
      kind: 'PROXY_CONFIG',
      msg: `Preferred port ${cfg.proxyPort} was occupied — auto-selected free port ${RUNTIME_PORT}`,
    })
  }
} else {
  // Embedded mode: pick free port from embedded range, don't touch discovery.
  // Multiple embedded proxies from different parents coexist on 5100-5199.
  RUNTIME_HOST = cfg.proxyHost
  const preferredPort = cfg.proxyPort >= PORT_RANGE_MIN && cfg.proxyPort <= PORT_RANGE_MAX
    ? cfg.proxyPort : PORT_RANGE_MIN
  // Inline port scan in embedded range (reuses same logic via findFreePort
  // which accepts a preferred hint; fall back to manual scan if needed).
  const port = await findFreePort(RUNTIME_HOST, preferredPort, PORT_RANGE_MIN, PORT_RANGE_MAX)
  if (port === null) {
    console.error(`[claude-max-proxy] EMBEDDED: no free port in ${PORT_RANGE_MIN}-${PORT_RANGE_MAX}`)
    stopLogger()
    process.exit(1)
  }
  RUNTIME_PORT = port
}

emit({
  level: 'info',
  kind: 'PROXY_CONFIG',
  logLevel: cfg.logLevel,
  port: cfg.proxyPort,
  host: cfg.proxyHost,
  kaIntervalSec: cfg.kaIntervalSec,
  credentialsPath: cfg.credentialsPath,
})

// ═══ ProxyClient (from SDK) — our core orchestrator ════════════════
//
// All cache-keepalive, session tracking, OAuth injection, SSE teeing,
// network-error handling lives in the SDK's ProxyClient. server.ts is
// now a thin HTTP wrapper: it translates Bun Requests to handleRequest()
// calls and serves /health, /stats, /admin routes.
//
// Adapters are lightweight bridges from proxy-package infrastructure
// (event bus, credentials reader) to SDK port interfaces.

const proxyClient = new ProxyClient({
  config: {
    anthropicBaseUrl: cfg.anthropicBaseUrl,
    kaIntervalSec: cfg.kaIntervalSec,
    kaIdleTimeoutSec: cfg.kaIdleTimeoutSec,
    kaMinTokens: cfg.kaMinTokens,
    kaRewriteWarnIdleSec: cfg.kaRewriteWarnIdleSec,
    kaRewriteWarnTokens: cfg.kaRewriteWarnTokens,
    kaRewriteBlockIdleSec: cfg.kaRewriteBlockIdleSec,
    kaRewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
  },
  credentialsProvider: new ProxyConfigCredentialsAdapter(cfg),
  eventEmitter: new BusEventEmitterAdapter(),
  // Use SDK defaults for sessionStore (InMemory with POSIX liveness) and
  // upstream (native fetch). Proxy-specific customizations would go here.
})

// Backward-compatible alias — heartbeat.ts and admin routes used to reach
// into `tracker`. They now query proxyClient instead.
const tracker = {
  size: () => proxyClient.sessionCount(),
  list: () => proxyClient.listSessions(),
}

// ═══ Heartbeat ═══════════════════════════════════════════════════════
// Still uses its own timer; reads rate limit from proxyClient.

const stopHeartbeat = startHeartbeat(cfg, tracker, () => proxyClient.rateLimitSnapshot)

// ═══ Passthrough handler — thin wrapper over ProxyClient ═══════════
//
// All the heavy lifting (session tracking, KA engine, header rewriting,
// SSE teeing, usage parsing, network error translation) happens inside
// SDK's ProxyClient. This handler just translates Bun Request → plain
// body/headers/context and returns the Response as-is.
//
// The original 280-line handler was reduced to ~20 lines after the
// Hybrid ports-and-adapters migration (SDK 0.11+).

async function handleMessages(
  req: Request,
  server: { requestIP(r: Request): { address: string; port: number } | null },
): Promise<Response> {
  // CC sends X-Claude-Code-Session-Id for per-session KA isolation.
  const sessionId = req.headers.get('x-claude-code-session-id') ?? 'anon-' + Date.now().toString(36)

  // Resolve consumer PID from TCP peer port so KA engine can skip fires
  // when the consumer process has died (JIT liveness check).
  const peer = server.requestIP(req)
  const srcPort = peer?.port ?? null
  const sourcePid = srcPort ? resolvePidFromPeerPort(srcPort) : null

  // Collect headers into a plain object (ProxyClient expects this shape).
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => { headers[k] = v })

  // Delegate to SDK ProxyClient — it handles everything end-to-end.
  const rawBody = await req.arrayBuffer()
  return proxyClient.handleRequest(rawBody, headers, {
    sessionId,
    sourcePid,
    signal: req.signal,
  })
}

// ─── PID resolution helper (kept local, proxy-specific) ───────────
//
// The old SessionTracker had this logic; we moved session state into SDK
// but the PID-from-TCP-peer-port resolution is fundamentally OS-specific
// and proxy-specific (SDK shouldn't care how we figured out the PID).
// This runs once per session (first request) and is cached in the session.
//
// Currently imported from ./session-tracker where it lives alongside
// processAlive(). Kept for now — may be inlined or removed in Phase 2.
import { resolvePidFromPort as resolvePidFromPeerPort } from './session-tracker.js'

// ═══ Stats endpoints ═══════════════════════════════════════════

function statsJson() {
  return {
    proxy: {
      version: PROXY_VERSION,
      pid: process.pid,
      mode: PROXY_MODE,
      parentPid: PARENT_PID || null,
      uptime: Math.floor(process.uptime()),
      port: RUNTIME_PORT,
      host: RUNTIME_HOST,
      endpoint: `http://${RUNTIME_HOST}:${RUNTIME_PORT}`,
      discoveryFile: PROXY_MODE === 'global' ? getStateFilePath() : null,
    },
    sessions: tracker.list().map(s => ({
      sessionId: s.sessionId,
      pid: s.pid,
      firstSeenAt: new Date(s.firstSeenAt).toISOString(),
      lastRequestAt: new Date(s.lastRequestAt).toISOString(),
      idleSec: Math.floor((Date.now() - s.lastRequestAt) / 1000),
      model: s.model,
      lastUsage: s.lastUsage,
      ka: {
        registrySize: (s.engine as any)._registry?.size ?? 0,
        timerRunning: (s.engine as any)._timer !== null,
      },
    })),
    rateLimit: proxyClient.rateLimitSnapshot,
    config: {
      logLevel: cfg.logLevel,
      kaIntervalSec: cfg.kaIntervalSec,
      kaRewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
    },
  }
}

// ═══ Bun.serve ═══════════════════════════════════════════════════

const server = Bun.serve({
  port: RUNTIME_PORT,
  hostname: RUNTIME_HOST,
  idleTimeout: 255,  // max — CC long streams

  async fetch(req, server) {
    const url = new URL(req.url)

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      return handleMessages(req, server)
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, uptime: Math.floor(process.uptime()), sessions: tracker.size() })
    }

    if (req.method === 'GET' && url.pathname === '/version') {
      return Response.json({ name: '@kiberos/claude-max-proxy', version: PROXY_VERSION, pid: process.pid, uptime: Math.floor(process.uptime()) })
    }

    if (req.method === 'GET' && url.pathname === '/stats') {
      return Response.json(statsJson(), { headers: { 'Cache-Control': 'no-store' } })
    }

    if (req.method === 'GET' && url.pathname === '/admin/sessions') {
      return Response.json({ sessions: tracker.list().map(s => ({
        sessionId: s.sessionId, pid: s.pid, model: s.model,
        firstSeenAt: s.firstSeenAt, lastRequestAt: s.lastRequestAt,
      })) })
    }

    if (req.method === 'POST' && url.pathname === '/admin/shutdown') {
      emit({ level: 'info', kind: 'PROXY_SHUTDOWN', msg: 'Shutdown requested via /admin/shutdown' })
      setTimeout(() => shutdown(), 100)
      return Response.json({ ok: true, msg: 'Shutting down' })
    }

    return new Response('Not Found', { status: 404 })
  },
})

// ═══ Ready announcement (mode-specific) ═══════════════════════════

const endpoint = `http://${RUNTIME_HOST}:${RUNTIME_PORT}`

if (PROXY_MODE === 'global') {
  // Global: publish discovery so other processes (CC, CLI) can find us
  const discoveryState = publishDiscoveryState({
    port: RUNTIME_PORT,
    host: RUNTIME_HOST,
    version: PROXY_VERSION,
  })

  emit({
    level: 'info',
    kind: 'PROXY_STARTED',
    mode: 'global',
    port: RUNTIME_PORT,
    host: RUNTIME_HOST,
    pid: process.pid,
    discoveryFile: getStateFilePath(),
    endpoint: discoveryState.endpoint,
  })
} else {
  // Embedded: print JSON to stdout so parent can read port assignment.
  // This is the ONLY line the parent should parse from our stdout.
  // Format: single line, unbuffered, JSON object with type='ready'.
  console.log(JSON.stringify({
    type: 'ready',
    mode: 'embedded',
    pid: process.pid,
    parentPid: PARENT_PID,
    host: RUNTIME_HOST,
    port: RUNTIME_PORT,
    endpoint,
    version: PROXY_VERSION,
  }))

  emit({
    level: 'info',
    kind: 'PROXY_STARTED',
    mode: 'embedded',
    port: RUNTIME_PORT,
    host: RUNTIME_HOST,
    pid: process.pid,
    parentPid: PARENT_PID,
    endpoint,
  })
}

// ═══ Embedded mode: watch parent PID, self-terminate on parent death ═══

let parentWatcher: ReturnType<typeof setInterval> | null = null
if (PROXY_MODE === 'embedded' && PARENT_PID > 0) {
  // Poll parent liveness every 2s. When kernel reaps the parent, the child
  // (us) is re-parented to init (PID 1) but kill(PARENT_PID, 0) will fail.
  // Tight 2s interval gives at most ~2s of orphan time before we self-exit.
  parentWatcher = setInterval(() => {
    if (!processAlive(PARENT_PID)) {
      emit({
        level: 'info',
        kind: 'PROXY_PARENT_GONE',
        parentPid: PARENT_PID,
        msg: `Parent PID ${PARENT_PID} died, self-terminating (embedded mode)`,
      })
      // Give logger 100ms to flush, then hard-exit
      setTimeout(() => shutdown(), 100)
    }
  }, 2_000)
  if (parentWatcher && typeof parentWatcher === 'object' && 'unref' in parentWatcher) {
    (parentWatcher as any).unref()
  }
}

// ═══ Shutdown ═══════════════════════════════════════════════════

function shutdown(): void {
  if (parentWatcher) clearInterval(parentWatcher)
  stopHeartbeat()
  // ProxyClient owns reaper + engine lifecycle. Stopping it cleans everything.
  proxyClient.stop()
  server.stop(true)
  // Only clear discovery if WE wrote it (global mode only)
  if (PROXY_MODE === 'global') clearDiscoveryState()
  stopLogger()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('SIGHUP', shutdown)   // also handle SIGHUP for embedded parent-kill scenarios

// Never crash on unhandled errors — proxy must stay alive.
process.on('uncaughtException', (err) => {
  emit({ level: 'error', kind: 'ERROR', msg: `uncaughtException: ${err?.message}`, stack: err?.stack?.split('\n').slice(0, 4) })
})
process.on('unhandledRejection', (reason: any) => {
  emit({ level: 'error', kind: 'ERROR', msg: `unhandledRejection: ${reason?.message ?? reason}` })
})
