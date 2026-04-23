#!/usr/bin/env bun
/**
 * claude-max-proxy server — Bun HTTP with byte-level Anthropic passthrough.
 *
 * Routes:
 *   POST /v1/messages    — real request passthrough (CC → Anthropic, SSE stream back)
 *   GET  /health         — quick health check
 *   GET  /stats          — full proxy state (JSON)
 *   GET  /admin/sessions — list all tracked sessions
 *   POST /admin/shutdown — graceful shutdown
 *
 * Keepalive lifecycle:
 *   1. Real request arrives → snapshot its rawBody+headers+usage
 *   2. engine.notifyRealRequestStart(rawBody, headers)
 *   3. Pipe SSE stream back to CC byte-for-byte
 *   4. engine.notifyRealRequestComplete(usage) — starts KA timer
 *   5. Every ~120s: engine fires a KA replay of last snapshot with max_tokens=1
 *   6. On CC session death (PID gone): engine.stop()
 */

import { loadConfig } from './config.js'
import { emit } from './event-bus.js'
import { startLogger } from './logger.js'
import { SessionTracker } from './session-tracker.js'
import { getAccessToken, upstreamFetch, invalidateTokenCache } from './upstream.js'
import { startHeartbeat } from './heartbeat.js'
import { acquireStartSlot, publishDiscoveryState, clearDiscoveryState, getStateFilePath } from './discovery.js'

const PROXY_VERSION = '0.1.0'

const cfg = loadConfig()

// Start logger FIRST so all subsequent events are captured
const stopLogger = startLogger(cfg)

// ═══ Discovery gate — refuse to start if another healthy proxy exists ═══

const slot = await acquireStartSlot(cfg.proxyHost, cfg.proxyPort)

if (!slot.shouldStart && slot.reason === 'healthy') {
  const ex = slot.existing
  console.error(`[claude-max-proxy] Healthy proxy already running: pid=${ex.pid} port=${ex.port} since=${ex.startedAt}`)
  console.error(`[claude-max-proxy] State file: ${getStateFilePath()}`)
  console.error(`[claude-max-proxy] Refusing to start second instance. Exiting.`)
  stopLogger()
  process.exit(0)
}

if (!slot.shouldStart && slot.reason === 'no_free_port') {
  console.error(`[claude-max-proxy] No free port available in range 5050-5099. Cannot start.`)
  stopLogger()
  process.exit(1)
}

// slot.shouldStart === true here — acquired a port (may differ from cfg.proxyPort)
const RUNTIME_PORT = slot.shouldStart ? slot.port : cfg.proxyPort
const RUNTIME_HOST = slot.shouldStart ? slot.host : cfg.proxyHost

