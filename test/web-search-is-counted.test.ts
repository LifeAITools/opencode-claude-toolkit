/**
 * Обращения модели к поиску в интернете обязаны попадать в наш учёт.
 *
 * 🔴 ЗАЧЕМ, 05.09.2026. Владелец чат-сервиса пришёл с вопросом фаундера: можно
 * ли открыть людям поиск в сети в счёт подписки. Живая проба показала, что
 * поиск через нас РАБОТАЕТ — восемь ссылок в ответе. А ответить, во что он
 * обходится, было нечем: Anthropic возвращает число поисковых обращений
 * отдельным полем `usage.server_tool_use`, и мы его не читали вовсе.
 *
 * То есть мы собирались открыть людям трату, которую не видим.
 *
 * 🔴 ВТОРОЕ ТРЕБОВАНИЕ, И ОНО ВАЖНЕЕ ПЕРВОГО: отсутствие поля остаётся
 * ОТСУТСТВИЕМ, а не нулём. Ход без поиска доказывает, что поиска не было; ход,
 * про который мы не знаем, не доказывает ничего. Ноль вместо пропуска
 * превратил бы «не мерили» в «измеренный ноль» — ошибка, которая в этом
 * проекте уже стоила ложных выводов не раз.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'websearch-'))
let seq = 0

function sse(usage: Record<string, unknown>) {
  return 'event: message_start\ndata: ' + JSON.stringify({
    type: 'message_start', message: { usage },
  }) + '\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'
}

function mkClient(events: any[], usage: Record<string, unknown>) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 3600 },
    credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response(sse(usage), {
      status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-x' },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => events.push(e) },
  } as never)
}

const body = JSON.stringify({
  model: 'claude-haiku-4-5-20251001',
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  messages: [{ role: 'user', content: 'что нового' }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
})
const done = (ev: any[]) => ev.find(e => e.kind === 'REAL_REQUEST_COMPLETE')

describe('поиск в интернете попадает в учёт', () => {
  test('модель сходила искать — число обращений записано', async () => {
    const ev: any[] = []
    const c = mkClient(ev, {
      input_tokens: 2247, output_tokens: 142,
      cache_creation_input_tokens: 7046, cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
    })
    const r = await c.handleRequest(body, {}, { sessionId: 'ws-1' })
    await r.text()
    expect(done(ev).usage.webSearchRequests).toBe(1)
    expect(done(ev).usage.webFetchRequests).toBe(0)
    await c.stop()
  })

  test('несколько поисков за ход считаются все', async () => {
    const ev: any[] = []
    const c = mkClient(ev, {
      input_tokens: 100, output_tokens: 50,
      server_tool_use: { web_search_requests: 3, web_fetch_requests: 2 },
    })
    const r = await c.handleRequest(body, {}, { sessionId: 'ws-2' })
    await r.text()
    expect(done(ev).usage.webSearchRequests).toBe(3)
    expect(done(ev).usage.webFetchRequests).toBe(2)
    await c.stop()
  })

  test('🔴 ход БЕЗ поиска не получает нуля — отсутствие остаётся отсутствием', async () => {
    const ev: any[] = []
    const c = mkClient(ev, { input_tokens: 100, output_tokens: 50 })
    const r = await c.handleRequest(body, {}, { sessionId: 'ws-3' })
    await r.text()
    const u = done(ev).usage
    expect('webSearchRequests' in u).toBe(false)
    expect('webFetchRequests' in u).toBe(false)
    await c.stop()
  })

  test('битое поле не ломает учёт и не выдумывает числа', async () => {
    const ev: any[] = []
    const c = mkClient(ev, {
      input_tokens: 100, output_tokens: 50,
      server_tool_use: { web_search_requests: 'много' },
    })
    const r = await c.handleRequest(body, {}, { sessionId: 'ws-4' })
    await r.text()
    expect('webSearchRequests' in done(ev).usage).toBe(false)
    await c.stop()
  })
})
