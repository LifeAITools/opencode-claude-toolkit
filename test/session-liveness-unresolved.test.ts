/**
 * Сессия без опознанного владельца, которую держит ЖИВОЙ внешний источник (14.11.2026).
 *
 * Живой случай: агенты флота DeepSeek Harness ходят через LiteLLM :4000, номер процесса у прокси
 * не разрешается (`pidUnresolved: true`). Такую сессию уборщик снимал через 2 ч ПРОСТОЯ от
 * последнего настоящего хода — и называл это `pid_gone`. session-f933b5aa (mcp-access-payments):
 * последний ход 20:26:04Z, прогрев держал кэш до 22:17Z, а в 22:26:05Z сессию убрали; утром
 * фаундер не смог продолжить её на тёплом кэше, хотя у флота она оставалась текущей.
 *
 * Правило: неопознанный владелец — не доказательство смерти, и не доказательство жизни. Если
 * внешний источник (`isSessionAlive`) говорит «жива» — не убирать. «Не знаю» (undefined) —
 * прежнее правило двух часов. Сессия с опознанным процессом — как раньше, по процессу.
 */
import { describe, test, expect } from 'bun:test'
import { InMemorySessionStore, UNRESOLVED_PID_IDLE_TTL_MS } from '../src/proxy-adapters.js'

const idle = (store: InMemorySessionStore<any>, sid: string) => {
  store.get(sid)!.lastRequestAt = Date.now() - UNRESOLVED_PID_IDLE_TTL_MS - 60_000
}

describe('уборка сессии без опознанного владельца', () => {
  test('внешний источник говорит «жива» — сессия остаётся, хотя простой больше двух часов', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false, isSessionAlive: (sid: string) => sid === 'fleet-1' ? true : undefined })
    store.getOrCreate('fleet-1', null, () => ({}))
    idle(store, 'fleet-1')
    expect(store.reapDead()).toEqual([])
    expect(store.get('fleet-1')).toBeDefined()
  })

  test('источник не знает сессию — прежнее правило двух часов', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false, isSessionAlive: () => undefined })
    store.getOrCreate('anon-1', null, () => ({}))
    idle(store, 'anon-1')
    expect(store.reapDead()).toEqual(['anon-1'])
    expect(store.lastReapReasons().get('anon-1')).toBe('unresolved_idle')
  })

  test('источник говорит «мертва» — убирается сразу, не дожидаясь двух часов', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false, isSessionAlive: () => false })
    store.getOrCreate('gone-1', null, () => ({}))
    expect(store.reapDead()).toEqual(['gone-1'])
    expect(store.lastReapReasons().get('gone-1')).toBe('owner_said_dead')
  })

  test('источника нет вовсе — поведение как было', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false })
    store.getOrCreate('old-1', null, () => ({}))
    expect(store.reapDead()).toEqual([])        // простоя ещё нет
    idle(store, 'old-1')
    expect(store.reapDead()).toEqual(['old-1'])
  })

  test('сессия с опознанным процессом решается по процессу, а не по источнику', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false, isSessionAlive: () => true })
    store.getOrCreate('pid-1', 4242, () => ({}))
    expect(store.reapDead()).toEqual(['pid-1'])
    expect(store.lastReapReasons().get('pid-1')).toBe('pid_gone')
  })

  test('источник бросил — правило двух часов, уборщик не падает', () => {
    const store = new InMemorySessionStore<any>({ isAlive: () => false, isSessionAlive: () => { throw new Error('boom') } })
    store.getOrCreate('x-1', null, () => ({}))
    expect(store.reapDead()).toEqual([])
    idle(store, 'x-1')
    expect(store.reapDead()).toEqual(['x-1'])
  })
})
