/**
 * Tests: go-door — реестр организаций, единая точка выдачи пропуска, дамп provider-dump/v1.
 * Шлюз подменён локальным сервером: проверяем, ЧТО уходит поставщику (пропуск, заголовок
 * организации) и ЧТО ложится в дамп (одна запись на вызов, секрета в нём нет).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseRegistry, pickOrg, GoOrgError, GoRegistryError } from '../src/go-registry.js'
import { withGoCredential, GoCredentialError } from '../src/go-credentials.js'
import { extractUsageChat, extractUsageResponses, usageFromSseText, classifyError } from '../src/provider-dump.js'
import { createGoDoorModule, goDoorReadiness } from '../src/modules/go-door.js'

const REG = `
active: org-b
usage_url: https://example.invalid/usage
orgs:
  - name: org-a
    workspace: wrk_A
    synqtask_org_uid: uid-a
    auth: console
    base_url: GATEWAY/openai/v1
    priority: 1
  - name: org-b
    workspace: wrk_B
    synqtask_org_uid: uid-b
    auth: console
    base_url: GATEWAY/openai/v1
    priority: 1
  - name: key-org
    workspace: wrk_K
    auth: api_key
    env: TEST_GO_KEY
    base_url: GATEWAY/zen/go/v1
    priority: 2
`

describe('go-registry', () => {
  const reg = parseRegistry(REG)
  test('без названия — рабочая', () => expect(pickOrg(reg, null).name).toBe('org-b'))
  test('по uid SynqTask', () => expect(pickOrg(reg, 'uid-a').name).toBe('org-a'))
  test('по имени', () => expect(pickOrg(reg, 'key-org').name).toBe('key-org'))
  test('названная и не найденная — отказ, не подмена', () => {
    expect(() => pickOrg(reg, 'nope')).toThrow(GoOrgError)
  })
  test('рабочая не описана — отказ', () => {
    expect(() => parseRegistry('active: x\norgs:\n  - name: y\n    workspace: w\n    auth: console\n    base_url: u')).toThrow(GoRegistryError)
  })
})

describe('withGoCredential', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-cred-'))
  const tokens = join(dir, 'tokens.json')
  const now = 1_000_000
  const src = (extra: Partial<Parameters<typeof withGoCredential>[1]> = {}) => ({
    tokensPath: tokens, environ: {} as Record<string, string | undefined>, now: () => now, userAgent: 'ua/1', ...extra,
  })
  const reg = parseRegistry(REG)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('пропуск консоли + заголовок организации', () => {
    writeFileSync(tokens, JSON.stringify({ orgs: { 'org-b': { access_token: 'SECRET-B', expiry_ms: now + 10 * 60_000 } } }))
    const c = withGoCredential(pickOrg(reg, 'org-b'), src())
    expect(c.secret).toBe('SECRET-B')
    expect(c.headers['x-opencode-org-id']).toBe('wrk_B')
  })
  test('истёкший пропуск — отказ, значения нет в тексте ошибки', () => {
    writeFileSync(tokens, JSON.stringify({ orgs: { 'org-b': { access_token: 'SECRET-B', expiry_ms: now + 1000 } } }))
    try { withGoCredential(pickOrg(reg, 'org-b'), src()); throw new Error('must throw') }
    catch (e: any) { expect(e).toBeInstanceOf(GoCredentialError); expect(e.reason).toBe('expired'); expect(String(e.message)).not.toContain('SECRET-B') }
  })
  test('нет пропуска этой организации — отказ, чужой не берётся', () => {
    writeFileSync(tokens, JSON.stringify({ orgs: { 'org-a': { access_token: 'SECRET-A', expiry_ms: now + 10 * 60_000 } } }))
    expect(() => withGoCredential(pickOrg(reg, 'org-b'), src())).toThrow(GoCredentialError)
  })
  test('ключ API из окружения, заголовка организации нет', () => {
    const c = withGoCredential(pickOrg(reg, 'key-org'), src({ environ: { TEST_GO_KEY: 'K1' } }))
    expect(c.secret).toBe('K1')
    expect(c.headers['x-opencode-org-id']).toBeUndefined()
  })
})

describe('usage extractors', () => {
  test('chat: кэш из prompt_tokens_details, записи в кэш нет → null', () => {
    const u = extractUsageChat({ prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 90 } })
    expect(u).toMatchObject({ input: 100, output: 5, cache_read: 90, cache_write: null })
  })
  test('responses: input_tokens_details.cached_tokens', () => {
    expect(extractUsageResponses({ input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 8 } }).cache_read).toBe(8)
  })
  test('нет usage — всё null, не 0', () => {
    expect(extractUsageChat(null).cache_read).toBeNull()
  })
  test('usage из SSE-текста', () => {
    const t = 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":7,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
    expect((usageFromSseText(t) as any).prompt_tokens).toBe(7)
  })
  test('классы ошибок', () => {
    expect(classifyError(429, false)?.kind).toBe('quota')
    expect(classifyError(403, false)?.kind).toBe('auth')
    expect(classifyError(null, true)?.kind).toBe('network')
    expect(classifyError(200, false)).toBeNull()
  })
})

describe('go-door end to end (шлюз подменён)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-door-'))
  const dumpDir = join(dir, 'dump')
  const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
  let gateway: ReturnType<typeof Bun.serve>
  let handler: (req: Request) => Promise<Response>
  const emitted: any[] = []

  beforeAll(() => {
    gateway = Bun.serve({
      port: 0,
      async fetch(req) {
        const h: Record<string, string> = {}
        req.headers.forEach((v, k) => { h[k] = v })
        seen.push({ url: new URL(req.url).pathname, headers: h, body: await req.text() })
        if (h['x-opencode-org-id'] === 'wrk_A') {
          return new Response(JSON.stringify({ error: { message: 'weekly limit' } }), { status: 429, headers: { 'retry-after': '60', 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({ id: 'x', usage: { prompt_tokens: 50, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 40 } } }),
          { headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '77' } })
      },
    })
    const base = `http://127.0.0.1:${gateway.port}`
    writeFileSync(join(dir, 'reg.yaml'), REG.replaceAll('GATEWAY', base))
    writeFileSync(join(dir, 'tokens.json'), JSON.stringify({ orgs: {
      'org-a': { access_token: 'TOK-A-SECRET', expiry_ms: Date.now() + 3_600_000 },
      'org-b': { access_token: 'TOK-B-SECRET', expiry_ms: Date.now() + 3_600_000 },
    } }))
    process.env.PROVIDER_DUMP_DIR = dumpDir
    const mod = createGoDoorModule()
    mod.init({
      emit: (e: any) => { emitted.push(e) },
      config: { goRegistryPath: join(dir, 'reg.yaml'), goTokensPath: join(dir, 'tokens.json'), goUserAgent: 'ua/1', goProviderSession: 'fixed-session' } as any,
      proxyClient: {} as any, managedSessions: {} as any, version: 'test',
    })
    const route = mod.routes.find(r => r.path === '/go/chat/completions')!
    handler = (req) => route.handler(req, { requestIP: () => null })
  })
  afterAll(() => { gateway.stop(true); delete process.env.PROVIDER_DUMP_DIR; rmSync(dir, { recursive: true, force: true }) })

  const post = (headers: Record<string, string> = {}) => handler(new Request('http://x/go/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
  }))
  const records = () => {
    const f = readdirSync(dumpDir)
    return f.flatMap(n => readFileSync(join(dumpDir, n), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)))
  }
  const flush = () => new Promise(r => setTimeout(r, 50))

  test('рабочая организация: пропуск, заголовок организации, постоянный x-opencode-session', async () => {
    const res = await post({ 'x-litellm-session-id': 'conv-1' })
    expect(res.status).toBe(200)
    const s = seen.at(-1)!
    expect(s.headers.authorization).toBe('Bearer TOK-B-SECRET')
    expect(s.headers['x-opencode-org-id']).toBe('wrk_B')
    expect(s.headers['x-opencode-session']).toBe('fixed-session')
    expect(s.url).toBe('/openai/v1/chat/completions')
    await flush()
    const r = records().at(-1)
    expect(r.v).toBe(1)
    expect(r.org_id).toBe('org-b')
    expect(r.session_id).toBe('conv-1')
    expect(r.call_kind).toBe('real')
    expect(r.usage_norm).toMatchObject({ input: 50, output: 3, cache_read: 40, cache_write: null })
    expect(r.quota_seen['x-ratelimit-remaining']).toBe('77')
  })

  test('в дамп не попадает ни пропуск, ни тело людей', async () => {
    await flush()
    const all = readdirSync(dumpDir).map(n => readFileSync(join(dumpDir, n), 'utf8')).join('')
    expect(all).not.toContain('TOK-B-SECRET')
    expect(all).not.toContain('TOK-A-SECRET')
    expect(all).not.toContain('"hi"')
  })

  test('организация по uid; её отказ квоты доезжает как 429 и пишет запись об отказе', async () => {
    const before = records().length
    const res = await post({ 'x-kiberos-go-org': 'uid-a', 'x-kiberos-call-kind': 'warm' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    await flush()
    const recs = records()
    expect(recs.length).toBe(before + 1)
    const r = recs.at(-1)
    expect(r.org_id).toBe('org-a')
    expect(r.call_kind).toBe('warm')
    expect(r.error.kind).toBe('quota')
    expect(r.response.status).toBe(429)
  })

  test('названная организация, которой нет, — 400, до поставщика не доходит', async () => {
    const n = seen.length
    const res = await post({ 'x-kiberos-go-org': 'ghost' })
    expect(res.status).toBe(400)
    expect(seen.length).toBe(n)
  })
})

/**
 * Готовность двери БЕЗ пробы (S5/D5). Дверь, у которой не заданы пути, отвечает 503 —
 * и до 17.10.2026 это было единственным способом узнать о ней, поэтому «модуль
 * загружен» читалось как «дверь работает» (сервер kiberos.ai читался именно так).
 */
