import { describe, test, expect } from 'bun:test'
import { SubscriptionCountersPolicy, type WarmContext } from '../src/warm-policy.js'

const base = (o: Partial<WarmContext> = {}, c: Partial<WarmContext['cadence']> = {}): WarmContext => ({
  provider: 'anthropic', orgId: null, sessionId: null,
  idleMs: 0, cacheAgeMs: 0, realIdleMs: 0, ttlMs: 3_600_000,
  cadence: { fireThresholdMs: 1_620_000, safetyMarginMs: 15_000, tickMs: 30_000, idleTimeoutMs: Infinity, ...c },
  ...o,
})
const p = new SubscriptionCountersPolicy()

describe('SubscriptionCountersPolicy (поведение движка до вынесения, слово в слово)', () => {
  test('не пора, пока простой меньше порога', () => {
    expect(p.decide(base({ idleMs: 1_000_000 }))).toEqual({ fire: false, release: false, reason: 'not_due' })
  })
  test('пора на пороге и после', () => {
    expect(p.decide(base({ idleMs: 1_620_000 })).fire).toBe(true)
  })
  test('короткий срок ветки приближает момент: min(порог, ttl − запас − тик)', () => {
    // ttl 5 мин: 300000−15000−30000 = 255000 < порога 1620000
    expect(p.decide(base({ ttlMs: 300_000, idleMs: 255_000 })).fire).toBe(true)
    expect(p.decide(base({ ttlMs: 300_000, idleMs: 254_999 })).fire).toBe(false)
  })
  test('мёртвый кэш: возраст >= ttl − запас → снять, не стрелять', () => {
    const d = p.decide(base({ cacheAgeMs: 3_600_000 - 15_000, idleMs: 9_999_999 }))
    expect(d).toEqual({ fire: false, release: true, reason: 'cache_dead' })
  })
  test('возраст неизвестен (<=0) — не нам решать, что мёртв', () => {
    expect(p.decide(base({ cacheAgeMs: 0, idleMs: 9_999_999 })).fire).toBe(true)
  })
  test('простой настоящей работы: умолчание Infinity — никогда не отпускать (рельс 29.08)', () => {
    expect(p.decide(base({ realIdleMs: 9e12, idleMs: 9_999_999 })).fire).toBe(true)
  })
  test('заданный явно срок простоя отпускает разговор', () => {
    const d = p.decide(base({ realIdleMs: 2_000_000, idleMs: 9_999_999 }, { idleTimeoutMs: 1_000_000 }))
    expect(d).toEqual({ fire: false, release: true, reason: 'idle_timeout' })
  })
  test('в политике нет ни одной цены API (рельс ka-subscription-not-api)', async () => {
    const src = await Bun.file(new URL('../src/warm-policy.ts', import.meta.url)).text()
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(code).not.toMatch(/1\.25|0\.1\b|p_read|p_in|cost|price/i)
  })
})
