/**
 * Испытания продления пропуска OpenCode Go. Сети НЕТ: fetch подменён, часы подменены,
 * хранилище — во временном каталоге (mkdtemp). Настоящие пропуска не читаются.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GO_INCOMING_FILE, REFRESH_THRESHOLD_MS, forceRefreshGoCredential, goTokenRefreshEnabled, mergeIncomingTokens,
  withFreshGoCredential,
} from './go-token-refresh.js'
import type { CredentialSources } from './go-credentials.js'
import type { GoOrg } from './go-registry.js'

const DAY = 86_400_000
const NOW = 1_800_000_000_000
const ORG_NAME = 'org-b'
const OTHER_ENTRY = { access_token: 'OTHER-SECRET', refresh_token: 'OTHER-REFRESH', expiry_ms: NOW + 20 * DAY, note: 'keep me' }

function makeOrg(over: Partial<GoOrg> = {}): GoOrg {
  return {
    name: ORG_NAME,
    workspace: 'wrk_B',
    auth: 'console',
    baseUrl: 'https://gateway.invalid/openai/v1',
    accountUrl: 'https://console.invalid',
    synqtaskOrgUid: null,
    env: null,
    priority: 1,
    ...over,
  }
}

type Call = { url: string; init: any }

function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (input: any, init?: any) => {
    const call = { url: String(input), init }
    calls.push(call)
    return handler(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const OK_BODY = { access_token: 'NEW-ACCESS', refresh_token: 'NEW-REFRESH', expires_in: 2_592_000 }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('go-token-refresh (unit)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-refresh-'))
  const tokensPath = join(dir, 'tokens.json')

  const writeStore = (entry: Record<string, unknown>) => {
    writeFileSync(tokensPath, JSON.stringify({ orgs: { [ORG_NAME]: entry, 'other-org': OTHER_ENTRY } }))
  }
  const src = (over: Partial<CredentialSources> = {}): CredentialSources => ({
    tokensPath,
    environ: { GO_TOKEN_REFRESH_ENABLED: 'true' },
    now: () => NOW,
    userAgent: 'kiberos-chat/1.0',
    ...over,
  })
  const leftovers = () => readdirSync(dir).filter(n => n.endsWith('.tmp'))

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('флаг не задан — флаг выключен', () => {
    expect(goTokenRefreshEnabled({})).toBe(false)
    expect(goTokenRefreshEnabled(undefined)).toBe(false)
    expect(goTokenRefreshEnabled({ GO_TOKEN_REFRESH_ENABLED: 'TRUE' })).toBe(false)
    expect(goTokenRefreshEnabled({ GO_TOKEN_REFRESH_ENABLED: 'true' })).toBe(true)
  })

  test('флаг выключен — прежнее поведение: expired, ноль запросов, mtime не тронут', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW - 1000 })
    const before = statSync(tokensPath).mtimeMs
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    let err: any
    try { await withFreshGoCredential(makeOrg(), src({ environ: {} }), { fetchImpl: fn }) } catch (e) { err = e }
    expect(err?.reason).toBe('expired')
    expect(calls.length).toBe(0)
    expect(statSync(tokensPath).mtimeMs).toBe(before)
  })

  test('флаг выключен — force тоже только читает (expired), сети нет', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW - 1000 })
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    let err: any
    try { await forceRefreshGoCredential(makeOrg(), src({ environ: {} }), { failedToken: 'OLD' }, { fetchImpl: fn }) } catch (e) { err = e }
    expect(err?.reason).toBe('expired')
    expect(calls.length).toBe(0)
  })

  test('свежий пропуск — отдан без сети', async () => {
    writeStore({ access_token: 'FRESH', refresh_token: 'R1', expiry_ms: NOW + 10 * DAY })
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    const c = await withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn })
    expect(c.secret).toBe('FRESH')
    expect(c.headers['x-opencode-org-id']).toBe('wrk_B')
    expect(calls.length).toBe(0)
  })

  test('ровно семь суток остатка — ещё не продлеваем (порог как DEFAULT_THRESHOLD_DAYS)', async () => {
    writeStore({ access_token: 'EDGE', refresh_token: 'R1', expiry_ms: NOW + REFRESH_THRESHOLD_MS })
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    const c = await withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn })
    expect(c.secret).toBe('EDGE')
    expect(calls.length).toBe(0)
  })

  test('шесть суток — ОДИН POST, тело и заголовки точные, запись атомарна, сосед байт в байт', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY, pushed_at_ms: 42 })
    const inodeBefore = statSync(tokensPath).ino
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    const c = await withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn })

    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('https://console.invalid/auth/device/token')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['user-agent']).toBe('kiberos-chat/1.0')
    expect(calls[0].init.headers['content-type']).toBe('application/json')
    expect(calls[0].init.body).toBe(JSON.stringify({
      grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'opencode-cli',
    }))
    expect(c.secret).toBe('NEW-ACCESS')

    const raw = readFileSync(tokensPath, 'utf8')
    const doc = JSON.parse(raw)
    expect(doc.orgs[ORG_NAME]).toMatchObject({
      access_token: 'NEW-ACCESS',
      refresh_token: 'NEW-REFRESH',
      expiry_ms: NOW + 2_592_000 * 1000,
      refreshed_at_ms: NOW,
      pushed_at_ms: 42,
    })
    // Соседняя организация не пересериализована: её кусок текста присутствует дословно.
    expect(doc.orgs['other-org']).toEqual(OTHER_ENTRY)
    expect(raw).toContain(JSON.stringify(OTHER_ENTRY))
    expect(raw).not.toContain('OLD')
    expect(statSync(tokensPath).mode & 0o777).toBe(0o600)
    // rename над хранилищем = новая индексация: читатели, смонтировавшие КАТАЛОГ, видят подмену атомарно.
    expect(statSync(tokensPath).ino).not.toBe(inodeBefore)
    expect(leftovers()).toEqual([])
  })

  test('403 browser_signature_banned — отказ называет имя клиента, хранилище не тронуто', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY })
    const before = readFileSync(tokensPath, 'utf8')
    const { fn, calls } = fakeFetch(() => jsonResponse({
      error: { message: 'Error 1010: browser_signature_banned — your user-agent has been banned by the site owner' },
    }, 403))
    let err: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn }) } catch (e) { err = e }
    expect(calls.length).toBe(1)
    expect(err?.reason).toBe('refresh_ua_banned')
    expect(String(err?.message)).toContain('user-agent')
    expect(String(err?.message)).not.toContain('R1')
    expect(readFileSync(tokensPath, 'utf8')).toBe(before)
    expect(leftovers()).toEqual([])
  })

  test('сеть / не-200 / неразборчивый ответ / нет refresh_token — отказ с причиной', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY })

    const net = fakeFetch(() => { throw new Error('ECONNREFUSED') })
    let e1: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: net.fn }) } catch (e) { e1 = e }
    expect(e1?.reason).toBe('refresh_network')

    const http500 = fakeFetch(() => jsonResponse({ error: 'boom' }, 500))
    let e2: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: http500.fn }) } catch (e) { e2 = e }
    expect(e2?.reason).toBe('refresh_http')

    const broken = fakeFetch(() => new Response('not json', { status: 200 }))
    let e3: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: broken.fn }) } catch (e) { e3 = e }
    expect(e3?.reason).toBe('refresh_bad_body')

    const noRotate = fakeFetch(() => jsonResponse({ access_token: 'A', expires_in: 3600 }))
    let e4: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: noRotate.fn }) } catch (e) { e4 = e }
    expect(e4?.reason).toBe('refresh_bad_body')

    writeStore({ access_token: 'OLD', expiry_ms: NOW + 6 * DAY })
    let e5: any
    try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: noRotate.fn }) } catch (e) { e5 = e }
    expect(e5?.reason).toBe('no_refresh_token')
  })

  test('нет account_url — не догадываемся об адресе', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY })
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    let err: any
    try { await withFreshGoCredential(makeOrg({ accountUrl: null }), src(), { fetchImpl: fn }) } catch (e) { err = e }
    expect(err?.reason).toBe('no_account_url')
    expect(calls.length).toBe(0)
  })

  test('два одновременных вызова одной организации — РОВНО один запрос', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY })
    const { fn, calls } = fakeFetch(async () => {
      await new Promise(r => setTimeout(r, 15))
      return jsonResponse(OK_BODY)
    })
    const [a, b] = await Promise.all([
      withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn }),
      withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn }),
    ])
    expect(calls.length).toBe(1)
    expect(a.secret).toBe('NEW-ACCESS')
    expect(b.secret).toBe('NEW-ACCESS')
  })

  test('force: тот же пропуск — продлевает; в хранилище уже новее — отдаёт без сети', async () => {
    writeStore({ access_token: 'FAILED', refresh_token: 'R1', expiry_ms: NOW + 20 * DAY })
    const first = fakeFetch(() => jsonResponse(OK_BODY))
    const c1 = await forceRefreshGoCredential(makeOrg(), src(), { failedToken: 'FAILED' }, { fetchImpl: first.fn })
    expect(first.calls.length).toBe(1)
    expect(c1.secret).toBe('NEW-ACCESS')

    writeStore({ access_token: 'NEWER', refresh_token: 'R2', expiry_ms: NOW + 20 * DAY })
    const second = fakeFetch(() => jsonResponse(OK_BODY))
    const c2 = await forceRefreshGoCredential(makeOrg(), src(), { failedToken: 'FAILED' }, { fetchImpl: second.fn })
    expect(second.calls.length).toBe(0)
    expect(c2.secret).toBe('NEWER')
  })

  test('запись невозможна — отказ, исходное хранилище цело', async () => {
    writeStore({ access_token: 'OLD', refresh_token: 'R1', expiry_ms: NOW + 6 * DAY })
    const before = readFileSync(tokensPath, 'utf8')
    const { fn } = fakeFetch(() => jsonResponse(OK_BODY))
    chmodSync(dir, 0o500)
    let err: any
    try {
      try { await withFreshGoCredential(makeOrg(), src(), { fetchImpl: fn }) } catch (e) { err = e }
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(err?.reason).toBe('write_failed')
    expect(readFileSync(tokensPath, 'utf8')).toBe(before)
  })

  test('ключ API не продлевается — путь прежний, сети нет', async () => {
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    const c = await withFreshGoCredential(
      makeOrg({ name: 'key-org', auth: 'api_key', env: 'GO_KEY' }),
      src({ environ: { GO_TOKEN_REFRESH_ENABLED: 'true', GO_KEY: 'K1' } }),
      { fetchImpl: fn },
    )
    expect(c.secret).toBe('K1')
    expect(calls.length).toBe(0)
  })
})


describe('новые входы: машина пишет incoming, мы вливаем', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-incoming-'))
  const tokensPath = join(dir, 'tokens.json')
  const incomingPath = join(dir, GO_INCOMING_FILE)
  const srcIn = (over: Partial<CredentialSources> = {}): CredentialSources => ({
    tokensPath,
    environ: { GO_TOKEN_REFRESH_ENABLED: 'true' },
    now: () => NOW,
    userAgent: 'kiberos-chat/1.0',
    ...over,
  })
  const store = (orgs: Record<string, unknown>) => writeFileSync(tokensPath, JSON.stringify({ orgs }))
  const readStore = () => JSON.parse(readFileSync(tokensPath, 'utf8'))
  const exists = () => { try { statSync(incomingPath); return true } catch { return false } }

  afterAll(() => { try { chmodSync(dir, 0o700) } catch { /* мог не быть заперт */ } ; rmSync(dir, { recursive: true, force: true }) })

  test('новая организация из incoming влита, файл убран, соседи байт в байт', async () => {
    store({ 'other-org': OTHER_ENTRY })
    const before = JSON.stringify(readStore().orgs['other-org'])
    writeFileSync(incomingPath, JSON.stringify({ orgs: { 'new-org': { access_token: 'A1', refresh_token: 'R1', expiry_ms: NOW + 30 * DAY } } }))
    const r = await mergeIncomingTokens(tokensPath)
    expect(r.merged).toEqual(['new-org'])
    expect(readStore().orgs['new-org'].access_token).toBe('A1')
    expect(JSON.stringify(readStore().orgs['other-org'])).toBe(before)
    expect(exists()).toBe(false)
  })

  test('устаревший incoming не затирает более свежий пропуск (решает expiry_ms)', async () => {
    store({ 'new-org': { access_token: 'FRESH', refresh_token: 'RF', expiry_ms: NOW + 30 * DAY }, 'other-org': OTHER_ENTRY })
    writeFileSync(incomingPath, JSON.stringify({ orgs: { 'new-org': { access_token: 'STALE', refresh_token: 'RS', expiry_ms: NOW + 5 * DAY } } }))
    const r = await mergeIncomingTokens(tokensPath)
    expect(r.merged).toEqual([])
    expect(readStore().orgs['new-org'].access_token).toBe('FRESH')
    expect(exists()).toBe(false)
  })

  test('более свежий incoming заменяет запись', async () => {
    store({ 'new-org': { access_token: 'OLD', refresh_token: 'RO', expiry_ms: NOW + 5 * DAY } })
    writeFileSync(incomingPath, JSON.stringify({ orgs: { 'new-org': { access_token: 'NEW', refresh_token: 'RN', expiry_ms: NOW + 30 * DAY } } }))
    const r = await mergeIncomingTokens(tokensPath)
    expect(r.merged).toEqual(['new-org'])
    expect(readStore().orgs['new-org'].access_token).toBe('NEW')
  })

  test('битый incoming — ошибка названа, файл и хранилище не тронуты', async () => {
    store({ 'other-org': OTHER_ENTRY })
    const before = readFileSync(tokensPath, 'utf8')
    writeFileSync(incomingPath, '{не json')
    const r = await mergeIncomingTokens(tokensPath)
    expect(r.error).toBeTruthy()
    expect(readFileSync(tokensPath, 'utf8')).toBe(before)
    expect(exists()).toBe(true)
  })

  test('флаг выключен — вливания нет (проводка, а не сама функция)', async () => {
    store({ [ORG_NAME]: { access_token: 'FRESH', refresh_token: 'R1', expiry_ms: NOW + 10 * DAY } })
    writeFileSync(incomingPath, JSON.stringify({ orgs: { 'new-org': { access_token: 'A1', refresh_token: 'R1', expiry_ms: NOW + 30 * DAY } } }))
    const { fn, calls } = fakeFetch(() => jsonResponse(OK_BODY))
    await withFreshGoCredential(makeOrg(), srcIn({ environ: {} }), { fetchImpl: fn })
    expect(calls.length).toBe(0)
    expect(readStore().orgs['new-org']).toBeUndefined()
    expect(exists()).toBe(true)
  })
})
