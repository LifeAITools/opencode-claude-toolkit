/**
 * Выбор организации Anthropic при РОЖДЕНИИ сессии (слово фаундера 12.11.2026).
 *
 * Держит четыре обещания плана PRPs/anthropic-birth-placement/plan.md:
 *  (а) решает худшее окно с учётом скорости: при большом 5ч и почти исчерпанной неделе
 *      выигрывает организация, у которой неделя свободна;
 *  (б) живая сессия НЕ меняет организацию никогда (пин в памяти или в хранилище);
 *  (в) запретившие вход / без живого токена / неизмеренные — не кандидаты;
 *  (г) решать нечем — прежнее поведение (активная организация), и это названо.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { chooseBirthOrg, usageToWindows } from '../src/anthropic-birth-placement.js'
import { ProxyClient, type ProxyClientOptions } from '../src/proxy-client.js'
import { OrgVault } from '../src/org-vault.js'

const H = 3_600_000
const NOW = Date.UTC(2026, 10, 12, 10, 0, 0)

describe('usageToWindows — ответ /api/oauth/usage в окна', () => {
  test('проценты → доля, ISO → мс; пустое окно — не ноль, а отсутствие', () => {
    const w = usageToWindows({
      five_hour: { utilization: 30, resets_at: '2026-11-12T13:30:00.203958+00:00' },
      seven_day: { utilization: null, resets_at: null },
    })
    expect(w).toEqual([{ name: '5h', util: 0.3, resetAt: Date.parse('2026-11-12T13:30:00.203958+00:00') }])
    expect(usageToWindows(null)).toEqual([])
  })
})

const alive = (orgId: string) => ({ orgId, needsRelogin: false, tokenAlive: true })
const reading = (orgId: string, u5: number, uWeek: number, at = NOW) => ({
  orgId, measuredAt: at,
  windows: [
    // 5ч: прошло 4ч из 5 → сброс через 1ч; неделя: прошло 6 суток → сброс через сутки
    { name: '5h', util: u5, resetAt: NOW + 1 * H },
    { name: 'week', util: uWeek, resetAt: NOW + 24 * H },
  ],
})

describe('chooseBirthOrg — тот же planPlacement, что у дверей OD/Go', () => {
  test('(а) неделя почти исчерпана при большом 5ч — выигрывает другая организация', () => {
    const r = chooseBirthOrg({
      candidates: [alive('org-weekly-hot'), alive('org-calm')],
      readings: new Map([
        // 5ч почти пуст, но неделя 95% и горит: до стены меньше суток до сброса — связывает
        ['org-weekly-hot', reading('org-weekly-hot', 0.05, 0.95)],
        // 5ч занят сильнее, но неделя свободна
        ['org-calm', reading('org-calm', 0.40, 0.10)],
      ]),
      pinsByOrg: new Map(), nowMs: NOW, maxReadingAgeMs: 15 * 60_000, seed: 's1',
    })
    expect(r.orgId).toBe('org-calm')
  })

  test('(в) запретившая вход и без живого токена — не кандидаты; осталась одна — не выбираем', () => {
    const r = chooseBirthOrg({
      candidates: [alive('org-a'), { orgId: 'org-denied', needsRelogin: true, tokenAlive: true }, { orgId: 'org-dead', needsRelogin: false, tokenAlive: false }],
      readings: new Map([['org-a', reading('org-a', 0.1, 0.1)], ['org-denied', reading('org-denied', 0, 0)], ['org-dead', reading('org-dead', 0, 0)]]),
      pinsByOrg: new Map(), nowMs: NOW, maxReadingAgeMs: 15 * 60_000, seed: 's',
    })
    expect(r.orgId).toBeNull()
    expect(r.skipped).toContain('живых организаций 1')
  })

  test('(г) свежо измерена одна из двух — сравнивать не с чем, прежнее поведение', () => {
    const r = chooseBirthOrg({
      candidates: [alive('org-a'), alive('org-b')],
      readings: new Map([['org-a', reading('org-a', 0.1, 0.1)], ['org-b', reading('org-b', 0.1, 0.1, NOW - 60 * 60_000)]]),
      pinsByOrg: new Map(), nowMs: NOW, maxReadingAgeMs: 15 * 60_000, seed: 's',
    })
    expect(r.orgId).toBeNull()
    expect(r.skipped).toContain('свежо измерено 1 из 2')
  })
})

// ── Сквозной путь через ProxyClient ───────────────────────────────────────────

const TMP = mkdtempSync(join(tmpdir(), 'birth-'))
/** Не читать настоящий вход Claude Code на машине: иначе снимок текущей учётки кладёт в
 *  тестовое хранилище живую организацию, и опрос/выбор видят лишнего кандидата. */
