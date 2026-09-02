/**
 * Отказ по исчерпанной квоте обязан НАЗЫВАТЬ АККАУНТ и его долю.
 *
 * 🔴 ЧЕМ КУПЛЕНО (02.09.2026). Фаундер снял мою смену кнопкой после того, как
 * она трижды подряд получила 429. Вопрос, который задают в такую минуту, всегда
 * один: ЧЕЙ запас кончился и был ли рядом свободный аккаунт. Ответить по журналу
 * было НЕЛЬЗЯ: 105 отказов за двое суток, и ни один не нёс ни имени аккаунта, ни
 * показания счётчика — на пути прогрева событие вдобавок писало `sessionId: null`,
 * хотя вызывающее замыкание номер сессии держит.
 *
 * Ответ пришлось собирать со стороны, сверяя журнал со снимком квоты: 447 сессий
 * сидели на аккаунте с долей 0.99, пока соседний стоял на 0.27. Такая сверка
 * возможна, только пока снимок жив; через сутки от неё не остаётся ничего.
 *
 * Здесь проверяется, что отказ несёт имя аккаунта и его долю на ОБОИХ путях —
 * и на настоящем ходу, и на служебном ударе прогрева.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'rl-refusal-'))
let seq = 0

const FILLER = 'lorem ipsum dolor sit amet '.repeat(40)
const reqBody = () => JSON.stringify({
  model: 'claude-opus-4-8',
  system: [{ type: 'text', text: 'system prompt ' + FILLER, cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'do the work ' + FILLER }],
})

/** Отказ апстрима с показаниями счётчика подписки в заголовках. */
function refusal429(util5h: string, util7d: string) {
  return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-5h-utilization': util5h,
      'anthropic-ratelimit-unified-7d-utilization': util7d,
      'anthropic-ratelimit-unified-status': 'rejected',
    },
  })
}

function mkClient(fetcher: ProxyClientOptions['upstreamFetcher'], events: any[], org: string) {
  return new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
    upstreamFetcher: fetcher,
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => org, invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    eventEmitter: { emit: (e: any) => events.push(e) },
  } as never)
}

describe('отказ по квоте называет аккаунт и его долю', () => {
  test('настоящий ход: событие несёт имя обслуживающего аккаунта и обе доли', async () => {
    const events: any[] = []
    const c = mkClient({ fetch: async () => refusal429('0.99', '0.17') }, events, 'org-exhausted')

    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'ses-real' })
    expect(r.status).toBe(429)

    const ev = events.find((e) => e.kind === 'UPSTREAM_RATE_LIMITED' && e.requestKind === 'real')
    expect(ev).toBeDefined()
    expect(ev.sessionId).toBe('ses-real')
    expect(ev.org).toBe('org-exhausted')
    expect(ev.util5h).toBe(0.99)
    expect(ev.util7d).toBe(0.17)
    c.stop()
  })

  /**
   * Служебный удар шёл под `sessionId: null` — то есть самый частый источник
   * отказов в журнале нельзя было отнести ни к сессии, ни к аккаунту.
   */
  test('служебный удар: событие называет сессию, а не пустоту', async () => {
    const events: any[] = []
    const c = mkClient({ fetch: async () => refusal429('0.95', '0.31') }, events, 'org-ka')

    const gen = (c as unknown as {
      engineDoFetch: (b: unknown, h: unknown, s: unknown, id: string) => AsyncGenerator<unknown>
    }).engineDoFetch({ model: 'm', messages: [] }, {}, undefined, 'ses-ka')
    await expect((async () => { for await (const _ of gen) { /* ждём отказа */ } })()).rejects.toThrow()

    const ev = events.find((e) => e.kind === 'UPSTREAM_RATE_LIMITED' && e.requestKind === 'ka')
    expect(ev).toBeDefined()
    expect(ev.sessionId).toBe('ses-ka')
    expect(ev.org).toBe('org-ka')
    expect(ev.util5h).toBe(0.95)
    expect(ev.util7d).toBe(0.31)
    c.stop()
  })

  /**
   * Отсутствие показания обязано остаться отсутствием: выдуманный ноль читается
   * как «аккаунт свободен» и уводит разбор ровно в обратную сторону.
   */
  test('заголовков нет — доля null, а не ноль', async () => {
    const events: any[] = []
    const c = mkClient({
      fetch: async () => new Response('{}', { status: 429, headers: { 'content-type': 'application/json' } }),
    }, events, 'org-bare')

    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'ses-bare' })
    expect(r.status).toBe(429)

    const ev = events.find((e) => e.kind === 'UPSTREAM_RATE_LIMITED' && e.requestKind === 'real')
    expect(ev).toBeDefined()
    expect(ev.util5h).toBeNull()
    expect(ev.util7d).toBeNull()
    expect(ev.org).toBe('org-bare')
    c.stop()
  })
})
