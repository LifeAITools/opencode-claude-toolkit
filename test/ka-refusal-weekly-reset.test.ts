/**
 * Отказ прогреву обязан нести время возврата ТОГО окна, которое отказало.
 *
 * 🔴 ЧЕМ КУПЛЕНО (01.10.2026). Ночью у аккаунта 02b4bfd1 кончился НЕДЕЛЬНЫЙ запас
 * (util7d 1.00 в 02:49Z), пятичасовой при этом стоял на 0.12. Апстрим сказал это
 * прямо: retry-after 501 012 с, недельный сброс через 5.8 суток. А прокси приложил к
 * ошибке время сброса ПЯТИЧАСОВОГО окна (03:40Z, через 50 минут) — и прогрев, сравнив
 * его со сроком кэша, решил «запас вернётся раньше, чем кэш умрёт»: встал на паузу
 * до 03:40, проснулся, снова получил 429 и только потом отпустил ветки. Правильное
 * решение было сразу: запас вернётся через 5.8 суток, кэш столько не живёт —
 * разоружиться (quota_outlives_cache).
 *
 * Правило: время возврата — самое позднее из (сброс каждого окна, дошедшего до 1.0;
 * retry-after апстрима). Ни одно окно не исчерпано и retry-after нет — прежнее
 * поведение (пятичасовой сброс).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProxyClient, quotaReturnsAtSec, type ProxyClientOptions } from '../src/proxy-client.js'

const TMP = mkdtempSync(join(tmpdir(), 'ka-weekly-'))

const NOW = 1790826000 - 3013          // 02:49:47Z 01.10 — момент живого отказа
const RESET_5H = 1790826000            // 03:40Z
const RESET_7D = 1791324000            // 10-06T22:00Z

/** Ровно те показания, что пришли с живым отказом 02:49:47Z. */
function weeklyRefusal(): Response {
  return new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
    status: 429,
    headers: {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
      'anthropic-ratelimit-unified-5h-utilization': '0.12',
      'anthropic-ratelimit-unified-5h-reset': String(RESET_5H),
      'anthropic-ratelimit-unified-7d-utilization': '1',
      'anthropic-ratelimit-unified-7d-reset': String(RESET_7D),
      'anthropic-ratelimit-unified-representative-claim': 'seven_day',
      'retry-after': '501012',
    },
  })
}

describe('время возврата запаса — по окну, которое отказало', () => {
  test('исчерпана неделя: возврат по недельному сбросу, а не через 50 минут', () => {
    expect(quotaReturnsAtSec({
      resetAt: RESET_5H, resetAt7d: RESET_7D, utilization5h: 0.12, utilization7d: 1, retryAfter: null,
    }, NOW)).toBe(RESET_7D)
  })

  test('retry-after апстрима позже всех сбросов — берётся он', () => {
    expect(quotaReturnsAtSec({
      resetAt: RESET_5H, resetAt7d: RESET_7D, utilization5h: 0.12, utilization7d: 1, retryAfter: 600_000,
    }, NOW)).toBe(NOW + 600_000)
  })

  test('исчерпаны оба окна — самое позднее', () => {
    expect(quotaReturnsAtSec({
      resetAt: RESET_5H, resetAt7d: RESET_7D, utilization5h: 1, utilization7d: 1, retryAfter: null,
    }, NOW)).toBe(RESET_7D)
  })

  test('исчерпано пятичасовое — как раньше, пятичасовой сброс', () => {
    expect(quotaReturnsAtSec({
      resetAt: RESET_5H, resetAt7d: RESET_7D, utilization5h: 1, utilization7d: 0.4, retryAfter: null,
    }, NOW)).toBe(RESET_5H)
  })

  test('ни одно окно не на пределе и retry-after нет — прежнее поведение', () => {
    expect(quotaReturnsAtSec({
      resetAt: RESET_5H, resetAt7d: RESET_7D, utilization5h: 0.5, utilization7d: 0.5, retryAfter: null,
    }, NOW)).toBe(RESET_5H)
    expect(quotaReturnsAtSec({
      resetAt: null, resetAt7d: null, utilization5h: null, utilization7d: null, retryAfter: null,
    }, NOW)).toBeNull()
  })

  test('🔴 провод: ошибка прогрева несёт недельный сброс', async () => {
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1 },
      credentialsProvider: { getAccessToken: async () => 'fake-token', invalidate() {} },
      upstreamFetcher: { fetch: async () => weeklyRefusal() } as ProxyClientOptions['upstreamFetcher'],
      prefixHistoryPath: join(TMP, 'ph.json'),
      orgIdResolver: { current: () => 'org-weekly', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'),
      proxyStartedAt: 0,
      eventEmitter: { emit: () => {} },
    } as never)
    const gen = (c as unknown as {
      engineDoFetch: (b: unknown, h: unknown, s: unknown, id: string) => AsyncGenerator<unknown>
    }).engineDoFetch({ model: 'm', messages: [] }, {}, undefined, 'ses-weekly')
    let caught: any = null
    try { for await (const _ of gen) { /* ждём отказа */ } } catch (e) { caught = e }
    expect(caught?.status).toBe(429)
    // retry-after (501 012 с от «сейчас») позже недельного сброса на секунды — допускаем оба,
    // но НИКАК не пятичасовой сброс.
    expect(caught.resetAt).toBeGreaterThanOrEqual(RESET_7D - 60)
    expect(caught.resetAt).not.toBe(RESET_5H)
    c.stop()
  })
})