const ISOLATED = { credentialsPath: join(TMP, 'credentials.json'), claudeConfigDir: join(TMP, 'no-config'), accountConfigPath: join(TMP, 'no-claude.json') }
/** Ключ АКТИВНОЙ организации читается с диска (orgTokenMeta) — кладём его туда, как делает
 *  родной Claude Code; иначе активная выглядит «без живого ключа» и выбор не из чего. */
function writeActiveCreds(token: string, expiresAt: number) {
  writeFileSync(ISOLATED.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: null, expiresAt } }))
}
let seq = 0
const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n'
const body = (t = 'hi') => JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: t }] })

function setup(opts: { activeOrg?: string } = {}) {
  const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
  const exp = Date.now() + 3 * H
  vault.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
  vault.upsert({ orgId: 'org-b', accessToken: 'tok-b', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
  const auth: string[] = []
  const active = { org: opts.activeOrg ?? 'org-a' }
  writeActiveCreds(active.org === 'org-a' ? 'tok-a' : 'tok-b', exp)
  const c = new ProxyClient({
    config: { kaCacheTtlSec: 1 },
    credentialsProvider: { getAccessToken: async () => (active.org === 'org-a' ? 'tok-a' : 'tok-b'), invalidate() {}, currentExpiresAt: () => exp },
    upstreamFetcher: { fetch: async (_u: string, init: any) => { auth.push(init.headers.authorization ?? init.headers.Authorization); return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } },
    orgUsageReader: { read: async () => null },
    prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
    orgIdResolver: { current: () => active.org, invalidate() {} },
    rewriteBlockDumpDir: join(TMP, 'dumps'),
    proxyStartedAt: 0,
    orgVault: vault,
    ...ISOLATED,
  } as ProxyClientOptions)
  const now = Date.now()
  const r5 = now + 1 * H, rW = now + 24 * H
  // org-a (активная) — неделя почти исчерпана и горит; org-b — свободна
  c._setOrgUsage({ orgId: 'org-a', measuredAt: now, windows: [{ name: '5h', util: 0.05, resetAt: r5 }, { name: 'week', util: 0.95, resetAt: rW }] })
  c._setOrgUsage({ orgId: 'org-b', measuredAt: now, windows: [{ name: '5h', util: 0.40, resetAt: r5 }, { name: 'week', util: 0.10, resetAt: rW }] })
  return { c, auth, vault, active }
}

describe('ProxyClient — выбор только при рождении', () => {
  test('новая сессия уходит на свободную организацию, а не на активную', async () => {
    const { c, auth, vault } = setup()
    const r = await c.handleRequest(body(), {}, { sessionId: 'born-1' })
    expect(r.status).toBe(200)
    expect(auth.at(-1)).toBe('Bearer tok-b')
    expect(vault.getPin('born-1')).toEqual({ orgId: 'org-b' })
    c.stop()
  })

  test('(б) живая сессия НЕ переезжает, даже когда запас перевернулся', async () => {
    const { c, auth } = setup()
    await c.handleRequest(body(), {}, { sessionId: 'live-1' })          // родилась на org-b
    const now = Date.now()
    c._setOrgUsage({ orgId: 'org-b', measuredAt: now, windows: [{ name: '5h', util: 0.99, resetAt: now + H }, { name: 'week', util: 0.99, resetAt: now + 24 * H }] })
    c._setOrgUsage({ orgId: 'org-a', measuredAt: now, windows: [{ name: '5h', util: 0.0, resetAt: now + H }, { name: 'week', util: 0.0, resetAt: now + 24 * H }] })
    await c.handleRequest(body('again'), {}, { sessionId: 'live-1' })
    expect(auth.at(-1)).toBe('Bearer tok-b')
    c.stop()
  })

  test('(б) пин из хранилища (после перезапуска прокси) не перебивается выбором', async () => {
    const { c, auth, vault } = setup()
    vault.setPin('restored-1', 'org-a')                       // сессия жила на org-a до перезапуска
    await c.handleRequest(body(), {}, { sessionId: 'restored-1' })
    expect(auth.at(-1)).toBe('Bearer tok-a')
    c.stop()
  })

  test('явная перезагрузка [%reload-ok%] остаётся выбором человека — текущий вход', async () => {
    const { c, auth } = setup()
    await c.handleRequest(body('go [%reload-ok%]'), {}, { sessionId: 'reload-1' })
    expect(auth.at(-1)).toBe('Bearer tok-a')
    c.stop()
  })
})

describe('опрос запаса — уважает 429 этого справочного вызова', () => {
  test('после 429 организация не опрашивается до retry-after', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: Date.now() + H, capturedAt: Date.now() })
    let calls = 0
    writeActiveCreds('tok-a', Date.now() + H)
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-a', invalidate() {} },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200 }) },
      orgUsageReader: { read: async () => { calls++; return { retryAfterSec: 96 } } },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-a', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
    } as ProxyClientOptions)
    await c._refreshOrgUsage()
    expect(calls).toBe(1)                 // о ней ничего не известно — один вызов сразу
    c._ageOrgUsageStart(2 * H)
    await c._refreshOrgUsage()
    await c._refreshOrgUsage()
    expect(calls).toBe(1)                 // дальше пауза 429 — повтора нет
    c.stop()
  })

  test('истёкшая организация без refresh-токена не опрашивается вовсе', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-dead', accessToken: 'tok-d', refreshToken: null, expiresAt: Date.now() - H, capturedAt: Date.now() - 2 * H })
    let calls = 0
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'x', invalidate() {} },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200 }) },
      orgUsageReader: { read: async () => { calls++; return { data: {} } } },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => null, invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
    } as ProxyClientOptions)
    c._ageOrgUsageStart(2 * H)
    await c._refreshOrgUsage()
    expect(calls).toBe(0)
    c.stop()
  })
})

