/**
 * Дитя под-агента — не голос агента (живой случай 10.11.2026).
 *
 * Проверяем РАСПОЗНАНИЕ, а не привязку: привязка живёт в замыкании plugin.ts и требует
 * настоящего движка. Но именно распознавание решает всё — пока дитя не опознано как дитя,
 * `bindSession` привязывал его и открывал ему свой слот `-ses_<child>.json`.
 *
 * Три написания нарочно: `session.list` даёт parentID, `session.get` — parent_id,
 * события несут parentID.
 */
import { describe, expect, test } from 'bun:test'
import { isChildSession } from './wake-listener'

describe('isChildSession', () => {
  test('родитель в любом написании → дитя', () => {
    expect(isChildSession({ parentID: 'ses_parent' })).toBe(true)
    expect(isChildSession({ parent_id: 'ses_parent' })).toBe(true)
    expect(isChildSession({ parentId: 'ses_parent' })).toBe(true)
  })

  test('нет родителя / пусто → не дитя', () => {
    expect(isChildSession({})).toBe(false)
    expect(isChildSession({ parentID: null })).toBe(false)
    expect(isChildSession({ parent_id: '' })).toBe(false)
    expect(isChildSession(null)).toBe(false)
    expect(isChildSession(undefined)).toBe(false)
  })
})
