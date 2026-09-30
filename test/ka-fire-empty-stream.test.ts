/**
 * Выстрел прогрева без ответа — это неудача, а не прогрев.
 *
 * 30.09.2026: 6 выстрелов из 2548 за день пришли без единого числа (вход, выхлоп, чтение и запись —
 * нули, 445 мс). Цикл выстрела пропускал событие ошибки потока и засчитывал такой выстрел прогревом:
 * часы ветки сдвигались на «только что грели», следующий ждал полчаса — и ветка 0ca417102da8
 * сессии 2bc6fa4e в 18:52:23Z купила свой кэш заново, 367 046 токенов.
 */
import { describe, expect, test } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }
const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] }

function engineWith(stream: () => AsyncGenerator<StreamEvent>) {
  let heartbeats = 0
  const e = new KeepaliveEngine({
    config: { cacheTtlMs: 3_600_000, intervalMs: 60_000, onHeartbeat: () => { heartbeats++ } },
    getToken: async () => 'tok',
    doFetch: (() => stream()) as any,
    getRateLimitInfo: () => rl,
  } as any)
  const key = e.notifyRealRequestStart('claude-opus-5', body as any, {})
  e.notifyRealRequestComplete({ inputTokens: 200_000, outputTokens: 1, cacheReadInputTokens: 0 } as any, key)
  e._setLineageRole(key, 'main')
  return { e, heartbeats: () => heartbeats }
}

describe('выстрел прогрева без ответа не засчитывается прогревом', () => {
  test('ошибка посреди потока — не прогрев', async () => {
    const { e, heartbeats } = engineWith(async function* () {
      yield { type: 'error', error: Object.assign(new Error('overloaded'), { status: 529 }) } as any
    })
    e._ageLineages(3_000_000)
    await e._tick()
    expect(heartbeats()).toBe(0)
    e.stop()
  })

  test('поток кончился без завершающего события — не прогрев', async () => {
    const { e, heartbeats } = engineWith(async function* () { /* пусто */ })
    e._ageLineages(3_000_000)
    await e._tick()
    expect(heartbeats()).toBe(0)
    e.stop()
  })

  test('обычный ответ с чтением — прогрев', async () => {
    const { e, heartbeats } = engineWith(async function* () {
      yield { type: 'message_stop', usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 200_000, cacheCreationInputTokens: 0 }, stopReason: 'end_turn' } as any
    })
    e._ageLineages(3_000_000)
    await e._tick()
    expect(heartbeats()).toBe(1)
    e.stop()
  })
})
