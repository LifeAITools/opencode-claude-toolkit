/**
 * Сессия, чей владелец не опознан, обязана хотя бы НАЗВАТЬ СВОЕГО КЛИЕНТА.
 *
 * 🔴 ЗАМЕР 04.09.2026. Номер процесса служба находит по сетевому порту, разбирая
 * /proc: клиент с этой машины опознаётся, пришедший иначе — нет. Такая сессия не
 * считается мёртвой НИКОГДА (proxy-adapters: pid === null → isOwnerAlive = true)
 * и греется, пока её не выметет по возрасту.
 *
 * В тот день таких нашлось семь: 616 служебных выстрелов, 5,3 млн чтения, и
 * ЧЕТЫРЕ из семи за сутки не сделали ни одного настоящего хода. Опознать их было
 * нечем — только шестнадцатеричное имя сессии. Вопрос фаундера дословно:
 * «логируем, кто это был, кто их вызывал, или ещё что-то полезное, чтобы потом
 * идентифицировать».
 *
 * Поле пишется ТОЛЬКО когда номер процесса не разрешён: у наших агентов он есть,
 * и журнал не растёт ради строки, которая всегда одинаковая.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'owner-named-'))
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

const started = (ev: any[]) => ev.find(e => e.kind === 'REAL_REQUEST_START')

describe('владелец не опознан — назови хотя бы клиента', () => {
  test('без номера процесса в записи появляется имя клиента и признак', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r = await c.handleRequest(body, {}, {
      sessionId: 'no-pid-1', sourcePid: null, clientUserAgent: 'some-server/2.1',
    })
    await r.text()
    const e = started(ev)
    expect(e.pidUnresolved).toBe(true)
    expect(e.clientUserAgent).toBe('some-server/2.1')
    await c.stop()
  })

  test('клиент не назвался — пишем это честно, а не выдумываем', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r = await c.handleRequest(body, {}, { sessionId: 'no-pid-2', sourcePid: null })
    await r.text()
    const e = started(ev)
    expect(e.pidUnresolved).toBe(true)
    expect(e.clientUserAgent).toBeNull()
    await c.stop()
  })

  test('номер процесса есть — полей НЕТ вовсе, журнал не растёт зря', async () => {
    const ev: any[] = []
    const c = mkClient(ev)
    const r = await c.handleRequest(body, {}, {
      sessionId: 'has-pid', sourcePid: 4242, clientUserAgent: 'claude-cli/1.0',
    })
    await r.text()
    const e = started(ev)
    expect('pidUnresolved' in e).toBe(false)
    expect('clientUserAgent' in e).toBe(false)
    await c.stop()
  })
})
