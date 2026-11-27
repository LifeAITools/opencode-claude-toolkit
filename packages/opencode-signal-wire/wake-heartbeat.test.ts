/**
 * Штамп свежести слота (`lastSeen`) — испытания.
 *
 * Контракт уже был объявлен в `wake-types.ts`: «Plugin updates this every 30s… populated by
 * heartbeat-writer», порог 90 с. Писателя не было — и роутер падал на `startedAt`, а после
 * 90 секунд пробовал каждый слот по HTTP каждые 30 с (замер владельца lat-context 11.11.2026).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoveryHeartbeatMs,
  resetDiscoveryHeartbeatForTest,
  restoreDiscoverySlot,
  stampDiscoveryLastSeen,
  writeDiscoverySlot,
} from './wake-listener'

const file = () => join(tmpdir(), `wake-slot-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)

afterEach(() => {
  resetDiscoveryHeartbeatForTest()
  delete process.env.WAKE_HEARTBEAT_MS
})

describe('штамп свежести', () => {
  test('частота по умолчанию 30 с (порог читателя 90 с = 3×)', () => {
    expect(discoveryHeartbeatMs({} as NodeJS.ProcessEnv)).toBe(30_000)
    expect(discoveryHeartbeatMs({ WAKE_HEARTBEAT_MS: '1' } as NodeJS.ProcessEnv)).toBe(10)
  })

  test('штамп обновляет ТОЛЬКО lastSeen и оставляет остальное как было', () => {
    const p = file()
    writeFileSync(p, JSON.stringify({ port: 1234, sessionId: 'ses_x', startedAt: '2026-11-11T08:00:00Z', lastSeen: '2026-11-11T08:00:00Z' }))
    expect(stampDiscoveryLastSeen(p, '2026-11-11T08:01:00.000Z')).toBe(true)
    const disc = JSON.parse(readFileSync(p, 'utf-8'))
    expect(disc.lastSeen).toBe('2026-11-11T08:01:00.000Z')
    expect(disc.port).toBe(1234)
    expect(disc.sessionId).toBe('ses_x')
    unlinkSync(p)
  })

  test('нет файла — false, и это не ошибка записи', () => {
    expect(stampDiscoveryLastSeen(join(tmpdir(), 'nope-never.json'))).toBe(false)
  })
})

describe('сердцебиение', () => {
  test('пишется на каждой записи слота и обновляется по таймеру', async () => {
    process.env.WAKE_HEARTBEAT_MS = '40'
    const p = file()
    writeDiscoverySlot(p, {
      port: 4321,
      token: 'tok',
      sessionId: 'ses_y',
      agentInstanceId: 'opencode:b:1',
      pid: 1,
      startedAt: '2026-11-11T08:00:00Z',
      lastSeen: '2026-11-11T08:00:00Z',
      transport: 'http',
    } as any)
    const first = JSON.parse(readFileSync(p, 'utf-8')).lastSeen
    await new Promise(r => setTimeout(r, 120))
    const second = JSON.parse(readFileSync(p, 'utf-8')).lastSeen
    expect(second).not.toBe(first)
    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
    unlinkSync(p)
  })

  test('слот исчез — сердцебиение просто забывает его и не падает', async () => {
    process.env.WAKE_HEARTBEAT_MS = '40'
    const p = file()
    writeDiscoverySlot(p, {
      port: 1, token: '', sessionId: 'ses_z', agentInstanceId: 'opencode:c:2', pid: 2,
      startedAt: '2026-11-11T08:00:00Z', lastSeen: '2026-11-11T08:00:00Z', transport: 'http',
    } as any)
    unlinkSync(p)
    await new Promise(r => setTimeout(r, 100))
    // Главное — не исключение: таймер жив, запись в пропавший слот не роняет дверь.
    expect(true).toBe(true)
  })
})

describe('исчезнувший слот возвращается (задача d71ef33e, 27.11.2026)', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    port: 38979, token: 'tok-secret', sessionId: 'ses_restore', agentInstanceId: 'opencode:r:1', pid: 7,
    startedAt: '2026-11-27T05:00:00Z', lastSeen: '2026-11-27T05:00:00Z', transport: 'http', ...over,
  }) as any

  test('слот удалили у живого слушателя — тик свежести возвращает его с тем же портом, токеном и сессией', async () => {
    process.env.WAKE_HEARTBEAT_MS = '40'
    const p = file()
    writeDiscoverySlot(p, body())
    unlinkSync(p)
    await new Promise(r => setTimeout(r, 120))
    const disc = JSON.parse(readFileSync(p, 'utf-8'))
    expect(disc.port).toBe(38979)
    expect(disc.token).toBe('tok-secret')
    expect(disc.sessionId).toBe('ses_restore')
    expect(disc.transport).toBe('http')
    expect(Date.parse(disc.lastSeen)).toBeGreaterThan(Date.parse('2026-11-27T05:00:00Z'))
    unlinkSync(p)
  })

  test('restoreDiscoverySlot: слот, о котором процесс не знает, не воскрешается', () => {
    expect(restoreDiscoverySlot(join(tmpdir(), 'never-written-slot.json'))).toBe(false)
  })

  test('после остановки двери (забыли слоты) удалённый файл НЕ возвращается', async () => {
    process.env.WAKE_HEARTBEAT_MS = '40'
    const p = file()
    writeDiscoverySlot(p, body())
    unlinkSync(p)
    resetDiscoveryHeartbeatForTest()
    await new Promise(r => setTimeout(r, 120))
    expect(existsSync(p)).toBe(false)
  })

  test('тело в памяти следует за тем, что лежит на диске: смена сессии не теряется при воссоздании', () => {
    const p = file()
    writeDiscoverySlot(p, body())
    // внешняя правка файла (как делает привязка сессии) и штамп подтягивают тело из файла
    writeFileSync(p, JSON.stringify(body({ sessionId: 'ses_rebound' })))
    expect(stampDiscoveryLastSeen(p)).toBe(true)
    unlinkSync(p)
    expect(restoreDiscoverySlot(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf-8')).sessionId).toBe('ses_rebound')
    unlinkSync(p)
  })
})
