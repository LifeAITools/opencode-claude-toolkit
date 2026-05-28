/**
 * Health module — /health, /version, /stats endpoints.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { loadKeepaliveConfig } from '@life-ai-tools/claude-code-sdk'

export interface HealthModuleOpts {
  mode: 'global' | 'embedded'
  parentPid: number
  port: number
  host: string
  discoveryFile: string | null
  moduleStatus: { loaded: string[]; failed: { name: string; error: string }[] }
}

let ctx: ModuleContext
let opts: HealthModuleOpts

function statsJson() {
  const tracker = { size: () => ctx.proxyClient.sessionCount(), list: () => ctx.proxyClient.listSessions() }
  return {
    proxy: {
      version: ctx.version,
      pid: process.pid,
      mode: opts.mode,
      parentPid: opts.parentPid || null,
      uptime: Math.floor(process.uptime()),
      port: opts.port,
      host: opts.host,
      endpoint: `http://${opts.host}:${opts.port}`,
      discoveryFile: opts.discoveryFile,
    },
    modules: opts.moduleStatus,
    sessions: tracker.list().map(s => ({
      sessionId: s.sessionId,
      pid: s.pid,
      firstSeenAt: new Date(s.firstSeenAt).toISOString(),
      lastRequestAt: new Date(s.lastRequestAt).toISOString(),
      idleSec: Math.floor((Date.now() - s.lastRequestAt) / 1000),
      model: s.model,
      lastUsage: s.lastUsage,
      ka: {
        registrySize: (s.engine as any)?._registry?.size ?? 0,
        timerRunning: (s.engine as any)?._timer !== null,
      },
    })),
    rateLimit: ctx.proxyClient.rateLimitSnapshot,
    config: {
      logLevel: ctx.config.logLevel,
      kaIntervalSec: ctx.config.kaIntervalSec,
      kaRewriteBlockEnabled: ctx.config.kaRewriteBlockEnabled,
    },
    cacheConfig: (() => {
      try {
        const c = loadKeepaliveConfig()
        return {
          cacheTtlMs: c.cacheTtlMs,
          safetyMarginMs: c.safetyMarginMs,
          intervalMs: c.intervalMs,
          intervalClampMin: c.intervalClampMin,
          intervalClampMax: c.intervalClampMax,
          retryDelaysMs: c.retryDelaysMs,
          source: c._source,
        }
      } catch (e: any) { return { error: e?.message } }
    })(),
    cacheMetrics: (() => {
      try { return ctx.proxyClient.cacheMetricsSnapshot }
      catch (e: any) { return { error: e?.message } }
    })(),
    openaiCompat: {
      enabled: true,
      endpoint: '/v1/chat/completions',
      modelsEndpoint: '/v1/models',
      authRequired: !!ctx.config.openaiCompatAuthToken,
      thinkingMode: ctx.config.openaiCompatThinking,
    },
  }
}

export function createHealthModule(moduleOpts: HealthModuleOpts): ProxyModule {
  opts = moduleOpts

  const routes: RouteDefinition[] = [
    {
      method: 'GET',
      path: '/health',
      handler: async () => Response.json({
        ok: true,
        uptime: Math.floor(process.uptime()),
        sessions: ctx.proxyClient.sessionCount(),
      }),
    },
    {
      method: 'GET',
      path: '/version',
      handler: async () => Response.json({
        name: '@kiberos/claude-max-proxy',
        version: ctx.version,
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
      }),
    },
    {
      method: 'GET',
      path: '/stats',
      handler: async () => Response.json(statsJson(), { headers: { 'Cache-Control': 'no-store' } }),
    },
  ]

  return {
    name: 'health',
    routes,
    init(c) { ctx = c },
  }
}
