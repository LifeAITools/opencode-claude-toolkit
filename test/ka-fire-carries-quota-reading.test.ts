/**
 * Служебный удар обязан ПРИНОСИТЬ показание счётчика подписки.
 *
 * 🔴 ЧЕМ КУПЛЕНО (29.08.2026). Фаундер спросил простую вещь: тратит ли прогрев
 * недельную квоту — и попросил найти ночной час, когда агенты не работают, а
 * служебные запросы идут, и посмотреть, где счётчик сдвинулся. Ответить было
 * НЕЧЕМ: из 31 506 служебных ударов в журнале НИ ОДИН не нёс показания.
 *
 * Причина: на пути прогрева заголовки лимитов разбирались ТОЛЬКО в ветке отказа
 * 429, а успешный ответ выбрасывался целиком. Между тем ночью служебный удар —
 * единственный запрос в системе, то есть ровно тот случай, когда движение
 * счётчика не смешано с работой самого хода. Каждую ночь ответ приходил и
 * выбрасывался.
 *
 * Здесь проверяется, что успешный удар показание СНИМАЕТ.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'ka-quota-'))
const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":1,"cache_read_input_tokens":150000,"cache_creation_input_tokens":0}}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n'

let seq = 0
function mkClient(headers: Record<string, string>) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200, headers }) },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => 'org-default', invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: () => {} },
  } as never)
}

describe('служебный удар приносит показание счётчика', () => {
  test('успешный ответ — показания сняты, а не выброшены', async () => {
    const c = mkClient({
      'content-type': 'text/event-stream',
      'anthropic-ratelimit-unified-5h-utilization': '0.42',
      'anthropic-ratelimit-unified-7d-utilization': '0.27',
      'anthropic-ratelimit-unified-status': 'allowed',
    })
    const gen = (c as unknown as { engineDoFetch: (b: unknown, h: unknown) => AsyncGenerator<unknown> })
      .engineDoFetch({ model: 'm', messages: [] }, {})
    for await (const _ of gen) { /* дочитать поток до конца */ }
    expect(c.rateLimitSnapshot.utilization7d).toBe(0.27)
    expect(c.rateLimitSnapshot.utilization5h).toBe(0.42)
    c.stop()
  })

  /**
   * Ответ без заголовков не должен подсовывать выдуманное число: отсутствие
   * показания обязано остаться отсутствием — ровно та же беда, что «не мерили»
   * против «измеренный ноль».
   */
  test('заголовков нет — показание null, а не ноль', async () => {
    const c = mkClient({ 'content-type': 'text/event-stream' })
    const gen = (c as unknown as { engineDoFetch: (b: unknown, h: unknown) => AsyncGenerator<unknown> })
      .engineDoFetch({ model: 'm', messages: [] }, {})
    for await (const _ of gen) { /* дочитать поток до конца */ }
    expect(c.rateLimitSnapshot.utilization7d).toBeNull()
    c.stop()
  })
})
