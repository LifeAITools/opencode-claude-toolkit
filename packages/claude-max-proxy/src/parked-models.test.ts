/**
 * Флаг парковки: отказ обязан быть НАЗВАННЫМ, а его отсутствие — не ломать дверь.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readParkedRules, parkedReason } from './parked-models.js'

const dir = mkdtempSync(join(tmpdir(), 'parked-'))
const write = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f }

describe('парковка моделей', () => {
  test('правило по префиксу ловит семейство и объясняет причину', () => {
    const f = write('a.json', { parked: [{ prefix: 'claude-', reason: 'subscription_not_renewed', since: '2026-11-05', why: 'подписка не продлена' }] })
    const rules = readParkedRules(f, Date.now())
    expect(parkedReason('claude-haiku-4-5-20251001', rules)?.reason).toBe('subscription_not_renewed')
    expect(parkedReason('deepseek-v4.1-flash-od', rules)).toBeNull()
  })

  test('нет файла или битый — ничего не припарковано, дверь не падает', () => {
    expect(readParkedRules(join(dir, 'none.json'), Date.now() + 6000)).toEqual([])
    const bad = write('bad.json', { parked: 'nope' })
    expect(readParkedRules(bad, Date.now() + 12000)).toEqual([])
  })

  test('правило без префикса игнорируется, а не ловит всё', () => {
    const f = write('c.json', { parked: [{ reason: 'x' }, { prefix: '  ' }] })
    expect(readParkedRules(f, Date.now() + 18000)).toEqual([])
  })
})

test('cleanup', () => rmSync(dir, { recursive: true, force: true }))
