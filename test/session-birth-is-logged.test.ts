/**
 * Рождение сессии обязано попасть в журнал — вместе с тем, кто её завёл.
 *
 * 🔴 ЭТОТ НАБОР КУПЛЕН СОБСТВЕННОЙ ОШИБКОЙ, И ОНА СТОИТ ТОГО, ЧТОБЫ ЕЁ ОПИСАТЬ.
 * Паспорт владельца сперва написали в SessionTracker пакета прокси — рядом с
 * готовым событием SESSION_TRACKED, что выглядело очевидно правильным. Выкатка
 * прошла зелёной, испытания прошли, а работать не стало ничего: живой прокси
 * создаёт сессии ДРУГИМ путём (InMemorySessionStore), и то событие не эмитилось
 * НИ РАЗУ за всю жизнь журнала — ровно ноль записей, проверено 04.09.2026.
 *
 * Поймала это не проверка кода, а живая проба: запрос с новым именем сессии,
 * после которого в журнале не нашлось ничего. Отсюда правило, которое эти
 * испытания и закрепляют: событие проверяется на ТОМ пути, которым ходит живой
 * запрос, а не там, где его удобнее написать.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'birth-'))
let seq = 0

function mkClient(events: any[]) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 3600 },
    credentialsProvider: { getAccessToken: async () => 'tok', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response(
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-x' },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => events.push(e) },
  } as never)
}

const body = JSON.stringify({
  model: 'claude-opus-5',
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  tools: [],
  messages: [{ role: 'user', content: 'работай' }],
})
const birth = (ev: any[]) => ev.filter(e => e.kind === 'SESSION_TRACKED')

describe('рождение сессии видно в журнале', () => {
  test('первый ход новой сессии пишет паспорт владельца', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r = await c.handleRequest(body, {}, { sessionId: 'born-1', sourcePid: process.pid })
    await r.text()
    const e = birth(ev)[0]
    expect(e).toBeTruthy()
    expect(e.pid).toBe(process.pid)
    expect(e.ownerName).toBeTruthy()
    expect(e.ownerCwd).toBe(process.cwd())
    expect(e.ownerParentName).toBeTruthy()
    await c.stop()
  })

  test('второй ход той же сессии паспорт НЕ повторяет', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r1 = await c.handleRequest(body, {}, { sessionId: 'born-2', sourcePid: process.pid })
    await r1.text()
    const r2 = await c.handleRequest(body, {}, { sessionId: 'born-2', sourcePid: process.pid })
    await r2.text()
    expect(birth(ev).length).toBe(1)
    await c.stop()
  })

  test('владельца нет — сказано ПОЧЕМУ и назван клиент', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r = await c.handleRequest(body, {}, {
      sessionId: 'born-3', sourcePid: null, clientUserAgent: 'some-server/2.1',
    })
    await r.text()
    const e = birth(ev)[0]
    expect(e.ownerUnresolved).toBe('номер процесса не разрешён')
    expect(e.clientUserAgent).toBe('some-server/2.1')
    expect(e.msg).toContain('НЕ ОПОЗНАН')
    await c.stop()
  })
})