if (RUNTIME_PORT !== cfg.proxyPort) {
  emit({
    level: 'info',
    kind: 'PROXY_CONFIG',
    msg: `Preferred port ${cfg.proxyPort} was occupied — auto-selected free port ${RUNTIME_PORT}`,
  })
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

// ═══ Session tracker with engine factory ═══════════════════════════

const tracker = new SessionTracker((sessionId) => ({
  config: {
    intervalMs: cfg.kaIntervalSec * 1000,
    idleTimeoutMs: cfg.kaIdleTimeoutSec > 0 ? cfg.kaIdleTimeoutSec * 1000 : Infinity,
    minTokens: cfg.kaMinTokens,
    rewriteWarnIdleMs: cfg.kaRewriteWarnIdleSec * 1000,
    rewriteWarnTokens: cfg.kaRewriteWarnTokens,
    rewriteBlockIdleMs: cfg.kaRewriteBlockIdleSec > 0 ? cfg.kaRewriteBlockIdleSec * 1000 : Infinity,
    rewriteBlockEnabled: cfg.kaRewriteBlockEnabled,
    onHeartbeat: (stats) => {
      emit({
        level: 'info',
        kind: 'KA_FIRE_COMPLETE',
        sessionId,
        model: stats.model,
        durationMs: stats.durationMs,
        idleMs: stats.idleMs,
        usage: {
          inputTokens: stats.usage.inputTokens,
          outputTokens: stats.usage.outputTokens,
          cacheReadInputTokens: stats.usage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: stats.usage.cacheCreationInputTokens ?? 0,
        },
        rateLimit: stats.rateLimit,
      })
    },
    onTick: (tick) => {
      // Only log when close to fire-time (debug level)
      if (tick.idleMs > cfg.kaIntervalSec * 900) {
        emit({
          level: 'debug',
          kind: 'KA_TICK_IDLE',
          sessionId,
          idleMs: tick.idleMs,
          nextFireMs: tick.nextFireMs,
          model: tick.model,
          tokens: tick.tokens,
        })
      }
    },
    onDisarmed: (info) => {
      emit({
        level: 'error',
        kind: 'KA_DISARM',
        sessionId,
        reason: info.reason,
        msg: `KA disarmed for session ${sessionId.slice(0, 8)} — reason=${info.reason}`,
      })
    },
    onRewriteWarning: (info) => {
      emit({
        level: info.blocked ? 'error' : 'info',
        kind: info.blocked ? 'REWRITE_BLOCK' : 'REWRITE_WARN',
        sessionId,
        idleMs: info.idleMs,
        estimatedTokens: info.estimatedTokens,
        blocked: info.blocked,
        model: info.model,
      })
    },
    onNetworkStateChange: (info) => {
      emit({
        level: info.to === 'degraded' ? 'error' : 'info',
        kind: info.to === 'degraded' ? 'NETWORK_DEGRADED' : 'NETWORK_HEALTHY',
        sessionId,
        from: info.from,
        to: info.to,
      })
    },
  },
  getToken: () => getAccessToken(cfg),
  doFetch: (body, headers, signal) => upstreamFetch(cfg, body, headers, signal),
  getRateLimitInfo: () => _lastRateLimitInfo,
}))

// Last seen rate-limit info (shared across all sessions — it's org-level)
let _lastRateLimitInfo: {
  status: string | null
  resetAt: number | null
  claim: string | null
  retryAfter: number | null
  utilization5h: number | null
  utilization7d: number | null
} = {
  status: null, resetAt: null, claim: null, retryAfter: null,
  utilization5h: null, utilization7d: null,
}

function parseRateLimitHeaders(headers: Headers) {
  return {
    status: headers.get('anthropic-ratelimit-unified-status'),
    resetAt: headers.get('anthropic-ratelimit-unified-reset')
      ? Number(headers.get('anthropic-ratelimit-unified-reset')) : null,
    claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
    retryAfter: headers.get('retry-after')
      ? parseFloat(headers.get('retry-after')!) : null,
    utilization5h: headers.get('anthropic-ratelimit-unified-5h-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-5h-utilization')!) : null,
    utilization7d: headers.get('anthropic-ratelimit-unified-7d-utilization')
      ? parseFloat(headers.get('anthropic-ratelimit-unified-7d-utilization')!) : null,
  }
}

// ═══ Heartbeat ═══════════════════════════════════════════════════════

const stopHeartbeat = startHeartbeat(cfg, tracker, () => _lastRateLimitInfo)

// Reap dead sessions every 10s
const reaper = setInterval(() => {
  tracker.reapDead()
}, 10_000)
if (typeof reaper === 'object' && 'unref' in reaper) (reaper as any).unref()

// ═══ Passthrough handler ═══════════════════════════════════════════

