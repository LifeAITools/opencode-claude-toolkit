/**
 * Регресс 12.11.2026: поставщик OpenDesign, который ПЕРЕСТАЛ ОТВЕЧАТЬ, не имеет права
 * держать место (слот) бесконечно.
 *
 * Живой случай: в 14:20–14:21Z семь вызовов на relishev@gmail.com ушли к поставщику и не
 * вернулись — ни ответа, ни обрыва, ни строки в журнале. `fetch` без предела ждал вечно,
 * слоты не освобождались, и следующие два часа КАЖДЫЙ вызов на этот аккаунт получал
 * «Slot guard: all 8 slots are busy» (79 отказов в 15-м часу, ни одного ответа 200),
 * хотя повторяли их всего четыре сессии. Счётчик мест был верен; лгал вечный вызов.
 *
 * Здесь — два пути, оба без единого вызова модели: местный сервер, который (1) не шлёт
 * заголовков вовсе и (2) шлёт один кусок потока и замолкает.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenDesignDoorModule, odSlotSnapshot, resetOdSlotsForTest } from './modules/open-design-door.js'

const dir = mkdtempSync(join(tmpdir(), 'od-timeout-'))
const saved: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v }

// Сервер-молчун: /silent не отвечает никогда, /stall шлёт один кусок и замолкает.
const hold: Array<() => void> = []
const server = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/silent')) {
      return new Promise<Response>(resolve => { hold.push(() => resolve(new Response('late'))) })
    }
    return new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'))
        hold.push(() => { try { c.close() } catch { /* уже закрыт */ } })
      },
    }), { headers: { 'content-type': 'text/event-stream' } })
  },
})

setEnv('PROVIDER_DUMP_DIR', dir)
setEnv('OD_UPSTREAM_HEADERS_TIMEOUT_MS', '300')
setEnv('OD_UPSTREAM_IDLE_TIMEOUT_MS', '300')
for (let i = 1; i <= 9; i++) setEnv(`OPEN_DESIGN_API_KEY_${i}`, 'test-key')
setEnv('OPEN_DESIGN_API_KEY', 'test-key')

afterAll(() => {
  for (const h of hold) h()
  server.stop(true)
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

function door(upstreamPath: string) {
  process.env.OPEN_DESIGN_UPSTREAM_URL = `http://127.0.0.1:${server.port}${upstreamPath}`
  const mod = createOpenDesignDoorModule()
  const events: Array<{ level: string; kind: string; msg?: string }> = []
  ;(mod as any).init({ config: {}, emit: (e: any) => events.push(e), proxyClient: { listSessions: () => [] } })
  const route = (mod.routes as any[]).find(r => r.path === '/od/chat/completions')
  return { route, events }
}

const inFlightTotal = () =>
  Object.values(odSlotSnapshot().accounts).reduce((n, a) => n + a.inFlight, 0)

describe('поставщик OpenDesign молчит — слот обязан вернуться', () => {
  test('нет даже заголовков → названный 504 за предел ожидания, слот свободен', async () => {
    resetOdSlotsForTest()
    const { route, events } = door('/silent')
    const t0 = Date.now()
    const res = await route.handler(new Request('http://x/od/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-eco-od', messages: [{ role: 'user', content: 'hi' }] }),
    }), {})
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(res.status).toBe(504)
    const body = await res.json() as any
    expect(body?.error?.type).toBe('upstream_timeout')
    expect(inFlightTotal()).toBe(0)
    expect(events.some(e => e.kind === 'OD_ERROR' && /не ответил/.test(e.msg ?? ''))).toBe(true)
  })

  test('поток замолк посередине → поток закрыт ошибкой, слот свободен', async () => {
    resetOdSlotsForTest()
    const { route, events } = door('/stall')
    const res = await route.handler(new Request('http://x/od/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-eco-od', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }), {})
    expect(res.status).toBe(200)
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    const first = await reader.read()
    expect(first.done).toBe(false)
    expect(inFlightTotal()).toBe(1)          // пока идёт поток — место честно занято
    let failed = false
    try { await reader.read() } catch { failed = true }
    expect(failed).toBe(true)
    expect(inFlightTotal()).toBe(0)
    expect(events.some(e => e.kind === 'OD_ABORTED' && /молчит/.test(e.msg ?? ''))).toBe(true)
  })
})
