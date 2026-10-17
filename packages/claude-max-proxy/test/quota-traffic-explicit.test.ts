/**
 * Явное молчание трафика в quota-status.json.
 *
 * Класс «успешный ответ, который ни на что не отвечает»: пустой `accounts` из-за
 * ОТСУТСТВИЯ ТРАФИКА читался как «критично», и хук голодал до last-good суточной
 * давности (замер 17.10). Поле `traffic` говорит причину вслух.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { __testing } from '../src/quota-watcher.js'

const NOW = 1_700_000_000_000

function statsLine(tsMs: number) {
  return {
    v: 1, ts: new Date(tsMs).toISOString(), pid: 4242, type: 'stream',
    org: 'org-a', ses: 's1', rateLimit: { status: 'allowed', util5h: 0.1, util7d: 0.2 },
  }
}

describe('traffic — молчание названо, а не выдано за «критично»', () => {
  beforeEach(() => __testing.reset())

  test('трафика ещё не было — так и сказано, lastAt null', () => {
    const t = __testing.buildTraffic(NOW)
    expect(t.lastAt).toBeNull()
    expect(t.stale).toBe(true)
    expect(t.note).toContain('трафика с окнами ещё не было')
  })

  test('свежий ход — трафик свежий', () => {
    __testing.ingestStatsLine(statsLine(NOW - 60_000) as any)
    const t = __testing.buildTraffic(NOW)
    expect(t.lastAt).toBe(new Date(NOW - 60_000).toISOString())
    expect(t.stale).toBe(false)
    expect(t.note).toBe('трафик свежий')
  })

  test('ход был давно — молчание названо С ПРИЧИНОЙ и временем', () => {
    __testing.ingestStatsLine(statsLine(NOW - 40 * 60_000) as any)
    const t = __testing.buildTraffic(NOW)
    expect(t.stale).toBe(true)
    expect(t.note).toContain('ПО ПРИЧИНЕ молчания')
    expect(t.note).toContain(new Date(NOW - 40 * 60_000).toISOString())
  })

  test('строка БЕЗ окон не считается трафиком (KA-выстрел)', () => {
    __testing.ingestStatsLine({
      v: 1, ts: new Date(NOW - 1000).toISOString(), pid: 4242, type: 'stream',
      org: 'org-a', ses: 's1', rateLimit: { status: 'allowed' },
    } as any)
    expect(__testing.buildTraffic(NOW).lastAt).toBeNull()
  })
})
