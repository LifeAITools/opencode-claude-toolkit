/**
 * Медленный ответ двери /stats обязан быть виден С МОЕЙ СТОРОНЫ.
 *
 * 🔴 ЧЕМ КУПЛЕНО (02.09.2026). Владелец lat-context принёс расхождение: его
 * читатель дважды за секунды получил разные ответы, и один раз счётчик «не
 * прочитался: истёк срок ожидания» — его предел полсекунды. Своей половины
 * замера у меня НЕ БЫЛО ВОВСЕ: обращения к этой двери нигде не записывались,
 * поэтому я не мог сказать даже того, дошёл ли запрос до меня.
 *
 * Проверка после случая дала 0.25–0.84 мс на 45 сессиях — в 600 раз быстрее его
 * предела. То есть вопрос «что там было» остался без ответа с обеих сторон
 * сразу: он видел таймаут, я не видел ничего.
 *
 * Здесь проверяется, что дверь теперь сама говорит о своей медлительности —
 * и что при норме она молчит, а не сорит в журнал на каждом обходе.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createHealthModule } from '../src/modules/health.js'

function mkCtx(events: any[], sessionCount = 3) {
  return {
    emit: (e: any) => events.push(e),
    config: { logLevel: 'info', kaIntervalSec: 1800, kaRewriteBlockEnabled: true },
    proxyClient: {
      sessionCount: () => sessionCount,
      listSessions: () => Array.from({ length: sessionCount }, (_, i) => ({
        sessionId: `ses-${i}`,
        pid: 100 + i,
        firstSeenAt: 0,
        lastRequestAt: 0,
        model: 'claude-opus-5',
        lastUsage: null,
        engine: null,
      })),
      rateLimitSnapshot: { status: null, resetAt: null, claim: null, retryAfter: null, utilization5h: null, utilization7d: null },
      cacheMetricsSnapshot: {},
    },
    managedSessions: {},
    version: '1.0.81-test',
  } as never
}

const OPTS = {
  mode: 'global' as const,
  parentPid: 0,
  port: 5050,
  host: '127.0.0.1',
  discoveryFile: null,
  moduleStatus: { loaded: [], failed: [] },
}

function statsHandler(mod: ReturnType<typeof createHealthModule>) {
  const r = mod.routes.find((x) => x.path === '/stats')!
  return r.handler
}

const ENV_KEY = 'CLAUDE_MAX_STATS_SLOW_MS'
let saved: string | undefined
beforeEach(() => { saved = process.env[ENV_KEY] })
afterEach(() => { if (saved === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = saved })

describe('дверь /stats сама говорит, когда отвечает медленно', () => {
  test('порог превышен — событие с длительностью, числом сессий и размером ответа', async () => {
    process.env[ENV_KEY] = '0'          // писать любое обращение
    const events: any[] = []
    const mod = createHealthModule(OPTS)
    mod.init!(mkCtx(events, 7))

    const res = await statsHandler(mod)(new Request('http://x/stats'), {} as never)
    expect(res.status).toBe(200)

    const slow = events.find((e) => e.kind === 'STATS_SLOW')
    expect(slow).toBeDefined()
    expect(slow.sessions).toBe(7)
    expect(slow.bytes).toBeGreaterThan(0)
    expect(typeof slow.durationMs).toBe('number')
    expect(slow.thresholdMs).toBe(0)
  })

  /**
   * Обходы соседей ходят пачками по три вызова на дверь. Событие на КАЖДОЕ
   * обращение утопило бы журнал ровно в тот день, когда он понадобится.
   */
  test('норма — журнал молчит', async () => {
    process.env[ENV_KEY] = '10000'      // порог заведомо недостижимый
    const events: any[] = []
    const mod = createHealthModule(OPTS)
    mod.init!(mkCtx(events, 3))

    await statsHandler(mod)(new Request('http://x/stats'), {} as never)
    expect(events.find((e) => e.kind === 'STATS_SLOW')).toBeUndefined()
  })

  test('ответ остаётся тем же JSON и не кэшируется', async () => {
    process.env[ENV_KEY] = '10000'
    const events: any[] = []
    const mod = createHealthModule(OPTS)
    mod.init!(mkCtx(events, 2))

    const res = await statsHandler(mod)(new Request('http://x/stats'), {} as never)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as any
    expect(body.sessions.length).toBe(2)
    expect(body.proxy.version).toBe('1.0.81-test')
  })
})
