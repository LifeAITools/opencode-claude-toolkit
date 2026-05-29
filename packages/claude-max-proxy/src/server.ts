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
import { ProxyClient, loadKeepaliveConfig, startRewriteDumpCleanup } from '@life-ai-tools/claude-code-sdk'
import { captureBody, startCaptureCleanup, CAPTURE_INFO } from './body-capture.js'
import { startStatsEmitter } from './stats-emitter.js'
import { checkDeployDrift } from './deploy-drift.js'
// OpenAI translate imports moved to modules/openai-compat.ts and modules/anthropic.ts

import { readFileSync as _readPkgFs } from 'fs'
import { join as _joinPkg } from 'path'
const PROXY_VERSION: string = (() => {
  try { return JSON.parse(_readPkgFs(_joinPkg(import.meta.dir, '..', 'package.json'), 'utf8')).version ?? '0.0.0' }
  catch { return '0.0.0' }
})()

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

// Deploy-drift check (Rule #15): warn loudly if live src was hand-edited since
// the last deploy-from-source.sh. installDir = parent of this file's dir
// ($INSTALLED/src/server.ts -> $INSTALLED). Catches the silent-drift failure
// mode that once killed the quota pipeline for 27h.
{
  const drift = checkDeployDrift(_joinPkg(import.meta.dir, '..'))
  if (drift.manifestMissing) {
    emit({ level: 'info', kind: 'DEPLOY_DRIFT_CHECK', msg: 'no deploy manifest — deployed by hand? use deploy-from-source.sh so drift is detectable' })
  } else if (drift.drifted.length > 0) {
    emit({ level: 'error', kind: 'DEPLOY_DRIFT', msg: `${drift.drifted.length} live src file(s) hand-edited since deploy (source ${drift.sourceCommit}, ${drift.deployedAt}): ${drift.drifted.join(', ')} — re-deploy from source`, drifted: drift.drifted })
  } else {
    emit({ level: 'info', kind: 'DEPLOY_CLEAN', msg: `live src matches deploy manifest (source ${drift.sourceCommit}, deployed ${drift.deployedAt})` })
  }
}

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

// ═══ Body-capture boot — rolling 48h TTL of native CC + opencode bodies ══
// Default ON; disable via CLAUDE_MAX_PROXY_CAPTURE_BODIES=0.
// Files land in CAPTURE_INFO.dir (default ~/.claude-local/proxy-body-dumps/).
// Sweep timer runs in background; safe to ignore the returned stop fn here.
startCaptureCleanup()

// ═══ Rewrite-guard dump rotation ════════════════════════════════════
// Guard-block/let-through dumps (~660KB each) accumulated unbounded before
// this. TTL 7d + 200MB cap (env: CLAUDE_MAX_PROXY_REWRITE_DUMP_TTL_HOURS /
// _MAX_MB). Sweep every 30min + once on boot.
startRewriteDumpCleanup()

// ═══ Quota pipeline Stage 1: stats emitter ══════════════════════════
// Subscribes to the bus (REAL_REQUEST_COMPLETE / KA_FIRE_COMPLETE) and writes
// the narrow versioned contract to ~/.claude-local/claude-max-stats.jsonl, which
// claude-max-quota-watcher.service (Stage 2) tails. MUST be started here — a
// prior server.ts dropped this call, silently killing the quota pipeline.
const stopStatsEmitter = startStatsEmitter()