describe('goDoorReadiness', () => {
  const cfgWith = (o: Record<string, unknown>) => ({ ...o }) as any

  test('оба пути заданы — дверь настроена, недостающих нет', () => {
    const r = goDoorReadiness(cfgWith({ goRegistryPath: '/x/go-orgs.yaml', goTokensPath: '/x/.go-tokens.json' }))
    expect(r.configured).toBe(true)
    expect(r.missing).toEqual([])
  })

  test('пути не заданы — названы ОБА, дверь не настроена', () => {
    const r = goDoorReadiness(cfgWith({ goRegistryPath: null, goTokensPath: null }))
    expect(r.configured).toBe(false)
    expect(r.missing).toEqual(['GO_REGISTRY_PATH', 'GO_TOKENS_PATH'])
  })

  test('не хватает только пропусков — назван только он', () => {
    const r = goDoorReadiness(cfgWith({ goRegistryPath: '/x/go-orgs.yaml', goTokensPath: null }))
    expect(r.configured).toBe(false)
    expect(r.missing).toEqual(['GO_TOKENS_PATH'])
  })
})

/**
 * Продление по 401 (GO_TOKEN_REFRESH_ENABLED='true'): ОДНО продление и ОДИН повтор.
 *
 * ЖИВЁТ ЗДЕСЬ, А НЕ ОТДЕЛЬНЫМ ФАЙЛОМ, нарочно: `ctx` двери — глобал на процесс, а
 * PROVIDER_DUMP_DIR — переменная процесса; Bun гоняет файлы без изоляции, и второй init
 * в другом файле уже один раз увёл дамп соседа (проверено: 3 падения в общем прогоне).
 */
