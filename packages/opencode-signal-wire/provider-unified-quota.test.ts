/**
 * Единственный путь чтения квоты. Тесты защищают не «парсится», а два свойства:
 * 1) провайдеры не смешиваются; 2) нет данных — пусто, а НЕ фолбэк на другой файл.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readUnifiedQuota } from './provider-unified-quota.js'

const dir = mkdtempSync(join(tmpdir(), 'unified-q-'))
const write = (name: string, body: unknown) => { const f = join(dir, name); writeFileSync(f, JSON.stringify(body)); return f }

const DOC = {
  schemaVersion: 1, generatedAt: '2026-11-05T10:00:00.000Z',
  accounts: [
    { provider: 'opencode-go', account: 'go-weak', status: 'active', measuredAt: '2026-11-05T09:59:00.000Z',
      headroomFraction: 0.01, bindsUntil: '2026-11-09T00:00:00.000Z',
      windows: [{ name: '5h', usedFraction: 0.2, resetsAt: '2026-11-05T14:00:00.000Z' }, { name: 'week', usedFraction: 0.99 }] },
    { provider: 'opencode-go', account: 'go-strong', status: 'active', measuredAt: '2026-11-05T09:59:00.000Z',
      headroomFraction: 0.83, windows: [{ name: '5h', usedFraction: 0.05 }, { name: 'week', usedFraction: 0.17 }] },
    { provider: 'opencode-go', account: 'go-dead', status: 'exhausted', measuredAt: '2026-11-05T09:59:00.000Z',
      reason: 'month_exhausted_until_2026-11-24T06:32:05.000Z', headroomFraction: 0, windows: [{ name: 'month', usedFraction: 1 }] },
    { provider: 'open-design', account: 'OD workspace', status: 'active', measuredAt: '2026-11-05T09:58:00.000Z',
      headroomFraction: 0.95, windows: [{ name: '5h', usedFraction: 0.05 }, { name: 'week', usedFraction: 0.02 }] },
  ],
}

describe('единый читатель квоты', () => {
  test('провайдеры не смешиваются: у open-design не бывает окон go', () => {
    const f = write('a.json', DOC)
    const od = readUnifiedQuota('open-design', { path: f })!
    expect(od.account).toBe('OD workspace')
    expect(od.windows.map(w => w.kind)).toEqual(['5h', '7d'])
    const go = readUnifiedQuota('opencode-go', { path: f })!
    expect(go.account).toBe('go-strong')       // годный с наибольшим запасом
  })

  test('названный аккаунт важнее выбора по запасу; окна — его', () => {
    const f = write('b.json', DOC)
    const go = readUnifiedQuota('opencode-go', { account: 'go-weak', path: f })!
    expect(go.account).toBe('go-weak')
    expect(go.headroomFraction).toBeCloseTo(0.01)
    expect(go.bindsUntil).toBe('2026-11-09T00:00:00.000Z')
  })

  test('исчерпанный аккаунт отдаётся с причиной, а не прячется', () => {
    const f = write('c.json', DOC)
    const dead = readUnifiedQuota('opencode-go', { account: 'go-dead', path: f })!
    expect(dead.status).toBe('exhausted')
    expect(dead.reason).toContain('month_exhausted')
  })

  test('нет файла или нет провайдера — null, а НЕ фолбэк на другой источник', () => {
    expect(readUnifiedQuota('opencode-go', { path: join(dir, 'none.json') })).toBeNull()
    const f = write('d.json', DOC)
    expect(readUnifiedQuota('alibaba', { path: f })).toBeNull()
  })

  test('пул — по живым аккаунтам провайдера, «не измерено» не считается нулём', () => {
    const f = write('e.json', { accounts: [
      { provider: 'p', account: 'a', status: 'active', headroomFraction: 0.5, windows: [] },
      { provider: 'p', account: 'b', status: 'active', headroomFraction: null, windows: [] },
      { provider: 'p', account: 'c', status: 'exhausted', headroomFraction: 0, windows: [] },
    ] })
    const r = readUnifiedQuota('p', { path: f })!
    expect(r.pool!.accounts).toBe(2)          // исчерпанный в пул не идёт
    expect(r.pool!.util5h).toBeCloseTo(0.5)   // худший ЖИВОЙ запас = 0.5
  })
})

test('cleanup', () => rmSync(dir, { recursive: true, force: true }))


describe('деньги провайдера не приклеиваются к выбранному аккаунту', () => {
  test('providerSpend приходит с ОБЪЕКТОМ и не подменяет аккаунт', () => {
    // СВОЙ каталог: общий `dir` этого файла удаляет тест 'cleanup' ниже по объявлению,
    // и он выполняется раньше — на общем каталоге проверка падала не по существу.
    const own = mkdtempSync(join(tmpdir(), 'unified-spend-'))
    const f = join(own, 'unified-spend.json')
    writeFileSync(f, JSON.stringify({
      generatedAt: '2026-11-07T00:00:00Z',
      unit: { used: 'fraction', range: '0..1' },
      accounts: [
        { provider: 'ocp', account: 'a@b', status: 'active', measuredAt: '2026-11-07T00:00:00Z',
          headroomFraction: 0.5, windows: [{ name: 'week', usedFraction: 0.5, resetsAt: '2026-11-10T00:00:00Z' }] },
        { provider: 'ocp', account: 'c@d', status: 'active', measuredAt: '2026-11-07T00:00:00Z',
          headroomFraction: 0.7, windows: [{ name: 'week', usedFraction: 0.3 }] },
      ],
      providers: { ocp: { spend: [
        { currency: 'USD', total: 3.25, basis: 'key', subject: 'sk-x', since: '2026-11-01T00:00:00Z',
          measuredAt: '2026-11-07T00:00:00Z', source: 'x-litellm-response-cost' },
      ] } },
    }))
    const r = readUnifiedQuota('ocp', { path: f, refuseAmbiguous: true })!
    expect(r.account).toBeNull()            // счёт по-прежнему не угадан
    expect(r.providerSpend?.[0]).toMatchObject({ subject: 'sk-x', basis: 'key', total: 3.25 })
    rmSync(own, { recursive: true, force: true })
  })
})
