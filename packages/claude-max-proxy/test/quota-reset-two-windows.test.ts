/**
 * quota-watcher — два окна сброса, два поля, и оба в ISO.
 *
 * Anthropic шлёт две РАЗНЫЕ отметки: `anthropic-ratelimit-unified-5h-reset` и
 * `…-7d-reset`. SDK читает обе (`proxy-client.ts` — `resetAt` и `resetAt7d`), а
 * дальше по цепи недельная терялась: во всём `claude-max-proxy/src/` слова
 * `resetAt7d` не было ни разу, и потребитель видел одно время вместо двух.
 *
 * Что закрепляют эти тесты:
 *
 *   ДВА ПОЛЯ, А НЕ ОДНО. Замер 2026-08-17: в один и тот же миг пятичасовое окно
 *   сбрасывалось через 13 минут, а семидневное — через 142 часа. Совпадение
 *   обоих заголовков в логе говорит лишь о том, что один источник кладёт одно
 *   значение в оба, а не о том, что окна идут вместе.
 *
 *   ISO, А НЕ ГОЛОЕ ЧИСЛО. Одна и та же отметка едет секундами там, где её шлёт
 *   Anthropic, и миллисекундами после этого коллектора. Угадывание по величине
 *   уже напечатало однажды «год 58598», поэтому конверсия живёт здесь — там, где
 *   единица известна, — а наружу идёт строка, у которой единиц нет.
 *
 *   ПЕРЕНОС ОТДЕЛЬНЫЙ ДЛЯ КАЖДОГО ОКНА. Заголовок приходит не на каждом ответе,
 *   а окно от этого идти не перестаёт. Одна общая запись истекала бы по более
 *   раннему из двух сроков и уносила бы ещё живое недельное ожидание.
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { __testing } from '../src/quota-watcher.js'

const PID = 4242
const ORG = 'a1b2c3d4-0000-4000-8000-000000000001'

/** Секунды — ровно так, как их отдаёт эмиттер (и как их шлёт Anthropic). */
function line(opts: {
  ts: number
  resetAtSec?: number | null
  resetAt7dSec?: number | null
}) {
  const rl: Record<string, unknown> = { status: 'allowed', util5h: 0.5, util7d: 0.8 }
  if (opts.resetAtSec != null) rl.resetAt = opts.resetAtSec
  if (opts.resetAt7dSec != null) rl.resetAt7d = opts.resetAt7dSec
  return {
    v: 1,
    ts: new Date(opts.ts).toISOString(),
    pid: PID,
    type: 'stream' as const,
    org: ORG,
    ses: 'ses-1',
    rateLimit: rl,
  }
}

describe('quota-watcher — два окна сброса', () => {
  beforeEach(() => __testing.reset())

  test('обе отметки доезжают наружу, и каждая своя', () => {
    const now = Date.now()
    const in13min = Math.floor((now + 13 * 60_000) / 1000)
    const in142h = Math.floor((now + 142 * 3600_000) / 1000)

    __testing.ingestStatsLine(line({ ts: now, resetAtSec: in13min, resetAt7dSec: in142h }))

    const acc = __testing.snapshot().accounts[ORG]
    expect(acc.reset5hAt).toBe(new Date(in13min * 1000).toISOString())
    expect(acc.reset7dAt).toBe(new Date(in142h * 1000).toISOString())
    // Именно РАЗНЫЕ — ради этого всё и делалось.
    expect(acc.reset5hAt).not.toBe(acc.reset7dAt)
  })

  test('наружу идёт ISO, а не число — потребителю не приходится гадать единицу', () => {
    const now = Date.now()
    const sec = Math.floor((now + 3600_000) / 1000)
    __testing.ingestStatsLine(line({ ts: now, resetAtSec: sec, resetAt7dSec: sec }))

    const acc = __testing.snapshot().accounts[ORG]
    expect(typeof acc.reset5hAt).toBe('string')
    expect(acc.reset5hAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Прежнее поле в миллисекундах остаётся — его уже читают, ломать нельзя.
    expect(acc.resetAt).toBe(sec * 1000)
  })

  test('нет отметки — null, а не эпоха и не выдуманное время', () => {
    __testing.ingestStatsLine(line({ ts: Date.now() }))
    const acc = __testing.snapshot().accounts[ORG]
    expect(acc.reset5hAt).toBeNull()
    expect(acc.reset7dAt).toBeNull()
  })

  test('недельная отметка переносится на ответы, где заголовка не было', () => {
    const now = Date.now()
    const in142h = Math.floor((now + 142 * 3600_000) / 1000)

    __testing.ingestStatsLine(line({ ts: now, resetAt7dSec: in142h }))
    // Следующий ответ пришёл БЕЗ заголовков сброса — окно от этого не кончилось.
    __testing.ingestStatsLine(line({ ts: now + 1000 }))

    const acc = __testing.snapshot().accounts[ORG]
    expect(acc.reset7dAt).toBe(new Date(in142h * 1000).toISOString())
  })

  test('истёкшая пятичасовая отметка не уносит с собой живую недельную', () => {
    const now = Date.now()
    const past5h = Math.floor((now - 60_000) / 1000)      // уже прошла
    const in142h = Math.floor((now + 142 * 3600_000) / 1000) // ещё идёт

    __testing.ingestStatsLine(line({ ts: now, resetAtSec: past5h, resetAt7dSec: in142h }))
    __testing.ingestStatsLine(line({ ts: now + 1000 }))   // без заголовков

    const acc = __testing.snapshot().accounts[ORG]
    expect(acc.reset5hAt).toBeNull()
    expect(acc.reset7dAt).toBe(new Date(in142h * 1000).toISOString())
  })
})
