/**
 * Выбор организации по ЗАПАСУ (не по `active:` реестра). Главный полюс — тот, что уронил бы окно
 * перевода: свежая организация должна выигрывать у почти исчерпанной, даже если в реестре активна она.
 */
import { describe, expect, test } from 'bun:test'
import { pickOrgByTimeToWall, timeToWall, readOrgQuotas, readStoreOrgNames, type OrgQuotaView } from './go-org-pick.js'
import type { GoOrg } from './go-registry.js'

const org = (name: string, over: Partial<GoOrg> = {}): GoOrg => ({
  name, workspace: 'w_' + name, auth: 'console', baseUrl: 'https://g.invalid', accountUrl: 'https://c.invalid',
  synqtaskOrgUid: null, env: null, priority: 1, ...over,
})
const q = (name: string, h5: number | null, h7: number | null, status = 'active'): OrgQuotaView => ({
  name, util5h: h5, util7d: h7, utilMonth: 0, status,
})
const all = (names: string[]) => () => true


const NOW = 1_800_000_000_000
const H = 3_600_000
/** Организация с явными окнами: util и остаток до сброса в часах. */
const orgWith = (name: string, windows: Array<[string, number, number]>, over: Partial<GoOrg> = {}): GoOrg => org(name, over)
const view = (name: string, windows: Array<[string, number, number]>, status = 'active'): OrgQuotaView => ({
  name,
  status,
  util5h: windows.find((w) => w[0] === '5h')?.[1] ?? null,
  util7d: windows.find((w) => w[0] === 'week')?.[1] ?? null,
  utilMonth: windows.find((w) => w[0] === 'month')?.[1] ?? null,
  windows: windows.map(([window, util, remainingH]) => ({ window, util, resetAt: NOW + remainingH * H })),
})
const pick = (orgs: GoOrg[], quotas: OrgQuotaView[], has = (n: string) => true, sessionKey: string | null = 'ses_a') =>
  pickOrgByTimeToWall(orgs, quotas, has, { nowMs: NOW, sessionKey })

