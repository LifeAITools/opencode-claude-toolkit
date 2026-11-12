/**
 * Регресс 11.11.2026: ранние отказы двери `/od` обязаны оставаться НАЗВАННЫМИ ответами,
 * а не превращаться в 500 со страницей исключения Bun.
 *
 * Живой случай: у флота вся модель `eco-od` отвечала 500 с
 * `ReferenceError: Cannot access 'arrivals' before initialization` — счётчик был объявлен
 * ниже `finish`, а `finish` читает его на КАЖДОМ пути, включая ранний «апстрим недоступен».
 *
 * Здесь проверяется ровно тот путь БЕЗ единого вызова модели: апстрим указывает на закрытый
 * порт, поэтому fetch падает сразу, а дверь обязана вернуть JSON 502.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenDesignDoorModule } from './modules/open-design-door.js'

const dir = mkdtempSync(join(tmpdir(), 'od-door-'))
const saved: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v }

setEnv('OPEN_DESIGN_UPSTREAM_URL', 'http://127.0.0.1:9')   // закрытый порт: fetch падает сразу
setEnv('PROVIDER_DUMP_DIR', dir)
for (let i = 1; i <= 9; i++) setEnv(`OPEN_DESIGN_API_KEY_${i}`, 'test-key')
setEnv('OPEN_DESIGN_API_KEY', 'test-key')

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('ранние отказы двери /od', () => {
  test('апстрим недоступен → 502 JSON, а не выброшенное исключение', async () => {
    const mod = createOpenDesignDoorModule()
    const events: Array<{ level: string; kind: string; msg?: string }> = []
    ;(mod as any).init({
      config: {},
      emit: (e: any) => events.push(e),
      proxyClient: { listSessions: () => [] },
    })
    const route = (mod.routes as any[]).find(r => r.path === '/od/chat/completions' && r.method === 'POST')
    expect(route).toBeTruthy()

    const req = new Request('http://127.0.0.1:5050/od/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Без `stream` — это как раз не-потоковый путь, на котором и был TDZ.
      body: JSON.stringify({ model: 'deepseek-v4.1-flash-eco-od', messages: [{ role: 'user', content: 'hi' }] }),
    })

    const res = await route.handler(req, {})
    expect(res.status).toBe(502)
    const body = await res.json() as any
    expect(body?.error?.type).toBe('upstream_error')
    // Никакой HTML-страницы Bun и никакого «Cannot access» в ответе.
    expect(JSON.stringify(body)).not.toContain('Cannot access')
    expect(events.some(e => e.kind === 'OD_ERROR')).toBe(true)
  })
})
