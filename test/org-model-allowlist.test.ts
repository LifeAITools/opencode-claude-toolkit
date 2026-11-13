/**
 * Организация Anthropic под ОДНУ модель (слово фаундера 13.11.2026, голос TG 85103).
 *
 * Третья организация — только для claude-fable-5-2: у Fable 5.2 есть сбросы квоты, у остальных
 * моделей нет, и любая другая модель на этой организации сожгла бы объём, ради которого её
 * подключают. Правило в обе стороны:
 *   — модель из списка организации садится ТОЛЬКО на организации, где она разрешена;
 *   — модель вне списка эту организацию НЕ видит, даже при лучшем запасе.
 * Правило живёт отдельно от регулятора (`enabled`): оно действует и при выключенном ПИД, и когда
 * разрешённая организация ОДНА — именно тогда прежний выбор «сравнивать не с чем» отдал бы
 * сессию активной организации машины. Живую сессию не трогает (выбор только при рождении).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { orgsAllowedForModel, parseModelAllowlist } from '../src/org-model-allowlist.js'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { OrgVault } from '../src/org-vault.js'

const RULES = parseModelAllowlist({ orgModels: { 'org-f': ['claude-fable-5-2'] } })

describe('orgsAllowedForModel — чистое правило', () => {
  const all = ['org-a', 'org-b', 'org-f']

  test('модель из списка — только на свою организацию', () => {
    expect(orgsAllowedForModel(RULES, all, 'claude-fable-5-2')).toEqual({ allowed: ['org-f'], exclusive: true })
  })

  test('имя с [1m] — та же модель', () => {
    expect(orgsAllowedForModel(RULES, all, 'claude-fable-5-2[1m]').allowed).toEqual(['org-f'])
  })

  test('модель вне списка организацию со списком не видит', () => {
    expect(orgsAllowedForModel(RULES, all, 'claude-opus-5-5')).toEqual({ allowed: ['org-a', 'org-b'], exclusive: false })
  })

  test('организация задаётся префиксом номера, как у drain', () => {
    const r = parseModelAllowlist({ orgModels: { 'b3219c9b': ['claude-fable-5-2'] } })
    expect(orgsAllowedForModel(r, ['b3219c9b-0b6e-4e9e', 'org-a'], 'claude-opus-5-5').allowed).toEqual(['org-a'])
  })

  test('нет правил — все организации, ничего не меняется', () => {
    const none = parseModelAllowlist(null)
    expect(orgsAllowedForModel(none, all, 'claude-opus-5-5')).toEqual({ allowed: all, exclusive: false })
    expect(none.size).toBe(0)
  })

  test('битая запись не роняет разбор', () => {
    const r = parseModelAllowlist({ orgModels: { 'org-x': 'not-a-list', '': ['m'], 'org-y': [1, 'claude-fable-5-2'] } })
    expect([...r.keys()]).toEqual(['org-y'])
  })
})

// ── Через прокси: где именно лазейка была бы без правила ────────────────────────────────
const H = 3_600_000
const TMP = mkdtempSync(join(tmpdir(), 'org-model-'))
const ISOLATED = {
  accountConfigPath: join(TMP, 'no-claude.json'),
  credentialsPath: join(TMP, 'credentials.json'),
  claudeConfigDir: join(TMP, 'no-config'),
}
const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
let seq = 0
const body = (model: string) => JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] })

function setup(active: 'org-a' | 'org-f', withB = true) {
  const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
  const exp = Date.now() + 3 * H
  const tok = (o: string) => `tok-${o}`
  vault.upsert({ orgId: 'org-a', accessToken: tok('org-a'), refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
  if (withB) vault.upsert({ orgId: 'org-b', accessToken: tok('org-b'), refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
  vault.upsert({ orgId: 'org-f', accessToken: tok('org-f'), refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
  writeFileSync(ISOLATED.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: tok(active), refreshToken: null, expiresAt: exp } }))
  const cfg = join(TMP, `placement-${seq++}.json`)
  writeFileSync(cfg, JSON.stringify({ enabled: false, orgModels: { 'org-f': ['claude-fable-5-2'] } }))
  const auth: string[] = []
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => tok(active), invalidate() {}, currentExpiresAt: () => exp },
    upstreamFetcher: { fetch: async (_u: string, init: any) => { auth.push(init.headers.authorization ?? init.headers.Authorization); return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } },
    orgUsageReader: { read: async () => null },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => active, invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    orgVault: vault,
    placementConfigPath: cfg,
    ...ISOLATED,
  } as ProxyClientOptions)
  const now = Date.now()
  const w = (u: number) => [{ name: '5h', util: u, resetAt: now + H }, { name: 'week', util: u, resetAt: now + 24 * H }]
  // Fable-организация свободнее всех: без правила выбор по запасу отдал бы её любой модели.
  c._setOrgUsage({ orgId: 'org-a', measuredAt: now, windows: w(0.5) })
  if (withB) c._setOrgUsage({ orgId: 'org-b', measuredAt: now, windows: w(0.6) })
  c._setOrgUsage({ orgId: 'org-f', measuredAt: now, windows: w(0.01) })
  return { c, auth, vault }
}

describe('ProxyClient — модель и организация при рождении', () => {
  test('Opus не садится на Fable-организацию, хотя у неё лучший запас', async () => {
    const { c, auth, vault } = setup('org-a')
    await c.handleRequest(body('claude-opus-5-5'), {}, { sessionId: 'opus-1' })
    expect(auth.at(-1)).not.toBe('Bearer tok-org-f')
    expect(vault.getPin('opus-1')?.orgId).not.toBe('org-f')
    c.stop()
  })

  test('Opus уходит с Fable-организации, даже когда она АКТИВНАЯ на машине', async () => {
    const { c, auth, vault } = setup('org-f')
    await c.handleRequest(body('claude-opus-5-5'), {}, { sessionId: 'opus-2' })
    expect(auth.at(-1)).not.toBe('Bearer tok-org-f')
    expect(vault.getPin('opus-2')?.orgId).not.toBe('org-f')
    c.stop()
  })

  test('Fable садится на свою организацию, хотя активна другая', async () => {
    const { c, auth, vault } = setup('org-a')
    await c.handleRequest(body('claude-fable-5-2'), {}, { sessionId: 'fable-1' })
    expect(auth.at(-1)).toBe('Bearer tok-org-f')
    expect(vault.getPin('fable-1')).toEqual({ orgId: 'org-f' })
    c.stop()
  })

  test('Fable садится на свою, даже когда разрешённая организация одна (сравнивать не с чем)', async () => {
    const { c, auth } = setup('org-a', false)
    await c.handleRequest(body('claude-fable-5-2[1m]'), {}, { sessionId: 'fable-2' })
    expect(auth.at(-1)).toBe('Bearer tok-org-f')
    c.stop()
  })

  test('Fable-организация — единственная живая: Opus получает названный отказ, а не тратит её', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    const exp = Date.now() + 3 * H
    vault.upsert({ orgId: 'org-f', accessToken: 'tok-org-f', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
    writeFileSync(ISOLATED.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-org-f', refreshToken: null, expiresAt: exp } }))
    const cfg = join(TMP, `placement-${seq++}.json`)
    writeFileSync(cfg, JSON.stringify({ orgModels: { 'org-f': ['claude-fable-5-2'] } }))
    let upstream = 0
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1 },
      credentialsProvider: { getAccessToken: async () => 'tok-org-f', invalidate() {}, currentExpiresAt: () => exp },
      upstreamFetcher: { fetch: async () => { upstream++; return new Response(SSE, { status: 200 }) } },
      orgUsageReader: { read: async () => null },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-f', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault,
      placementConfigPath: cfg, ...ISOLATED,
    } as ProxyClientOptions)
    const r = await c.handleRequest(body('claude-opus-5-5'), {}, { sessionId: 'opus-only-f' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string; message?: string } }
    expect(j.error?.type).toBe('model_guard')
    expect(j.error?.message?.startsWith('Model guard')).toBe(true)
    expect(upstream).toBe(0)
    c.stop()
  })

  test('без правила в файле — прежнее поведение, отказа нет', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    const exp = Date.now() + 3 * H
    vault.upsert({ orgId: 'org-f', accessToken: 'tok-org-f', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
    writeFileSync(ISOLATED.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-org-f', refreshToken: null, expiresAt: exp } }))
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1 },
      credentialsProvider: { getAccessToken: async () => 'tok-org-f', invalidate() {}, currentExpiresAt: () => exp },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }) },
      orgUsageReader: { read: async () => null },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-f', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault,
      placementConfigPath: join(TMP, 'absent.json'), ...ISOLATED,
    } as ProxyClientOptions)
    const r = await c.handleRequest(body('claude-opus-5-5'), {}, { sessionId: 'no-rule' })
    expect(r.status).toBe(200)
    c.stop()
  })

  // Слово фаундера 13.11 (TG 85140): «ни опус, ни санет не пытались даже, если остальные
  // организации будут загружены». Выбор при рождении — не единственный путь к организации:
  // [%reload-ok%] сажает на ТЕКУЩИЙ вход машины, а после входа в Fable-организацию текущей
  // станет именно она. Правило обязано стоять на последнем шаге — перед отправкой.
  test('[%reload-ok%] не сажает Opus на Fable-организацию, когда она — текущий вход', async () => {
    const { c, auth } = setup('org-f')
    const reload = JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'go [%reload-ok%]' }] })
    const r = await c.handleRequest(reload, {}, { sessionId: 'opus-reload' })
    expect(r.status).toBe(400)
    const j = await r.json() as { error?: { type?: string } }
    expect(j.error?.type).toBe('model_guard')
    expect(auth.some(a => a === 'Bearer tok-org-f')).toBe(false)
    c.stop()
  })

  test('старая Opus-сессия, закреплённая на организации ДО правила, тоже не тратит её', async () => {
    const { c, auth, vault } = setup('org-a')
    vault.setPin('old-opus', 'org-f')
    const r = await c.handleRequest(body('claude-opus-5-5'), {}, { sessionId: 'old-opus' })
    expect(r.status).toBe(400)
    expect(auth.some(a => a === 'Bearer tok-org-f')).toBe(false)
    c.stop()
  })

  // Fable, родившаяся на org-a ДО правила: переносить живую сессию нельзя (рельса
  // no-live-account-migration — перенос = разовая перезапись всего контекста), а тратить org-a
  // на Fable правило запрещает («Fable уходит только на эту организацию», TG 85140). Значит —
  // названный отказ с советом начать новую сессию, и НИ ОДНОГО запроса ни на org-a, ни на org-f.
  test('живая Fable-сессия на чужой организации: не переносится и не тратит её — отказ', async () => {
    const { c, auth, vault } = setup('org-a')
    vault.setPin('old-fable', 'org-a')
    const r = await c.handleRequest(body('claude-fable-5-2'), {}, { sessionId: 'old-fable' })
    expect(r.status).toBe(400)
    expect(((await r.json()) as any).error?.message).toContain('Start a NEW session')
    expect(auth).toHaveLength(0)
    expect(vault.getPin('old-fable')).toEqual({ orgId: 'org-a' })   // пин не тронут
    c.stop()
  })
})