describe('запас из заголовков настоящего ответа — основной источник', () => {
  test('ответ с anthropic-ratelimit-unified-* наполняет запас; справочный вызов не нужен', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: Date.now() + H, capturedAt: Date.now() })
    let reads = 0
    writeActiveCreds('tok-a', Date.now() + H)
    const reset = Math.floor(Date.now() / 1000) + 3600
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-a', invalidate() {}, currentExpiresAt: () => Date.now() + H },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200, headers: {
        'content-type': 'text/event-stream',
        'anthropic-organization-id': 'org-a',
        'anthropic-ratelimit-unified-5h-utilization': '0.3', 'anthropic-ratelimit-unified-5h-reset': String(reset),
        'anthropic-ratelimit-unified-7d-utilization': '0.04', 'anthropic-ratelimit-unified-7d-reset': String(reset + 86400),
      } }) },
      orgUsageReader: { read: async () => { reads++; return { data: {} } } },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-a', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
    } as ProxyClientOptions)
    const r = await c.handleRequest(body(), {}, { sessionId: 'hdr-1' })
    await r.text()                                   // дочитать поток — ответ обработан целиком
    c._ageOrgUsageStart(2 * H)
    await c._refreshOrgUsage()
    expect(reads).toBe(0)
    c.stop()
  })
})

describe('после перезапуска измеренная организация не опрашивается первый час', () => {
  test('показание из ходов есть → справочный вызов ждёт часа после старта', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: Date.now() + H, capturedAt: Date.now() })
    writeActiveCreds('tok-a', Date.now() + H)
    let calls = 0
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-a', invalidate() {} },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200 }) },
      orgUsageReader: { read: async () => { calls++; return { data: {} } } },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-a', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
    } as ProxyClientOptions)
    c._setOrgUsage({ orgId: 'org-a', measuredAt: Date.now() - 2 * H, windows: [{ name: '5h', util: 0.1, resetAt: Date.now() + H }] })
    await c._refreshOrgUsage()
    expect(calls).toBe(0)
    c.stop()
  })
})