describe('go-door: 401 → продление → один повтор', () => {
  const dir = mkdtempSync(join(tmpdir(), 'go-door-refresh-'))
  const tokens = join(dir, 'tokens.json')
  const dumpDir = join(dir, 'dump')
  const calls = { chat: 0, refresh: 0, auth: [] as Array<string | null> }
  const DAY = 86_400_000
  let gateway: ReturnType<typeof Bun.serve>
  let handler: (req: Request) => Promise<Response>
  let savedFlag: string | undefined
  let savedDump: string | undefined

  const body = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

  beforeAll(() => {
    gateway = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        if (path === '/auth/device/token') {
          calls.refresh++
          return body({ access_token: 'DOOR-NEW', refresh_token: 'DOOR-R2', expires_in: 2_592_000 })
        }
        if (path.endsWith('/chat/completions')) {
          calls.chat++
          if (calls.chat === 1) return body({ error: { message: 'token expired' } }, 401)
          calls.auth.push(req.headers.get('authorization'))
          return body({ id: 'x', usage: { prompt_tokens: 1, completion_tokens: 1 } })
        }
        return new Response('not found', { status: 404 })
      },
    })
    const base = `http://127.0.0.1:${gateway.port}`
    writeFileSync(join(dir, 'reg.yaml'), [
      'active: org-b',
      `usage_url: ${base}/usage`,
      'orgs:',
      '  - name: org-b',
      '    workspace: wrk_B',
      '    auth: console',
      `    account_url: ${base}`,
      `    base_url: ${base}/openai/v1`,
      '    priority: 1',
      '',
    ].join('\n'))
    // Пропуск СВЕЖИЙ: порог не срабатывает, продление обязано случиться именно по 401.
    writeFileSync(tokens, JSON.stringify({
      orgs: { 'org-b': { access_token: 'DOOR-OLD', refresh_token: 'DOOR-R1', expiry_ms: Date.now() + 20 * DAY } },
    }))
    savedDump = process.env.PROVIDER_DUMP_DIR
    savedFlag = process.env.GO_TOKEN_REFRESH_ENABLED
    process.env.PROVIDER_DUMP_DIR = dumpDir
    process.env.GO_TOKEN_REFRESH_ENABLED = 'true'
    const mod = createGoDoorModule()
    mod.init({
      emit: () => {},
      config: {
        goRegistryPath: join(dir, 'reg.yaml'), goTokensPath: tokens,
        goUserAgent: 'kiberos-chat/1.0', goProviderSession: 'fixed-session',
      } as any,
      proxyClient: {} as any, managedSessions: {} as any, version: 'test',
    })
    handler = (req) => mod.routes.find(r => r.path === '/go/chat/completions')!.handler(req, { requestIP: () => null })
  })

  afterAll(() => {
    gateway.stop(true)
    if (savedDump === undefined) delete process.env.PROVIDER_DUMP_DIR
    else process.env.PROVIDER_DUMP_DIR = savedDump
    if (savedFlag === undefined) delete process.env.GO_TOKEN_REFRESH_ENABLED
    else process.env.GO_TOKEN_REFRESH_ENABLED = savedFlag
    rmSync(dir, { recursive: true, force: true })
  })

  test('401 консольной организации: одно продление, один повтор с новым пропуском', async () => {
    const res = await handler(new Request('http://x/go/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-litellm-session-id': 'conv-401' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }),
    }))
    expect(res.status).toBe(200)
    expect(calls.chat).toBe(2)
    expect(calls.refresh).toBe(1)
    expect(calls.auth.at(-1)).toBe('Bearer DOOR-NEW')
    expect(JSON.parse(readFileSync(tokens, 'utf8')).orgs['org-b'].access_token).toBe('DOOR-NEW')
  })
})
