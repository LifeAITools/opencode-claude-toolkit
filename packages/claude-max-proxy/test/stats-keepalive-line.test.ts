/**
 * Прогрев обязан попадать в журнал статистики (research/quota-billable-actions-2026-11.md:
 * 0 из 6 739 прогревов доезжало, хотя прогрев платный по цене чтения кэша).
 * Причина была в имени поля: событие прогрева несёт сырой снимок `utilization5h/7d`.
 */
import { describe, test, expect } from 'bun:test'
import { buildStatsLine } from '../src/stats-emitter.js'

const base = {
  ts: '2026-11-12T12:00:00.000Z', sessionId: 's1', org: 'org-x', model: 'claude-opus-5-5',
  usage: { inputTokens: 2, outputTokens: 1, cacheReadInputTokens: 584114, cacheCreationInputTokens: 0 },
}

describe('buildStatsLine', () => {
  test('прогрев с сырым снимком utilization5h — строка типа keepalive с квотой', () => {
    const line = buildStatsLine({
      ...base, kind: 'KA_FIRE_COMPLETE', level: 'info',
      rateLimit: { status: 'allowed', claim: 'five_hour', resetAt: 1794494400, utilization5h: 0.29, utilization7d: 0.04 },
    } as any)
    expect(line).not.toBeNull()
    expect(line!.type).toBe('keepalive')
    expect(line!.rateLimit.util5h).toBe(0.29)
    expect(line!.rateLimit.util7d).toBe(0.04)
    expect(line!.usage.cacheRead).toBe(584114)
  })

  test('обычный ход — тип stream, поля util5h как прежде', () => {
    const line = buildStatsLine({
      ...base, kind: 'REAL_REQUEST_COMPLETE', level: 'info',
      rateLimit: { status: 'allowed', util5h: 0.5, util7d: 0.1, resetAt: 1794494400 },
    } as any)
    expect(line!.type).toBe('stream')
    expect(line!.rateLimit.util5h).toBe(0.5)
  })

  test('нет квоты ни по одному окну — строки нет (не ноль)', () => {
    expect(buildStatsLine({ ...base, kind: 'KA_FIRE_COMPLETE', level: 'info', rateLimit: {} } as any)).toBeNull()
  })
})