describe('новый вход снимает «нужен повторный вход»', () => {
  test('после нового ключа организация снова кандидат (ORG_RELOGIN_CLEARED)', async () => {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-n', accessToken: 'old-tok', refreshToken: null, expiresAt: Date.now() - H, capturedAt: Date.now() - 2 * H })
    const cfg = join(TMP, `claude-${seq++}.json`)
    writeFileSync(cfg, JSON.stringify({ oauthAccount: { organizationUuid: 'org-n', emailAddress: 'n@x' } }))
    const ev: any[] = []
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'new-tok', invalidate() {}, currentExpiresAt: () => Date.now() + H },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200 }) },
      orgUsageReader: { read: async () => null },
      eventEmitter: { emit: (e: any) => ev.push(e) },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-n', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault,
      ...ISOLATED, accountConfigPath: cfg,
    } as ProxyClientOptions)
    ;(c as any).orgRefreshCooldown.set('org-n', { until: Date.now() + 30 * 60_000, attempts: 3, needsRelogin: true })
    await c.snapshotCurrentAccount('credentials-changed')
    expect((c as any).orgRefreshCooldown.has('org-n')).toBe(false)
    expect(ev.some(e => e.kind === 'ORG_RELOGIN_CLEARED')).toBe(true)
    c.stop()
  })
})

describe('remeasureOrgUsage — «сбросили, перемерь» (фаундер 12.11.2026)', () => {
  function mk(reader: any) {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    vault.upsert({ orgId: 'org-r', accountEmail: 'r@x', accessToken: 'tok-r', refreshToken: null, expiresAt: Date.now() + H, capturedAt: Date.now() })
    writeActiveCreds('tok-x', Date.now() + H)
    return new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-x', invalidate() {} },
      upstreamFetcher: { fetch: async () => new Response(SSE, { status: 200 }) },
      orgUsageReader: reader,
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-other', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
    } as ProxyClientOptions)
  }
  test('старое 99% стирается, новое показание сразу (минуя часовой интервал)', async () => {
    const c = mk({ read: async () => ({ data: { five_hour: { utilization: 0, resets_at: '2026-11-12T18:00:00Z' } } }) })
    c._setOrgUsage({ orgId: 'org-r', measuredAt: Date.now(), windows: [{ name: '5h', util: 0.99, resetAt: Date.now() + H }] })
    const r = await c.remeasureOrgUsage('r@x')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.windows[0]!.util).toBe(0)
    c.stop()
  })
  test('пауза 429 от Anthropic соблюдается и называется', async () => {
    const c = mk({ read: async () => ({ retryAfterSec: 300 }) })
    const a = await c.remeasureOrgUsage('org-r')
    expect(a.ok).toBe(false)
    const b = await c.remeasureOrgUsage('org-r')
    expect(b.ok).toBe(false)
    if (!b.ok) expect(b.retryAfterSec).toBeGreaterThan(0)
    c.stop()
  })
})

