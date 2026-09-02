/**
 * Health module — /health, /version, /stats endpoints.
 */

import type { ProxyModule, ModuleContext, RouteDefinition } from '../module.js'
import { identityWindow } from '../identity-watch.js'
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

/**
 * Порог, выше которого ответ /stats попадает в журнал. Норма — доли
 * миллисекунды; полсекунды это чужой срок ожидания, поэтому 50 мс ловит
 * деградацию с десятикратным запасом до того, как её увидит звонящий.
 * Переопределяется переменной окружения (0 = писать каждое обращение).
 */
function statsSlowThresholdMs(): number {
  // 🔴 ПОПРАВКА К СОБСТВЕННОМУ ОБОСНОВАНИЮ (02.09.2026, в тот же час). Сначала
  // здесь стояло, что чтение на каждом обращении позволяет понизить порог у
  // РАБОТАЮЩЕЙ службы. Это неверно: переменные окружения запущенного процесса
  // извне не меняются, а `/admin/reload` перезагружает сессии, не настройки.
  // Порог задаётся при запуске, как и всё прочее окружение.
  // Чтение оставлено на каждом обращении по честной причине: оно ничего не
  // стоит и делает порог проверяемым в тесте, где иначе пришлось бы ждать
  // настоящей медленной сборки ответа.
  const raw = process.env.CLAUDE_MAX_STATS_SLOW_MS
  if (raw === undefined || raw === '') return 50
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : 50
}

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
      // Turns refused in a row by the cache guard, 0 when the last one went
      // through. Read this instead of counting files in the dump directory:
      // that count is derived, and two readers already derived it differently.
      rewriteBlockStreak: (s as any).rewriteBlockStreak?.count ?? 0,
      rewriteBlockClass: (s as any).rewriteBlockStreak?.lastClass ?? null,
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
      handler: async () => {
        // Пара к `sessions`: сколько настоящих запросов пришло за час и сколько
        // из них безымянных. Без неё `sessions: 0` читается как «клиенты не
        // называются» ровно так же, как «через прокси ничего не шло» — сутки
        // потерянного времени у соседнего проекта и у меня (29.08.2026).
        // Полей нет вовсе, когда слежка не подписана: «не мерили» ≠ «ноль».
        const idw = identityWindow()
        return Response.json({
          ok: true,
          uptime: Math.floor(process.uptime()),
          sessions: ctx.proxyClient.sessionCount(),
          ...(idw ? { reqLastHour: idw.requests, unidentifiedLastHour: idw.unidentified, windowMin: idw.windowMin } : {}),
        })
      },
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
      handler: async () => {
        // 🔴 МЕДЛЕННЫЙ ОТВЕТ ЭТОЙ ДВЕРИ ДОЛЖЕН БЫТЬ ВИДЕН С МОЕЙ СТОРОНЫ, А НЕ
        // ТОЛЬКО СО СТОРОНЫ ЗВОНЯЩЕГО.
        //
        // Случай 02.09.2026: владелец lat-context принёс расхождение — его
        // читатель дважды за секунды получил разные ответы, и один раз счётчик
        // «не прочитался: истёк срок ожидания» (его предел — полсекунды). Своей
        // половины у меня НЕ БЫЛО ВОВСЕ: обращения сюда нигде не записывались,
        // поэтому я не мог сказать даже того, дошёл ли запрос. Замер после
        // случая: 0.25–0.84 мс на 45 сессиях, то есть в 600 раз быстрее его
        // предела — значит вопрос «что там было» остался без ответа с обеих
        // сторон сразу.
        //
        // Пишем НЕ каждое обращение (обходы ходят пачками и утопили бы журнал),
        // а только превышение порога: рост с долей миллисекунды до десятков
        // виден задолго до того, как станет чужим срывом ожидания. Ответ этой
        // двери растёт вместе с числом сессий (19 КБ на 45), так что деградация
        // ожидается именно от роста флота.
        const t0 = performance.now()
        const body = statsJson()
        const text = JSON.stringify(body)
        const ms = performance.now() - t0
        const thresholdMs = statsSlowThresholdMs()
        if (ms >= thresholdMs) {
          ctx.emit({
            level: 'info',
            kind: 'STATS_SLOW',
            sessionId: null,
            durationMs: Math.round(ms * 100) / 100,
            sessions: ctx.proxyClient.sessionCount(),
            bytes: text.length,
            thresholdMs,
            msg: `/stats took ${ms.toFixed(1)}ms (threshold ${thresholdMs}ms) at `
              + `${ctx.proxyClient.sessionCount()} sessions, ${text.length} bytes`,
          })
        }
        return new Response(text, {
          headers: { 'content-type': 'application/json', 'Cache-Control': 'no-store' },
        })
      },
    },
  ]

  return {
    name: 'health',
    routes,
    init(c) { ctx = c },
  }
}