async function handleMessages(req: Request, server: { requestIP(r: Request): { address: string; port: number } | null }): Promise<Response> {
  // CC sends X-Claude-Code-Session-Id — required for per-session KA
  const sessionId = req.headers.get('x-claude-code-session-id') ?? 'anon-' + Date.now().toString(36)

  // Resolve source PID once (only matters on first request for this session)
  const peer = server.requestIP(req)
  const srcPort = peer?.port ?? null

  const session = tracker.getOrCreate(sessionId, srcPort)
  session.lastRequestAt = Date.now()

  // Read raw body (byte-array, no parse)
  const rawBody = await req.arrayBuffer()
  const rawBodyStr = new TextDecoder().decode(rawBody)

  // We DO need to parse minimally — to extract model for KA replay + snapshot
  // This parse is SAFE (we parse for our own bookkeeping, do NOT mutate).
  let parsedBody: any
  try {
    parsedBody = JSON.parse(rawBodyStr)
  } catch (e) {
    emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: 'Invalid JSON body' })
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 })
  }

  const model = parsedBody.model ?? 'unknown'
  session.model = model

  // Copy headers (passthrough as-is, EXCEPT Authorization + compression headers).
  // We strip accept-encoding because upstream may return gzip'd SSE which conflicts
  // with stream tee() / Response() re-encoding in Bun. Let Anthropic send plain text.
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    const lk = k.toLowerCase()
    if ([
      'host', 'content-length', 'connection', 'authorization',
      'accept-encoding',   // force uncompressed SSE
    ].includes(lk)) return
    headers[k] = v
  })
  headers['accept-encoding'] = 'identity'  // explicit: no gzip/br/deflate

  // Replace with real OAuth token from ~/.claude/.credentials.json.
  // CC sends its own ANTHROPIC_AUTH_TOKEN (placeholder when using our wrapper),
  // but Anthropic only accepts the OAuth bearer. This is the entire point of
  // the proxy — it unlocks subscription access for native CC.
  try {
    const token = await getAccessToken(cfg)
    headers['Authorization'] = `Bearer ${token}`
  } catch (e) {
    emit({ level: 'error', kind: 'TOKEN_NEEDS_RELOGIN', sessionId, msg: 'No OAuth credentials — run: claude login' })
    return new Response(JSON.stringify({
      error: { type: 'authentication_error', message: 'No OAuth credentials. Run: claude login' },
    }), { status: 401 })
  }

  // Ensure oauth-2025-04-20 beta is present. When CC uses ANTHROPIC_AUTH_TOKEN
  // (API key mode), it OMITS this beta. But Anthropic requires it for OAuth-
  // bearer requests. Append it if missing.
  const existingBeta = headers['anthropic-beta'] ?? headers['Anthropic-Beta'] ?? ''
  if (!existingBeta.includes('oauth-2025-04-20')) {
    const prefix = existingBeta ? existingBeta + ',' : ''
    headers['anthropic-beta'] = prefix + 'oauth-2025-04-20'
    // Cleanup conflicting casing
    delete headers['Anthropic-Beta']
  }

  emit({
    level: 'info',
    kind: 'REAL_REQUEST_START',
    sessionId,
    model,
    bodyBytes: rawBody.byteLength,
  })

  // Prime KA snapshot BEFORE upstream call (engine aborts any in-flight KA)
  session.engine.notifyRealRequestStart(model, parsedBody, headers)

  // Pre-request guard (throws if cache presumed dead + block enabled)
  try {
    session.engine.checkRewriteGuard(model)
  } catch (err: any) {
    if (err.code === 'CACHE_REWRITE_BLOCKED') {
      return new Response(JSON.stringify({
        error: { type: 'cache_rewrite_blocked', message: err.message },
      }), { status: 429 })
    }
    throw err
  }

  const t0 = Date.now()

  // Forward upstream — byte-level passthrough
  const upstream = await fetch(`${cfg.anthropicBaseUrl}/v1/messages?beta=true`, {
    method: 'POST',
    headers,
    body: rawBodyStr,
    signal: req.signal,
  })

  // Capture rate limit from headers
  _lastRateLimitInfo = parseRateLimitHeaders(upstream.headers)

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '')
    if (upstream.status === 401) invalidateTokenCache()

    emit({
      level: 'error',
      kind: 'REAL_REQUEST_ERROR',
      sessionId,
      status: upstream.status,
      msg: errText.slice(0, 200),
    })

    return new Response(errText, {
      status: upstream.status,
      headers: upstream.headers,
    })
  }

  if (!upstream.body) {
    return new Response('No upstream body', { status: 502 })
  }

  // Byte-level pipe — but TEE one side so we can parse usage for engine.
  // We split the stream: one goes to client, one gets parsed for usage.
  let toClient: ReadableStream<Uint8Array>
  let toParse: ReadableStream<Uint8Array>
  try {
    const teed = upstream.body.tee()
    toClient = teed[0]
    toParse = teed[1]
  } catch (err: any) {
    emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: `tee() failed: ${err?.message}` })
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  }

  // Parse in background to extract usage and notify engine on completion.
  // Hardened: every step wrapped in try/catch, never crashes the server.
  const parsePromise = (async () => {
    try {
      let usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      const decoder = new TextDecoder()
      const reader = toParse.getReader()
      let buffer = ''
      while (true) {
        let done: boolean, value: Uint8Array | undefined
        try {
          const r = await reader.read()
          done = r.done
          value = r.value
        } catch (readErr: any) {
          // Client aborted, connection dropped, etc — not fatal
          emit({ level: 'debug', kind: 'REAL_REQUEST_ERROR', sessionId, msg: `stream read aborted: ${readErr?.message}` })
          return
        }
        if (done) break
        if (!value) continue
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6)
          if (raw === '[DONE]') continue
          try {
            const p = JSON.parse(raw)
            if (p.type === 'message_start' && p.message?.usage) {
              const u = p.message.usage
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
                cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
              }
            } else if (p.type === 'message_delta' && p.usage?.output_tokens) {
              usage.outputTokens = p.usage.output_tokens
            }
          } catch {}
        }
      }

      session.lastUsage = usage
      try { session.engine.notifyRealRequestComplete(usage) } catch (e: any) {
        emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: `engine.notifyRealRequestComplete: ${e?.message}` })
      }

      emit({
        level: 'info',
        kind: 'REAL_REQUEST_COMPLETE',
        sessionId,
        model,
        durationMs: Date.now() - t0,
        usage,
        rateLimit: {
          util5h: _lastRateLimitInfo.utilization5h,
          util7d: _lastRateLimitInfo.utilization7d,
          status: _lastRateLimitInfo.status,
        },
      })
    } catch (err: any) {
      emit({
        level: 'error',
        kind: 'REAL_REQUEST_ERROR',
        sessionId,
        msg: `SSE parse error: ${err?.message ?? err}`,
      })
    }
  })()

  // Attach catch so unhandled rejection never crashes server
  parsePromise.catch(e => emit({ level: 'error', kind: 'REAL_REQUEST_ERROR', sessionId, msg: `parse promise rejected: ${e?.message}` }))

  // Return the other tee — CC gets raw SSE bytes.
  // Strip content-encoding/content-length — Bun auto-computes content-length,
  // and we asked upstream for identity encoding.
  const responseHeaders = new Headers(upstream.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')
  return new Response(toClient, {
    status: upstream.status,
    headers: responseHeaders,
  })
}

