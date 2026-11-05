/**
 * Регрессия инцидента 02.11.2026: цепочка памяти полчаса отдавала 429, потому что клиент
 * НАЗЫВАЛ исчерпанную организацию, а дверь защищала названное имя от «переезда» — хотя
 * переезжать было нечему: у запроса не было ВЫДАЧИ (пина).
 *
 * Три полюса, и третий не менее важен двух первых: без него правило можно «улучшить» до
 * оспаривания ЛЮБОЙ названной организации, то есть до того же класса, что мы чинили.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectOrg, restorePinsForTest, poolAfter429, ORG_429_COOLDOWN_MS } from './modules/go-door.js'
import type { GoRegistry } from './go-registry.js'
import type { GoOrg } from './go-registry.js'

const NOW = Date.now()
const H = 3_600_000

const org = (name: string): GoOrg => ({
  name,
  workspace: `w_${name}`,
  auth: 'console',
  baseUrl: 'https://g.invalid',
  accountUrl: 'https://c.invalid',
  synqtaskOrgUid: null,
  env: null,
  priority: 1,
})

/** За стеной = любое окно исчерпано (месяц, как в инциденте). */
const walled = (name: string) => ({
  name,
  util5h: 0.1,
  util7d: 0.2,
  utilMonth: 1,
  status: 'active',
  level: 'critical',
  windows: [
    { window: '5h', util: 0.1, resetAt: NOW + 4 * H },
    { window: 'week', util: 0.2, resetAt: NOW + 100 * H },
    { window: 'month', util: 1, resetAt: NOW + 400 * H },
  ],
})
const healthy = (name: string) => ({
  name,
  util5h: 0.02,
  util7d: 0.05,
  utilMonth: 0.3,
  status: 'active',
  level: 'ok',
  windows: [
    { window: '5h', util: 0.02, resetAt: NOW + 4 * H },
    { window: 'week', util: 0.05, resetAt: NOW + 150 * H },
    { window: 'month', util: 0.3, resetAt: NOW + 600 * H },
  ],
})

const dir = mkdtempSync(join(tmpdir(), 'select-org-'))
const quotaPath = join(dir, 'quota.json')
const tokensPath = join(dir, 'tokens.json')
const prevQuota = process.env.GO_QUOTA_PATH

const reg: GoRegistry = {
  active: 'hello@good',
  usageUrl: null,
  orgs: [org('hello@walled'), org('hello@good')],
}
const cfg = { goTokensPath: tokensPath, goOrgPinHoldOnUnusable: true } as any

writeFileSync(quotaPath, JSON.stringify({ orgs: [walled('hello@walled'), healthy('hello@good')] }))
writeFileSync(tokensPath, JSON.stringify({
  orgs: {
    'hello@walled': { access_token: 'a' },
    'hello@good': { access_token: 'b' },
  },
}))
process.env.GO_QUOTA_PATH = quotaPath

afterAll(() => {
  if (prevQuota === undefined) delete process.env.GO_QUOTA_PATH
  else process.env.GO_QUOTA_PATH = prevQuota
})

beforeEach(() => restorePinsForTest([]))

describe('названная организация за стеной', () => {
  test('ПОЛЮС 2: сессия есть, пина нет → имя оспаривается, берётся годная (инцидент 02.11)', () => {
    const r = selectOrg(reg, 'hello@walled', cfg, 'ses_new', true)
    expect(r.source).toBe('quota')
    expect(r.nameOverridden).toBe('hello@walled')
    expect(r.nameOverrideReason).toContain('exhausted')
    expect(r.org.name).toBe('hello@good')
  })

  test('ПОЛЮС 1: сессия С ВЫДАЧЕЙ не переезжает — держим до первого 429', () => {
    restorePinsForTest([['ses_pinned', { org: 'hello@walled', at: NOW }]])
    const r = selectOrg(reg, 'hello@walled', cfg, 'ses_pinned', true)
    // У ЯВНО названной организации источник остаётся `named` и при пине: имя уважается,
    // а `pin` в источнике появляется только на пути БЕЗ заголовка. Проверяем главное —
    // что выдача не потеряна и организация НЕ подменена.
    expect(r.org.name).toBe('hello@walled')
    expect(r.nameOverridden).toBeUndefined()
    expect(r.source).toBe('named')
  })

  test('ПОЛЮС 3: названа ЗДОРОВАЯ — имя уважаем, не оспариваем', () => {
    const r = selectOrg(reg, 'hello@good', cfg, 'ses_other', true)
    expect(r.source).toBe('named')
    expect(r.org.name).toBe('hello@good')
    expect(r.nameOverridden).toBeUndefined()
  })
})

describe('снятие выдачи при отказе (вторая половина инцидента 02.11)', () => {
  test('429 с ключом → снимаем (и при named, и при pin — источник не участвует)', async () => {
    const { shouldDropPinOnFailure } = await import('./modules/go-door.js')
    expect(shouldDropPinOnFailure(429, 'ses_x')).toBe(true)
    expect(shouldDropPinOnFailure(429, 'hard-16-hex-anchor')).toBe(true)
  })

  test('429 без ключа → снимать нечего, и это не падение', async () => {
    const { shouldDropPinOnFailure } = await import('./modules/go-door.js')
    expect(shouldDropPinOnFailure(429, null)).toBe(false)
    expect(shouldDropPinOnFailure(429, '')).toBe(false)
  })

  test('200 выдачу НЕ трогает — иначе живая сессия поедет на ровном месте', async () => {
    const { shouldDropPinOnFailure } = await import('./modules/go-door.js')
    expect(shouldDropPinOnFailure(200, 'ses_x')).toBe(false)
  })

  test('прочие отказы выдачу не снимают: 400/403/500 — не стена', async () => {
    const { shouldDropPinOnFailure } = await import('./modules/go-door.js')
    for (const st of [400, 401, 403, 500, 502, 503, 529]) expect(shouldDropPinOnFailure(st, 'ses_x')).toBe(false)
  })
})

describe('отдых организации после 429 (05.11.2026)', () => {
  const orgs = [{ name: 'a' }, { name: 'b' }]

  test('только что отказавшую убираем, если есть кем заменить', () => {
    const out = poolAfter429(orgs, 'a', Date.now() - 5_000, Date.now())
    expect(out.map((o) => o.name)).toEqual(['b'])
  })

  test('после отдыха она снова в пуле', () => {
    const out = poolAfter429(orgs, 'a', Date.now() - ORG_429_COOLDOWN_MS - 1, Date.now())
    expect(out.map((o) => o.name)).toEqual(['a', 'b'])
  })

  test('осталась одна — берём её: пустой выбор хуже перегруженной', () => {
    const out = poolAfter429([{ name: 'a' }], 'a', Date.now() - 1_000, Date.now())
    expect(out.map((o) => o.name)).toEqual(['a'])
  })

  test('отдыха не было — пул не трогаем', () => {
    const out = poolAfter429(orgs, null, null, Date.now())
    expect(out.map((o) => o.name)).toEqual(['a', 'b'])
  })
})
