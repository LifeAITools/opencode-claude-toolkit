/**
 * Прогрев не вооружился — обязан сказать, ПОЧЕМУ.
 *
 * 🔴 ПРОСЬБА ФАУНДЕРА 04.09.2026, дословно: «если вдруг мы по какой-то причине
 * не смогли что-то опознать — надо логировать вообще все случаи, чтобы сразу
 * было понятно, что пошло не так». Повод был конкретный: двенадцать сессий
 * стояли невооружёнными, и почему — не говорил никто.
 *
 * Молчание тут дороже шума. Сессия просто не греется, снаружи это неотличимо
 * от исправной работы, а платит за это её следующий настоящий ход — полной
 * перепокупкой разговора.
 *
 * Второе требование, ради которого всё и сделано ОДИН РАЗ НА ПРИЧИНУ: у мелких
 * служебных сессий ходов бывают сотни, и запись на каждый превратила бы журнал
 * в шум, из-за которого выключают всё разом.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const rl: RateLimitInfo = { status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }
const body = () => ({ system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] })

function mkEngine(said: any[], minTokens = 2000) {
  return new KeepaliveEngine({
    config: {
      cacheTtlMs: 3_600_000, intervalMs: 60_000, minTokens,
      onNotArmed: (i) => said.push(i),
    },
    getToken: async () => 'tok',
    doFetch: async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } as any
    },
    getRateLimitInfo: () => rl,
  })
}

describe('прогрев молчал — теперь называет причину', () => {
  test('ход не дотянул до порога — сказано сколько весил и каков порог', () => {
    const said: any[] = []
    const e = mkEngine(said)
    const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
    e.notifyRealRequestComplete({ inputTokens: 500, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
    expect(said).toHaveLength(1)
    expect(said[0].reason).toBe('too_small')
    expect(said[0].detail).toContain('500')
    expect(said[0].detail).toContain('2000')
    e.stop()
  })

  test('одна и та же причина не повторяется — иначе журнал превращается в шум', () => {
    const said: any[] = []
    const e = mkEngine(said)
    for (let i = 0; i < 5; i++) {
      const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
      e.notifyRealRequestComplete({ inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 0 } as any, key)
    }
    expect(said).toHaveLength(1)
    e.stop()
  })

  test('завершение без начала хода — сказано, что греть нечего и почему', () => {
    const said: any[] = []
    const e = mkEngine(said)
    // Никакого notifyRealRequestStart — сразу завершение.
    e.notifyRealRequestComplete({ inputTokens: 300_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, 'нет:такого')
    expect(said.some(x => x.reason === 'no_pending_snapshot')).toBe(true)
    e.stop()
  })

  test('нормальный ход молчит — запись только про беду', () => {
    const said: any[] = []
    const e = mkEngine(said)
    const key = e.notifyRealRequestStart('claude-opus-5', body() as any, {})
    e.notifyRealRequestComplete({ inputTokens: 300_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
    expect(said).toHaveLength(0)
    e.stop()
  })
})
