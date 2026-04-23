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

const cfg = loadConfig()

// Start logger FIRST so all subsequent events are captured
const stopLogger = startLogger(cfg)

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

  // Copy headers (passthrough as-is)
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => {
    // Strip host-related headers that fetch() rejects/overrides
    const lk = k.toLowerCase()
    if (['host', 'content-length', 'connection'].includes(lk)) return
    headers[k] = v
  })

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
  const [toClient, toParse] = upstream.body.tee()

  // Parse in background to extract usage and notify engine on completion
  ;(async () => {
    try {
      let usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
      const decoder = new TextDecoder()
      const reader = toParse.getReader()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
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
      session.engine.notifyRealRequestComplete(usage)

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

  // Return the other tee — CC gets raw SSE bytes
  return new Response(toClient, {
    status: upstream.status,
    headers: upstream.headers,
  })
}

// ═══ Stats endpoints ═══════════════════════════════════════════

function statsJson() {
  return {
    proxy: {
      version: '0.1.0',
      pid: process.pid,
      uptime: Math.floor(process.uptime()),
      port: cfg.proxyPort,
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
  port: cfg.proxyPort,
  hostname: cfg.proxyHost,
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

emit({
  level: 'info',
  kind: 'PROXY_STARTED',
  port: cfg.proxyPort,
  host: cfg.proxyHost,
  pid: process.pid,
})

// ═══ Shutdown ═══════════════════════════════════════════════════

function shutdown(): void {
  clearInterval(reaper)
  stopHeartbeat()
  tracker.stopAll()
  server.stop(true)
  stopLogger()
  process.exit(0)
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
