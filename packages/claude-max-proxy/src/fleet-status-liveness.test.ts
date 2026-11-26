import { describe, expect, test } from 'bun:test'
import {
  createFleetStatusPoller, firstAlive, fleetStatusConfig,
  FLEET_STATUS_MAX_SNAPSHOT_AGE_MS, FLEET_STATUS_MAX_PRESENCE_AGE_SEC,
} from './fleet-status-liveness.js'

const cfg = { url: 'http://fleet.test/status', tokenPath: '/nope' }
const doc = {
  agents: [
    { session: 'session-live', alive: true, presence: { lastSeenAgeSec: 42 } },
    { session: 'session-dead', alive: false, presence: { lastSeenAgeSec: 5 } },
    { session: 'session-stale', alive: true, presence: { lastSeenAgeSec: FLEET_STATUS_MAX_PRESENCE_AGE_SEC + 1 } },
    { session: 'session-nopresence', alive: true },
  ],
}
const ok = (d: unknown) => (async () => new Response(JSON.stringify(d), { status: 200 })) as unknown as typeof fetch

type PollerOpts = Parameters<typeof createFleetStatusPoller>[0]
function make(over: Partial<PollerOpts> & { clock?: { t: number } } = {}) {
  const clock = over.clock ?? { t: 1_000_000 }
  const seen: Array<{ url: string; token: string | null }> = []
  const p = createFleetStatusPoller({
    config: cfg, now: () => clock.t, readToken: () => 'READ-ONLY',
    fetchImpl: over.fetchImpl ?? (((url: string, init: RequestInit) => {
      seen.push({ url, token: new Headers(init.headers).get('x-control-token') })
      return Promise.resolve(new Response(JSON.stringify(doc), { status: 200 }))
    }) as unknown as typeof fetch),
    onError: over.onError,
  })
  return { p, clock, seen }
}

describe('жизнь сессии по сетевому слепку флота', () => {
  test('живая связка со свежей меткой — жива; остальное — «не знаю», не «мертва»', async () => {
    const { p } = make()
    expect(await p.refresh()).toBeNull()
    expect(p.isSessionAlive('session-live')).toBe(true)
    expect(p.isSessionAlive('session-dead')).toBeUndefined()
    expect(p.isSessionAlive('session-stale')).toBeUndefined()
    expect(p.isSessionAlive('session-nopresence')).toBeUndefined()
    expect(p.isSessionAlive('session-unknown')).toBeUndefined()
  })

  test('до первого опроса — «не знаю»', () => {
    expect(make().p.isSessionAlive('session-live')).toBeUndefined()
  })

  test('токен только на чтение уходит заголовком x-control-token на адрес из настройки', async () => {
    const { p, seen } = make()
    await p.refresh()
    expect(seen).toEqual([{ url: 'http://fleet.test/status', token: 'READ-ONLY' }])
  })

  test('слепок старше срока — не опора', async () => {
    const { p, clock } = make()
    await p.refresh()
    clock.t += FLEET_STATUS_MAX_SNAPSHOT_AGE_MS + 1
    expect(p.isSessionAlive('session-live')).toBeUndefined()
  })

  test('сбой сети не стирает слепок и не бросает; сообщение об ошибке — один раз подряд', async () => {
    const errs: string[] = []
    const { p, clock } = make({ onError: (m) => errs.push(m) })
    await p.refresh()
    const failing = createFleetStatusPoller({
      config: cfg, now: () => clock.t, readToken: () => 't',
      fetchImpl: (async () => new Response('no', { status: 403 })) as unknown as typeof fetch,
      onError: (m) => errs.push(m),
    })
    expect(await failing.refresh()).toBe('HTTP 403')
    expect(await failing.refresh()).toBe('HTTP 403')
    expect(errs).toEqual(['HTTP 403'])
    expect(p.isSessionAlive('session-live')).toBe(true)
  })

  test('нет токена-файла — ошибка текстом, не исключение', async () => {
    const p = createFleetStatusPoller({
      config: cfg, readToken: () => { throw new Error('ENOENT') }, fetchImpl: ok(doc),
    })
    expect(await p.refresh()).toBe('ENOENT')
  })

  test('адрес не задан — источник выключен', async () => {
    const p = createFleetStatusPoller({ config: { url: undefined, tokenPath: '/x' } })
    expect(await p.refresh()).toBe('disabled')
    expect(p.isSessionAlive('session-live')).toBeUndefined()
    p.start(); p.stop()
  })

  test('настройка читается из окружения; без адреса источник выключен', () => {
    expect(fleetStatusConfig({ HOME: '/h' } as NodeJS.ProcessEnv).url).toBeUndefined()
    const c = fleetStatusConfig({ HOME: '/h', DSH_FLEET_STATUS_URL: 'http://x/status' } as NodeJS.ProcessEnv)
    expect(c.url).toBe('http://x/status')
    expect(c.tokenPath).toBe('/h/.dsh/keys/control-token-read')
  })

  test('firstAlive: «жива» от любого источника, иначе «не знаю», никогда false', () => {
    const a = (s: string) => (s === 'a' ? true : undefined)
    const b = (s: string) => (s === 'b' ? true : undefined)
    const f = firstAlive(a, b)
    expect(f('a')).toBe(true)
    expect(f('b')).toBe(true)
    expect(f('c')).toBeUndefined()
  })
})
