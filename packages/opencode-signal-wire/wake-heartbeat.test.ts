/**
 * Штамп свежести слота (`lastSeen`) — испытания.
 *
 * Контракт уже был объявлен в `wake-types.ts`: «Plugin updates this every 30s… populated by
 * heartbeat-writer», порог 90 с. Писателя не было — и роутер падал на `startedAt`, а после
 * 90 секунд пробовал каждый слот по HTTP каждые 30 с (замер владельца lat-context 11.11.2026).
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoveryHeartbeatMs,
  resetDiscoveryHeartbeatForTest,
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
