/**
 * Расход сессии и окон — из локальной базы opencode (session-spend.ts).
 * Тестовая база — временная (мегабайты, не боевые 3.8 ГБ): схема повторяет
 * боевую таблицу `message` (id, session_id, time_created, time_updated, data).
 */
import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultOpencodeDbPath, readSessionSpend, readWindowSpend } from './session-spend'

const openDb = (path: string) => new Database(path, { readonly: true }) as any
const H = 3600_000
const NOW = 1791265867000

function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'oc-spend-'))
  const path = join(dir, 'test.db')
  const db = new Database(path)
  db.run('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
  const put = (id: string, sid: string, t: number, data: object) =>
    db.run('INSERT INTO message VALUES (?,?,?,?,?)', [id, sid, t, t, JSON.stringify(data)])
  const asst = (input: number, output: number, reasoning: number, cost: number | null) =>
    ({ role: 'assistant', tokens: { input, output, reasoning, cache: { read: 0, write: 0 } }, ...(cost == null ? {} : { cost }) })
  put('m1', 'ses_a', NOW - 1 * H, asst(100, 10, 5, 0.001))
  put('m2', 'ses_a', NOW - 2 * H, asst(200, 20, 0, 0.002))
  put('m3', 'ses_a', NOW - 2 * H, { role: 'user', tokens: { input: 0, output: 0 } }) // чужие строки не в счёт
  put('m4', 'ses_b', NOW - 10 * H, asst(50, 5, 1, 0.0005)) // вне rolling, внутри недели
  put('m5', 'ses_b', NOW - 20 * 24 * H, asst(70, 7, 2, null)) // цена не у всех ответов
  return path
}

describe('opencode: расход сессии из базы', () => {
  test('суммы по своим ответам ассистента; валюта — USD строкой в договоре', () => {
    const s = readSessionSpend(openDb, seed(), 'ses_a', new Date(NOW))
    expect(s).toEqual({ inputTokens: 300, outputTokens: 30, reasoningTokens: 5, cost: 0.003, currency: 'USD', measuredAt: new Date(NOW).toISOString() })
  })

  test('пусто = null: чужая сессия без строк, unknown, нет базы', () => {
    const path = seed()
    expect(readSessionSpend(openDb, path, 'ses_nope', new Date(NOW))).toBeNull()
    expect(readSessionSpend(openDb, path, 'unknown', new Date(NOW))).toBeNull()
    expect(readSessionSpend(openDb, join(tmpdir(), 'oc-spend-missing.db'), 'ses_a', new Date(NOW))).toBeNull()
  })

  test('цена не у всех ответов — cost всё равно число, а не null', () => {
    const s = readSessionSpend(openDb, seed(), 'ses_b', new Date(NOW))
    expect(s?.cost).toBe(0.0005)
    expect(s?.inputTokens).toBe(120)
  })

  test('путь базы по умолчанию — база этого пользователя', () => {
    expect(defaultOpencodeDbPath()).toContain(join('.local', 'share', 'opencode', 'opencode.db'))
  })
})

describe('opencode: расход по окнам подписки', () => {
  test('rolling/weekly/monthly режут по времени; пустых окон нет — все три с расходом', () => {
    const w = readWindowSpend(openDb, seed(), NOW)!
    expect(w.map((x) => x.kind)).toEqual(['rolling', 'weekly', 'monthly'])
    const by = Object.fromEntries(w.map((x) => [x.kind, x.spent]))
    expect(by.rolling).toBe(0.003) // только ses_a
    expect(by.weekly).toBe(0.0035) // + ses_b за 10ч
    expect(by.monthly).toBe(0.0035) // m5 без цены в сумму не входит
    for (const x of w) expect(x.measuredAt).toBe(new Date(NOW).toISOString())
  })

  test('нет базы — null целиком, а не три нуля', () => {
    expect(readWindowSpend(openDb, join(tmpdir(), 'oc-spend-missing.db'), NOW)).toBeNull()
  })
})

describe('расход модели за окна Go', () => {
  test('суммы cost по модели и окнам; чужая модель не в счёт', async () => {
    const { readModelWindowSpend } = await import('./session-spend')
    const { Database } = await import('bun:sqlite')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'oc-spend-model-'))
    const path = join(dir, 't.db')
    const db = new Database(path)
    db.run('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)')
    const put = (id: string, t: number, model: string, cost: number) =>
      db.run('INSERT INTO message VALUES (?,?,?,?,?)', [id, 's', t, t, JSON.stringify({ role: 'assistant', cost, tokens: { input: 1, output: 1 }, modelID: model })])
    put('a', NOW - 3600_000, 'muse-spark-1.3-contributor', 1)
    put('b', NOW - 10 * 3600_000, 'muse-spark-1.3-contributor', 2)
    put('c', NOW - 3600_000, 'other-model', 100)
    db.close()
    const openDb = (p: string) => new Database(p, { readonly: true }) as any
    expect(readModelWindowSpend(openDb, path, 'muse-spark-1.3-contributor', NOW)).toEqual({ spend5h: 1, spendWeek: 3, spendMonth: 3 })
    expect(readModelWindowSpend(openDb, path, 'absent-model', NOW)).toEqual({ spend5h: null, spendWeek: null, spendMonth: null })
  })
})
