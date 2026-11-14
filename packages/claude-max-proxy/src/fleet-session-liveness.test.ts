import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fleetSessionLiveness, FLEET_SESSIONS_MAX_AGE_MS } from './fleet-session-liveness.js'

const dir = mkdtempSync(join(tmpdir(), 'fleet-live-'))
const doc = { 'dsh-a-01': { sessionId: 'session-aaa', at: '2026-11-14T07:55:12Z', role: 'a' }, 'dsh-b-01': { sessionId: 'session-bbb' } }

describe('жизнь сессии флота по его списку текущих сессий', () => {
  test('текущая сессия агента — жива; чужая — «не знаю», не «мертва»', () => {
    const p = join(dir, 'f1.json'); writeFileSync(p, JSON.stringify(doc))
    const live = fleetSessionLiveness(p)
    expect(live('session-aaa')).toBe(true)
    expect(live('session-zzz')).toBeUndefined()
  })

  test('нет файла — «не знаю»', () => {
    expect(fleetSessionLiveness(join(dir, 'none.json'))('session-aaa')).toBeUndefined()
  })

  test('файл старше суток — не опора', () => {
    const p = join(dir, 'f2.json'); writeFileSync(p, JSON.stringify(doc))
    const old = (Date.now() - FLEET_SESSIONS_MAX_AGE_MS - 60_000) / 1000
    utimesSync(p, old, old)
    expect(fleetSessionLiveness(p)('session-aaa')).toBeUndefined()
  })

  test('флот сменил сессию агента — старая перестаёт числиться живой', () => {
    const p = join(dir, 'f3.json'); writeFileSync(p, JSON.stringify(doc))
    const live = fleetSessionLiveness(p)
    expect(live('session-aaa')).toBe(true)
    writeFileSync(p, JSON.stringify({ 'dsh-a-01': { sessionId: 'session-new' } }))
    const t = Date.now() / 1000 + 5; utimesSync(p, t, t)
    expect(live('session-aaa')).toBeUndefined()
    expect(live('session-new')).toBe(true)
  })

  test('битый файл — «не знаю», не исключение', () => {
    const p = join(dir, 'f4.json'); writeFileSync(p, '{not json')
    expect(fleetSessionLiveness(p)('session-aaa')).toBeUndefined()
  })
})