describe('регулятор поверх выбора при рождении (src/placement-control.ts)', () => {
  function client(cfg: object | null) {
    const vault = new OrgVault(join(TMP, `vault-${seq++}.json`))
    const exp = Date.now() + 3 * H
    vault.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
    vault.upsert({ orgId: 'org-b', accessToken: 'tok-b', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
    writeActiveCreds('tok-a', exp)
    const cfgPath = join(TMP, `placement-${seq++}.json`)
    if (cfg) writeFileSync(cfgPath, JSON.stringify(cfg))
    const auth: string[] = []
    const c = new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-a', invalidate() {}, currentExpiresAt: () => exp },
      upstreamFetcher: { fetch: async (_u: string, init: any) => { auth.push(init.headers.authorization ?? init.headers.Authorization); return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } },
      orgUsageReader: { read: async () => null },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-a', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: vault, ...ISOLATED,
      placementConfigPath: cfgPath,
    } as ProxyClientOptions)
    return { c, auth }
  }
  const now = () => Date.now()
  const both = (c: ProxyClient, a5: number, b5: number) => {
    c._setOrgUsage({ orgId: 'org-a', measuredAt: now(), windows: [{ name: '5h', util: a5, resetAt: now() + 4 * H }, { name: 'week', util: 0.1, resetAt: now() + 100 * H }] })
    c._setOrgUsage({ orgId: 'org-b', measuredAt: now(), windows: [{ name: '5h', util: b5, resetAt: now() + 4 * H }, { name: 'week', util: 0.1, resetAt: now() + 100 * H }] })
  }

  test('нет файла ручки — выбор прежний (свободнее — org-b)', async () => {
    const { c, auth } = client(null)
    both(c, 0.5, 0.1)
    await c.handleRequest(body(), {}, { sessionId: 'ctl-off' })
    expect(auth.at(-1)).toBe('Bearer tok-b')
    c.stop()
  })

  test('drain на org-a: вес растёт со временем отставания (slew), приток на неё растёт', async () => {
    // Регулятор шагает по ЧАСАМ ВЫБОРА (Date.now): двигаем часы, а не ждём их.
    const realNow = Date.now
    let clock = realNow()
    Date.now = () => clock
    try {
      const { c, auth } = client({ enabled: true, drain: [{ org: 'org-a', targetUtil: 0.99, deadline: new Date(clock + 4 * H).toISOString() }] })
      let early = 0, late = 0
      for (let step = 0; step < 12; step++) {
        both(c, 0.5, 0.1)                  // org-a не двигается — отставание от траектории растёт
        for (let i = 0; i < 10; i++) {
          await c.handleRequest(body(`s${step}-${i}`), {}, { sessionId: `ctl-d-${step}-${i}` })
          if (auth.at(-1) === 'Bearer tok-a') step < 2 ? early++ : step >= 9 ? late++ : 0
        }
        clock += 10 * 60_000
      }
      expect(late).toBeGreaterThan(early)
      expect(late).toBeGreaterThan(15)     // к концу — большинство новых на org-a
      c.stop()
    } finally {
      Date.now = realNow
    }
  }, 30_000)

  test('тормоз: прогноз уже посаженных ≥ цели — на org-a новых не шлём, даже под drain', async () => {
    const { c, auth } = client({ enabled: true, drain: [{ org: 'org-a', targetUtil: 0.9, deadline: new Date(now() + 4 * H).toISOString() }] })
    both(c, 0.89, 0.1)
    await c.handleRequest(body(), {}, { sessionId: 'ctl-brake' })
    expect(auth.at(-1)).toBe('Bearer tok-b')
    c.stop()
  })

  test('живая сессия под drain другой организации не переезжает', async () => {
    const { c, auth } = client(null)
    both(c, 0.5, 0.1)
    await c.handleRequest(body(), {}, { sessionId: 'ctl-live' })      // родилась на org-b
    writeFileSync(join(TMP, 'unused.json'), '{}')
    await c.handleRequest(body('again'), {}, { sessionId: 'ctl-live' })
    expect(auth.at(-1)).toBe('Bearer tok-b')
    c.stop()
  })
})