describe('выбор организации по времени до стены', () => {
  test('свежая выигрывает у почти исчерпанной — даже если исчерпанная помечена active', () => {
    const quotas = [
      view('old', [['5h', 0.9, 1], ['week', 0.95, 20], ['month', 0.9, 300]]),
      view('fresh', [['5h', 0.02, 4.5], ['week', 0.03, 160], ['month', 0.5, 500]]),
    ]
    expect(pick([orgWith('old', []), orgWith('fresh', [])], quotas).org?.name).toBe('fresh')
  })

  test('исчерпанное окно (util ≥ 1) исключает организацию полностью', () => {
    const quotas = [
      view('walled', [['5h', 0.1, 4], ['week', 1, 100], ['month', 0.2, 400]]),
      view('ok', [['5h', 0.5, 2], ['week', 0.5, 80], ['month', 0.5, 400]]),
    ]
    expect(pick([orgWith('walled', []), orgWith('ok', [])], quotas).org?.name).toBe('ok')
  })

  test('окно короче 15 минут не участвует: скорость на нём неизвестна', () => {
    // 5ч почти не истекло (осталось 4.9ч → elapsed 6 мин), util 0.5 — если бы считалось, «до стены» было бы 6 мин
    const quotas = [view('short', [['5h', 0.5, 4.9], ['week', 0.2, 100], ['month', 0.2, 400]])]
    const r = pick([orgWith('short', [])], quotas)
    expect(r.org?.name).toBe('short')
    expect(r.reason).not.toContain('5h=')
  })

  test('НЕсвязывающее окно не пугает: берётся то, которое реально упрётся раньше сброса', () => {
    // неделя: elapsed 68ч, util 0.1 → ttw ≈ 612ч, а сброс через 100ч → не связывает
    // месяц: elapsed 220ч, util 0.5 → ttw ≈ 220ч, сброс через 500ч → связывает
    const quotas = [view('x', [['week', 0.1, 100], ['month', 0.5, 500]])]
    const ttw = timeToWall(quotas[0], NOW)
    expect(ttw?.score).toBeCloseTo(220, 0)
  })

  test('нет ни одного замера → null (вызывающий откатывается на active:)', () => {
    expect(pickOrgByTimeToWall([org('a')], [], () => true, { nowMs: NOW }).org).toBeNull()
    expect(pickOrgByTimeToWall([org('a')], [{ name: 'a', status: 'active' }], () => true, { nowMs: NOW }).org).toBeNull()
  })

  test('restricted и retired не выбираются, даже при лучшем запасе', () => {
    const quotas = [
      view('a', [['5h', 0, 4.5], ['week', 0, 160]], 'restricted'),
      view('b', [['5h', 0, 4.5], ['week', 0, 160]], 'retired'),
      view('c', [['5h', 0.6, 2], ['week', 0.6, 60]]),
    ]
    expect(pick([orgWith('a', []), orgWith('b', []), orgWith('c', [])], quotas).org?.name).toBe('c')
  })

  test('нет пропуска в хранилище — не кандидат', () => {
    const quotas = [view('a', [['5h', 0, 4.5], ['week', 0, 160]]), view('b', [['5h', 0.6, 2], ['week', 0.6, 60]])]
    expect(pick([orgWith('a', []), orgWith('b', [])], quotas, (n) => n === 'b').org?.name).toBe('b')
  })

  test('равные организации держатся за сессией, а не перекидываются', () => {
    const quotas = [view('a', [['5h', 0, 4.5], ['week', 0.1, 100]]), view('b', [['5h', 0, 4.5], ['week', 0.1, 100]])]
    const orgs = [orgWith('a', []), orgWith('b', [])]
    const seen = new Set<string>()
    for (let i = 0; i < 30; i++) seen.add(pick(orgs, quotas, undefined, 'ses_same').org!.name)
    expect([...seen]).toHaveLength(1)
  })
})

describe('чтение отчёта квоты и хранилища', () => {
  test('отчёт: терпим к отсутствию файла и к записи через accounts', () => {
    expect(readOrgQuotas('/nonexistent/q.json')).toEqual([])
    const { mkdtempSync, writeFileSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const d = mkdtempSync(join(tmpdir(), 'qp-'))
    const p = join(d, 'q.json')
    writeFileSync(p, JSON.stringify({ accounts: { 'org-a': { util5h: 0.1, util7d: 0.2 } } }))
    const rows = readOrgQuotas(p)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'org-a', util5h: 0.1, util7d: 0.2 })
  })

  test('хранилище: только записи с непустым access_token', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const d = mkdtempSync(join(tmpdir(), 'st-'))
    const p = join(d, 't.json')
    writeFileSync(p, JSON.stringify({ orgs: { a: { access_token: 'x' }, b: { access_token: '' }, c: {} } }))
    expect([...readStoreOrgNames(p)].sort()).toEqual(['a'])
    expect(readStoreOrgNames(null).size).toBe(0)
  })
})

/**
 * Липкость к сессии. Полюс тот же, что уронил бы перевод маршрута: кэш префикса принадлежит
 * АККАУНТУ, поэтому перескок организации посреди разговора = холодная перезапись.
 */

describe('чтение отчёта квоты: окна', () => {
  test('windows из отчёта разбираются в resetAt/util', () => {
    const { mkdtempSync, writeFileSync } = require('node:fs')
    const { tmpdir } = require('node:os')
    const { join } = require('node:path')
    const d = mkdtempSync(join(tmpdir(), 'qp2-'))
    const f = join(d, 'q.json')
    writeFileSync(f, JSON.stringify({ orgs: [{ name: 'o', windows: [{ window: '5h', util: 0.3, resetAt: 123 }] }] }))
    const rows = readOrgQuotas(f)
    expect(rows[0].windows).toEqual([{ window: '5h', util: 0.3, resetAt: 123 }])
  })
})
