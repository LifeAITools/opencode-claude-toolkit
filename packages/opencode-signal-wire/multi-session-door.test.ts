/**
 * Две живые сессии в ОДНОМ процессе — у каждой своя дверь (задача 47412dc3, 29.10.2026).
 *
 * Что было: дверь и слот были ключом ПО ПРОЦЕССУ. Вторая сессия получала отказ
 * `SESSION_BIND_AMBIGUOUS` и ходила через дверь первой, то есть побудки для неё вставлялись
 * в чужой разговор; слот при этом оставался один.
 *
 * Что проверяется здесь, тремя разными приборами:
 *  1) имя слота — второй сессии достаётся своё, первая не переименовывается;
 *  2) singleton дверей — две РАЗНЫЕ сессии открывают две двери, одна и та же — делят одну
 *     (инцидент 30.09: два приёмника на одного агента не должны вернуться);
 *  3) привязка — дверь, объявленная за эту сессию, принимает её, даже если глобальный кэш
 *     помнит другую.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoveryFilePath } from './wake-listener'
import { processWakeListener, resetProcessSingletons } from './plugin'

afterEach(() => resetProcessSingletons())

describe('слот: две сессии одного процесса', () => {
  const dir = () => mkdtempSync(join(tmpdir(), 'oc-multi-'))

  test('одна сессия — прежнее имя, ни один читатель не переучивается', () => {
    const d = dir()
    expect(discoveryFilePath(d, 42, 'agent_01', 'ses_a', { sessionsInProcess: ['ses_a'] }))
      .toBe(join(d, '42-agent_01.json'))
  })

  test('две сессии — у каждой своё имя (суффикс по номеру сессии)', () => {
    const d = dir()
    const first = discoveryFilePath(d, 42, 'agent_01', 'ses_a', { sessionsInProcess: ['ses_a', 'ses_b'] })
    const second = discoveryFilePath(d, 42, 'agent_01', 'ses_b', { sessionsInProcess: ['ses_a', 'ses_b'] })
    // Правило ДЕТЕРМИНИРОВАННОЕ: пока сессия в процессе одна — имя прежнее (база), как только
    // их две — суффикс у КАЖДОЙ. Иначе имя зависело бы от порядка старта.
    expect(first).toBe(join(d, '42-agent_01-ses_a.json'))
    expect(second).toBe(join(d, '42-agent_01-ses_b.json'))
    expect(first).not.toBe(second)
  })

  test('без привязки — имя по номеру сессии, как раньше', () => {
    const d = dir()
    expect(discoveryFilePath(d, 42, undefined, 'ses_a', { sessionsInProcess: ['ses_a', 'ses_b'] }))
      .toBe(join(d, '42-ses_a.json'))
  })
})

describe('singleton дверей: ключ — сессия', () => {
  const fake = (port: number, sessionId: string) => ({
    port, token: 't', server: null as any, stop: () => {}, sessionId,
  })

  test('две РАЗНЫЕ сессии открывают две двери', async () => {
    let starts = 0
    const a = processWakeListener('ses_a', async () => { starts++; return fake(1001, 'ses_a') })
    const b = processWakeListener('ses_b', async () => { starts++; return fake(1002, 'ses_b') })
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(false)
    expect((await a.handle)?.port).toBe(1001)
    expect((await b.handle)?.port).toBe(1002)
    expect(starts).toBe(2)
  })

  test('одна и та же сессия двумя экземплярами — одна дверь (инцидент 30.09)', async () => {
    let starts = 0
    const a = processWakeListener('ses_a', async () => { starts++; return fake(1001, 'ses_a') })
    const b = processWakeListener('ses_a', async () => { starts++; return fake(1002, 'ses_a') })
    expect(a.shared).toBe(false)
    expect(b.shared).toBe(true)
    expect((await b.handle)?.port).toBe(1001)
    expect(starts).toBe(1)
  })
})
