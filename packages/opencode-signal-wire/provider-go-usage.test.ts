/**
 * Дверь usage Go/Zen (provider-go-usage.ts): порядок ключей и опрос без сети.
 * Живой формы ответа пока нет — везётся сырьё, окна вторым шагом.
 */
import { describe, expect, test } from 'bun:test'
import { GO_USAGE_URL, queryGoUsage, resolveWorkspaceKeys } from './provider-go-usage'

const NOW = new Date('2026-10-06T08:30:00.000Z')

describe('ключи рабочей области', () => {
  test('порядок: Zen первым, затем Go; дубли давятся; мусор отсекается', () => {
    const keys = resolveWorkspaceKeys(
      [
        { integration_id: 'opencode-go', value: JSON.stringify({ key: 'K-GO' }) },
        { integration_id: 'other', value: JSON.stringify({ key: 'K-X' }) },
        { integration_id: 'opencode', value: 'not-json' },
      ],
      { 'opencode-go': { key: 'K-GO' }, zen: { key: 'K-ZEN' } },
    )
    expect(keys).toEqual([
      { provider: 'zen', key: 'K-ZEN' },
      { provider: 'go', key: 'K-GO' },
    ])
  })

  test('пусто — пустой список, а не падение', () => {
    expect(resolveWorkspaceKeys([], {})).toEqual([])
    expect(resolveWorkspaceKeys(null as any, null as any)).toEqual([])
  })
})

describe('опрос двери', () => {
  test('первый работающий ключ везёт сырьё как есть', async () => {
    const calls: string[] = []
    const fetchFn = async (url: string, init: any) => {
      calls.push(`${init.headers.Authorization.slice(0, 8)}@${url}`)
      if (init.headers.Authorization === 'Bearer BAD') return { ok: false, status: 403, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => ({ windows: [] }) }
    }
    const r = await queryGoUsage(fetchFn as any, [
      { provider: 'zen', key: 'BAD' },
      { provider: 'go', key: 'GOOD' },
    ], NOW)
    expect(r).toEqual({ provider: 'go', measuredAt: NOW.toISOString(), data: { windows: [] } })
    expect(calls[0]).toContain(GO_USAGE_URL)
  })

  test('все отказали или сеть легла — null', async () => {
    const fail = async () => ({ ok: false, status: 403, json: async () => ({}) })
    expect(await queryGoUsage(fail as any, [{ provider: 'go', key: 'K' }], NOW)).toBeNull()
    expect(await queryGoUsage(null as any, [], NOW)).toBeNull()
    const down = async (): Promise<never> => { throw new Error('down') }
    expect(await queryGoUsage(down as any, [{ provider: 'go', key: 'K' }], NOW)).toBeNull()
  })
})
