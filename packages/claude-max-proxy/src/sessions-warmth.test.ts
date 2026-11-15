/**
 * Строка `/admin/sessions` несёт состояние ТЕПЛА рядом с обычными полями.
 *
 * 🔴 Повод — своя же ошибка, увиденная в чужом расчёте (15.11.2026). Владелец dsh держал
 * письма агенту unmixup, потому что видел «6 часов без вызова модели»: его счётчик считал
 * только НАСТОЯЩИЕ ходы, а наши успешные прогревы шли каждые 27.5 минуты — 13 выстрелов за
 * 5.5 часа, ни одного пропуска. Два разных явления читались как одно, и цена была — голодный
 * агент с тёплым кэшем.
 *
 * Здесь закреплены три вещи, на которых этот расчёт может снова сломаться:
 *  (а) `lastWarmAt` — ОДИН штамп для хода и для прогрева, читателю не надо складывать;
 *  (б) `cacheWarmUntil` считается по ФАКТИЧЕСКОМУ сроку сессии, а не по общему из настроек;
 *  (в) отсутствие подтверждения — `null`, а НЕ ноль (правило null-is-not-zero).
 */
import { describe, expect, test } from 'bun:test'
import { sessionRowOf } from './modules/admin.js'

const H = 3_600_000
const base = { sessionId: 'ses_x', pid: null, model: 'claude-sonnet-5-5', firstSeenAt: 1000, lastRequestAt: 2000 }

describe('sessionRowOf — тепло кэша в строке сессии', () => {
  test('прогрев подтверждает кэш так же, как ход: тёплый до lastWarmAt + срок ЭТОЙ ветки', () => {
    const r = sessionRowOf({ ...base, engine: { _warmth: { lastWarmedAt: 1700000000000, ttlMs: H, armed: true } } })
    expect(r.lastWarmAt).toBe(1700000000000)
    expect(r.cacheWarmUntil).toBe(1700000000000 + H)
    expect(r.cacheTtlSec).toBe(3600)
    expect(r.kaState).toBe('armed')
  })

  test('пятиминутный срок ветки не подменяется часовым из настроек', () => {
    const r = sessionRowOf({ ...base, engine: { _warmth: { lastWarmedAt: 1700000000000, ttlMs: 5 * 60_000, armed: true } } })
    expect(r.cacheTtlSec).toBe(300)
    expect(r.cacheWarmUntil).toBe(1700000000000 + 5 * 60_000)
  })

  test('подтверждения нет — null, а не ноль; «тёплый до» не выдумывается', () => {
    const r = sessionRowOf({ ...base, engine: { _warmth: { lastWarmedAt: null, ttlMs: H, armed: false } } })
    expect(r.lastWarmAt).toBeNull()
    expect(r.cacheWarmUntil).toBeNull()
    expect(r.kaState).toBe('disarmed')
  })

  test('движка нет — состояние названо none, форма строки цела', () => {
    const r = sessionRowOf({ ...base })
    expect(r.kaState).toBe('none')
    expect(r.lastWarmAt).toBeNull()
    expect(r.sessionId).toBe('ses_x')
    expect(r.lastRequestAt).toBe(2000)
  })

  test('прежние поля не тронуты — старый читатель ничего не теряет', () => {
    const r = sessionRowOf({ ...base, engine: { _warmth: { lastWarmedAt: 1700000000000, ttlMs: H, armed: true } } })
    expect(r).toMatchObject({ sessionId: 'ses_x', pid: null, model: 'claude-sonnet-5-5', firstSeenAt: 1000, lastRequestAt: 2000 })
  })
})