describe('перезапуск прокси не переселяет сессию, родившуюся на АКТИВНОЙ организации (12.11.2026)', () => {
  test('выбор совпал с активной → пин в хранилище; новый процесс на том же хранилище не переселяет', async () => {
    const vaultPath = join(TMP, `vault-${seq++}.json`)
    const exp = Date.now() + 3 * H
    const mkVault = () => {
      const v = new OrgVault(vaultPath)
      v.upsert({ orgId: 'org-a', accessToken: 'tok-a', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
      v.upsert({ orgId: 'org-b', accessToken: 'tok-b', refreshToken: null, expiresAt: exp, capturedAt: Date.now() })
      return v
    }
    writeActiveCreds('tok-a', exp)
    const mk = (auth: string[]) => new ProxyClient({
      config: { kaCacheTtlSec: 1, orgProactiveRefreshSec: 0 },
      credentialsProvider: { getAccessToken: async () => 'tok-a', invalidate() {}, currentExpiresAt: () => exp },
      upstreamFetcher: { fetch: async (_u: string, init: any) => { auth.push(init.headers.authorization ?? init.headers.Authorization); return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } }) } },
      orgUsageReader: { read: async () => null },
      prefixHistoryPath: join(TMP, `ph-${seq++}.json`),
      orgIdResolver: { current: () => 'org-a', invalidate() {} },
      rewriteBlockDumpDir: join(TMP, 'dumps'), proxyStartedAt: 0, orgVault: mkVault(), ...ISOLATED,
    } as ProxyClientOptions)
    const now = Date.now()
    const usage = (c: ProxyClient, a: number, b: number) => {
      c._setOrgUsage({ orgId: 'org-a', measuredAt: now, windows: [{ name: '5h', util: a, resetAt: now + 4 * H }, { name: 'week', util: 0.1, resetAt: now + 100 * H }] })
      c._setOrgUsage({ orgId: 'org-b', measuredAt: now, windows: [{ name: '5h', util: b, resetAt: now + 4 * H }, { name: 'week', util: 0.1, resetAt: now + 100 * H }] })
    }
    // Процесс 1: org-a (активная) свободнее → выбор совпал с активной.
    const auth1: string[] = []
    const c1 = mk(auth1)
    usage(c1, 0.1, 0.5)
    await c1.handleRequest(body(), {}, { sessionId: 'born-active' })
    expect(auth1.at(-1)).toBe('Bearer tok-a')
    c1.stop()
    expect(new OrgVault(vaultPath).getPin('born-active')).toEqual({ orgId: 'org-a' })
    // Процесс 2 (перезапуск): теперь свободнее org-b — живая сессия всё равно остаётся на org-a.
    const auth2: string[] = []
    const c2 = mk(auth2)
    usage(c2, 0.9, 0.1)
    await c2.handleRequest(body('again'), {}, { sessionId: 'born-active' })
    expect(auth2.at(-1)).toBe('Bearer tok-a')
    c2.stop()
  })
})

// ── 14.11.2026, TG 85936/85941: регулятор смотрел только на 5ч и затормозил relishev
// (5ч 0.77, неделя 0.56), а все новые сессии ушли на oeliseva с НЕДЕЛЕЙ 0.99. Тормоз не смеет
// отдать сессию аккаунту, который выбор по запасу ставит НИЖЕ затормаживаемого: отступать
// можно только на равный или лучший. Иначе «не упереться всем разом» само загоняет в стену.
describe('тормоз регулятора не гонит на аккаунт с почти пустой неделей', () => {
  const t = NOW
  const readings = new Map([
    ['rel', { orgId: 'rel', measuredAt: t, windows: [{ name: '5h', util: 0.77, resetAt: t + 2 * H }, { name: 'week', util: 0.56, resetAt: t + 5 * 24 * H }] }],
    ['oel', { orgId: 'oel', measuredAt: t, windows: [{ name: '5h', util: 0.42, resetAt: t + 3 * H }, { name: 'week', util: 0.99, resetAt: t + 31 * H }] }],
  ])
  const candidates = [
    { orgId: 'rel', needsRelogin: false, tokenAlive: true },
    { orgId: 'oel', needsRelogin: false, tokenAlive: true },
  ]
  test('rel заторможен по 5ч, но oel хуже по неделе — сессия идёт на rel', () => {
    const r = chooseBirthOrg({
      candidates, readings, pinsByOrg: new Map([['rel', 10], ['oel', 10]]), nowMs: t,
      maxReadingAgeMs: H, seed: 's1',
      weights: new Map([['rel', { weight: 0, mode: 'balance', reason: 'тормоз' }], ['oel', { weight: 1, mode: 'balance', reason: '' }]]),
    })
    expect(r.orgId).toBe('rel')
  })
  test('тормоз по-прежнему работает, когда запасной аккаунт не хуже', () => {
    const fine = new Map([
      ['rel', readings.get('rel')!],
      ['oel', { orgId: 'oel', measuredAt: t, windows: [{ name: '5h', util: 0.10, resetAt: t + 3 * H }, { name: 'week', util: 0.20, resetAt: t + 5 * 24 * H }] }],
    ])
    const r = chooseBirthOrg({
      candidates, readings: fine, pinsByOrg: new Map([['rel', 10], ['oel', 10]]), nowMs: t,
      maxReadingAgeMs: H, seed: 's1',
      weights: new Map([['rel', { weight: 0, mode: 'balance', reason: 'тормоз' }], ['oel', { weight: 1, mode: 'balance', reason: '' }]]),
    })
    expect(r.orgId).toBe('oel')
  })
})