// ═══ Stats endpoints ═══════════════════════════════════════════

function statsJson() {
  return {
    proxy: {
      version: PROXY_VERSION,
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      port: RUNTIME_PORT,
      host: RUNTIME_HOST,
      endpoint: `http://${RUNTIME_HOST}:${RUNTIME_PORT}`,
      discoveryFile: getStateFilePath(),
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
    rateLimit: _lastRateLimitInfo,
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

// Publish discovery state so other processes can find us
const discoveryState = publishDiscoveryState({
  port: RUNTIME_PORT,
  host: RUNTIME_HOST,
  version: PROXY_VERSION,
})

emit({
  level: 'info',
  kind: 'PROXY_STARTED',
  port: RUNTIME_PORT,
  host: RUNTIME_HOST,
  pid: process.pid,
  discoveryFile: getStateFilePath(),
  endpoint: discoveryState.endpoint,
})

// ═══ Shutdown ═══════════════════════════════════════════════════

function shutdown(): void {
  clearInterval(reaper)
  stopHeartbeat()
  tracker.stopAll()
  server.stop(true)
  clearDiscoveryState()
  stopLogger()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Never crash on unhandled errors — proxy must stay alive.
process.on('uncaughtException', (err) => {
  emit({ level: 'error', kind: 'ERROR', msg: `uncaughtException: ${err?.message}`, stack: err?.stack?.split('\n').slice(0, 4) })
})
process.on('unhandledRejection', (reason: any) => {
  emit({ level: 'error', kind: 'ERROR', msg: `unhandledRejection: ${reason?.message ?? reason}` })
})