emit({
  level: 'info',
  kind: 'BODY_CAPTURE',
  enabled: CAPTURE_INFO.enabled,
  ttlHours: CAPTURE_INFO.ttlHours,
  dir: CAPTURE_INFO.dir,
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

const credentialsAdapter = new ProxyConfigCredentialsAdapter(cfg)

// Managed sessions — early init so ProxyClient liveness checker can reference it
import { ManagedSessionService } from './managed-sessions.js'
const managedSessionsSvc = new ManagedSessionService()
managedSessionsSvc.start((e) => emit(e as any))

const proxyClient = new ProxyClient({
  config: {
    anthropicBaseUrl: cfg.anthropicBaseUrl,
    kaCacheTtlSec: cfg.kaCacheTtlSec,
    kaIntervalSec: cfg.kaIntervalSec,
    kaIdleTimeoutSec: cfg.kaIdleTimeoutSec,
    kaMinTokens: cfg.kaMinTokens,
    kaRewriteWarnIdleSec: cfg.kaRewriteWarnIdleSec,
    kaRewriteWarnTokens: cfg.kaRewriteWarnTokens,
    kaRewriteBlockIdleSec: cfg.kaRewriteBlockIdleSec,
    kaRewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
  },
  credentialsProvider: credentialsAdapter,
  eventEmitter: new BusEventEmitterAdapter(),
  // Custom liveness: PID check + Worker managed session override.
  livenessChecker: {
    isAlive(pid: number): boolean {
      try { process.kill(pid, 0); return true } catch {}
      return managedSessionsSvc.isAliveByPid(pid)
    },
  },
})

// ═══ Credentials watcher ═══════════════════════════════════════════
//
// Token cache in upstream.ts only invalidates on 401. But quota-exhaustion
// returns 429 (NOT 401), so after `claude login` to a new org the proxy
// would keep using the stale cached token for up to ~5min. fs.watch on
// the credentials file makes the proxy react immediately to login/refresh.
// 200ms debounce coalesces the read+write storm of credential file rotation.
import { watch as fsWatch } from 'node:fs'
let _credsDebounce: ReturnType<typeof setTimeout> | null = null
try {
  fsWatch(cfg.credentialsPath, { persistent: false }, () => {
    if (_credsDebounce) clearTimeout(_credsDebounce)
    _credsDebounce = setTimeout(() => {
      credentialsAdapter.invalidate()
      emit({
        level: 'info',
        kind: 'TOKEN_FILE_CHANGED',
        msg: `Credentials file changed at ${cfg.credentialsPath} — token cache invalidated`,
      })
    }, 200)
  })
  emit({ level: 'info', kind: 'INFO', msg: `Credentials fs.watch armed on ${cfg.credentialsPath}` })
} catch (e: any) {
  // fs.watch can fail if the file doesn't exist yet (fresh install) —
  // not fatal; first `claude login` will create it and next invalidation
  // can only be triggered manually via /admin/disarm or by 401.
  emit({ level: 'error', kind: 'ERROR', msg: `Credentials watch failed: ${e?.message}` })
}

// Backward-compatible alias — heartbeat.ts and admin routes used to reach
// into `tracker`. They now query proxyClient instead.
const tracker = {
  size: () => proxyClient.sessionCount(),
  list: () => proxyClient.listSessions(),
}

// Stale managed session cleanup now handled by ManagedSessionService.start()

// ═══ Heartbeat ═══════════════════════════════════════════════════════
// Still uses its own timer; reads rate limit from proxyClient.

const stopHeartbeat = startHeartbeat(cfg, tracker, () => proxyClient.rateLimitSnapshot)

// ═══ Module System ═══════════════════════════════════════════════
//
// Each endpoint family is a self-contained module with its own routes.
// server.ts is a thin router that loads modules and dispatches.

import { loadModules, matchRoute, type ModuleContext } from './module.js'
import { setCompatVersion } from './openai-translate.js'
import { createHealthModule } from './modules/health.js'
import { createAdminModule } from './modules/admin.js'
import { createAnthropicModule } from './modules/anthropic.js'
import { createOpenAICompatModule } from './modules/openai-compat.js'

// Apply config-driven compat version
if (cfg.ccCompatVersion) setCompatVersion(cfg.ccCompatVersion)

// Module context — shared across all modules
const moduleCtx: ModuleContext = {
  emit: (e) => emit(e as any),
  config: cfg,
  proxyClient,
  managedSessions: managedSessionsSvc,
  version: PROXY_VERSION,
}

// Instantiate modules
const healthModuleOpts = {
  mode: PROXY_MODE,
  parentPid: PARENT_PID,
  port: RUNTIME_PORT,
  host: RUNTIME_HOST,
  discoveryFile: PROXY_MODE === 'global' ? getStateFilePath() : null,
  moduleStatus: { loaded: [] as string[], failed: [] as { name: string; error: string }[] },
}

const modules = [
  createHealthModule(healthModuleOpts),
  createAdminModule(() => shutdown()),
  createAnthropicModule(),
  createOpenAICompatModule(),
]

// Load all modules (init + collect routes; failed modules' routes skipped)
const { allRoutes, loaded, failed } = loadModules(modules, moduleCtx, (e) => emit(e as any))
healthModuleOpts.moduleStatus = { loaded, failed }

emit({
  level: 'info', kind: 'INFO',
  msg: `Modules loaded: ${loaded.join(', ')}${failed.length ? ` | FAILED: ${failed.map(f => f.name).join(', ')}` : ''}`,
  modulesLoaded: loaded.length,
  modulesFailed: failed.length,
  totalRoutes: allRoutes.length,
})

// ═══ Bun.serve — thin router ═══════════════════════════════════

const server = Bun.serve({
  port: RUNTIME_PORT,
  hostname: RUNTIME_HOST,
  idleTimeout: 255,

  async fetch(req, server) {
    const url = new URL(req.url)
    const route = matchRoute(allRoutes, req.method, url.pathname)
    if (route) return route.handler(req, server)
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

  // Emit a clear STARTUP marker (greppable) — tells you exactly which proxy
  // instance is running and where it logs. Distinct from in-process plugin
  // STARTUP events (those go to ~/.claude/claude-max-debug.log).
  emit({
    level: 'info',
    kind: 'STARTUP',
    component: 'standalone-proxy',
    pkg: `@kiberos/claude-max-proxy@${PROXY_VERSION}`,
    mode: 'global',
    port: RUNTIME_PORT,
    host: RUNTIME_HOST,
    pid: process.pid,
    parentPid: process.ppid,
    node: process.version,
    consumer: 'native-claude-code-cli (NOT opencode-plugin)',
    logFiles: { human: cfg.logFile, jsonl: cfg.logJsonl },
    versionEndpoint: `http://${RUNTIME_HOST}:${RUNTIME_PORT}/version`,
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

  // Same STARTUP marker as global mode — distinguishes embedded instances.
  emit({
    level: 'info',
    kind: 'STARTUP',
    component: 'standalone-proxy',
    pkg: `@kiberos/claude-max-proxy@${PROXY_VERSION}`,
    mode: 'embedded',
    port: RUNTIME_PORT,
    host: RUNTIME_HOST,
    pid: process.pid,
    parentPid: PARENT_PID,
    node: process.version,
    consumer: `parent-pid=${PARENT_PID} (typically native CC CLI spawned us)`,
    logFiles: { human: cfg.logFile, jsonl: cfg.logJsonl },
    versionEndpoint: `http://${RUNTIME_HOST}:${RUNTIME_PORT}/version`,
  })

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
  stopStatsEmitter()
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
