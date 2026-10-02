/**
 * alibaba-quota: файл квоты Alibaba Token Plan в форме quota-status.json с provider:"alibaba".
 * Читатель — lat-context; он просил точные имена моделей `provider/model` и время замера,
 * чтобы не угадывать по приставке (02.10.2026).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAlibabaQuotaStatus, findPlanProviders, collectOnce, accountHintFor } from '../src/alibaba-quota.js'

const CONFIG = `{
  // комментарии как в настоящем opencode.jsonc
  "provider": {
    "bailian-cli": { "options": { "baseURL": "http://127.0.0.1:17100/v1", "apiKey": "sk-sp-PLAN" } },
    "dashscope": { "options": { "baseURL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "apiKey": "sk-ws-OTHER" } },
    "z-ai-coding": { "name": "Z.AI" }
  }
}`
const BASES = ['https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode', 'http://127.0.0.1:17100']

describe('чьи модели', () => {
  test('провайдер подписки находится по адресу, чужой ключ Alibaba — нет', () => {
    const p = findPlanProviders(Bun.JSONC.parse(CONFIG), BASES)
    expect(p.map((x) => x.id)).toEqual(['bailian-cli'])
  })
})

describe('файл', () => {
  const at = new Date('2026-10-02T09:00:00Z')
  test('окна, сбросы, уровень по общим порогам', () => {
    const s: any = buildAlibabaQuotaStatus({
      usage: { per5HourPercentage: 0.88, per5HourResetTime: 1790946000000, per1WeekPercentage: 0.4, per1WeekResetTime: 1791381600000 },
      error: null, accountHint: 'alibaba-tokenplan-x', models: ['bailian-cli/deepseek-v4-pro'], modelsSource: 's', measuredAt: at,
    })
    expect(s.provider).toBe('alibaba')
    expect(s.measured_at).toBe('2026-10-02T09:00:00.000Z')
    expect(s.models).toEqual(['bailian-cli/deepseek-v4-pro'])
    const a = s.accounts['alibaba-tokenplan-x']
    expect(a.util5h).toBe(0.88)
    expect(a.util7d).toBe(0.4)
    expect(a.reset5hAt).toBe(new Date(1790946000000).toISOString())
    expect(a.level).toBe('warning')   // 0.88 ≥ 0.85 — те же пороги, что у Claude
  })
  test('окно без ограничения — null, а не ноль', () => {
    const s: any = buildAlibabaQuotaStatus({ usage: {}, error: null, accountHint: 'h', models: [], modelsSource: '', measuredAt: at })
    expect(s.accounts.h.util5h).toBeNull()
    expect(s.accounts.h.level).toBe('ok')
  })
  test('нет входа в консоль — названное отсутствие, без чисел', () => {
    const s: any = buildAlibabaQuotaStatus({ usage: null, error: 'console_login_required', accountHint: 'h', models: ['m'], modelsSource: '', measuredAt: at })
    expect(s.error).toBe('console_login_required')
    expect(s.accounts).toEqual({})
    expect(s.models).toEqual(['m'])
  })
  test('отпечаток ключа не содержит ключа', () => {
    expect(accountHintFor('sk-sp-SECRET')).not.toContain('SECRET')
  })
})

describe('сбор целиком', () => {
  test('модели = провайдер × /models подписки, спрошенный ключом провайдера; запись атомарна', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ali-q-'))
    writeFileSync(join(dir, 'oc.jsonc'), CONFIG)
    const asked: string[] = []
    const fetcher = (async (url: string, init: any) => {
      asked.push(`${url} ${init.headers.authorization}`)
      return new Response(JSON.stringify({ data: [{ id: 'deepseek-v4-pro' }, { id: 'qwen3.8-max' }] }))
    }) as any
    const out = join(dir, 'q.json')
    await collectOnce({
      opencodeConfigPath: join(dir, 'oc.jsonc'), planBases: BASES, blConfigPath: '/nonexistent', gatewayHost: 'gw', outPath: out, fetcher,
      readUsage: async () => ({ usage: { per5HourPercentage: 0.1, per1WeekPercentage: 0.2 }, error: null }),
      now: () => new Date('2026-10-02T09:00:00Z'),
    })
    expect(asked).toEqual(['http://127.0.0.1:17100/v1/models Bearer sk-sp-PLAN'])
    const s = JSON.parse(readFileSync(out, 'utf8'))
    expect(s.models).toEqual(['bailian-cli/deepseek-v4-pro', 'bailian-cli/qwen3.8-max'])
    expect(s.accounts[accountHintFor('sk-sp-PLAN')].util5h).toBe(0.1)
  })
})

describe('месячный план — как у нас (замер 02.10)', () => {
  test('месяц читается, уровень судится по нему, окна без лимита не показываются', () => {
    const s: any = buildAlibabaQuotaStatus({
      usage: { per1MonthPercentage: 0.96, per1MonthResetTime: 1792598400000 },
      error: null, accountHint: 'h', models: [], modelsSource: '', measuredAt: new Date('2026-10-02T09:00:00Z'),
    })
    const a = s.accounts.h
    expect(a.utilMonth).toBe(0.96)
    expect(a.resetMonthAt).toBe(new Date(1792598400000).toISOString())
    expect(a.windows.map((w: any) => w.window)).toEqual(['month'])
    expect(a.level).toBe('warning')  // 0.96 ≥ недельного предупреждения 0.95
  })
})

describe('запрос к консоли', () => {
  const ok = (data: unknown) => new Response(JSON.stringify({ data: { success: true, DataV2: { data: { success: true, code: 'SUCCESS', data } } } }))
  test('ответ консоли разбирается целиком, включая месяц', async () => {
    const { readTokenPlanUsage } = await import('../src/alibaba-quota.js')
    let sent: any
    const r = await readTokenPlanUsage({ token: 'T', switchAgent: 252373, region: 'ap-southeast-1' }, 'gw', (async (url: string, init: any) => { sent = { url, init }; return ok({ per1MonthPercentage: 0.0247, per1MonthResetTime: 1792598400000 }) }) as any)
    expect(r.usage?.per1MonthPercentage).toBe(0.0247)
    expect(sent.init.headers.authorization).toBe('Bearer T')
    expect(sent.url).toContain('https://gw/cli/api.json?action=IntlBroadScopeAspnGateway')
  })
  test('вход истёк — названная причина, без чисел', async () => {
    const { readTokenPlanUsage } = await import('../src/alibaba-quota.js')
    const r = await readTokenPlanUsage({ token: 'T', switchAgent: 1, region: 'r' }, 'gw', (async () => new Response(JSON.stringify({ data: { success: false, errorCode: 'ConsoleNeedLogin.NotLogined' } }))) as any)
    expect(r.usage).toBeNull()
    expect(r.error).toContain('console_login_required')
  })
  test('нет входа вовсе — та же причина, сеть не трогаем', async () => {
    const { readTokenPlanUsage } = await import('../src/alibaba-quota.js')
    let called = false
    const r = await readTokenPlanUsage(null, 'gw', (async () => { called = true; return ok({}) }) as any)
    expect(called).toBe(false)
    expect(r.error).toContain('console_login_required')
  })
})

describe('истёкший вход — эпизод, одна строка, срок жизни входа', () => {
  const login = new Date('2026-10-02T08:45:00Z')
  const t = (iso: string) => new Date(iso)

  test('первый отказ открывает эпизод с оценкой срока: от входа до последнего удачного и до отказа', async () => {
    const { advanceEpisode } = await import('../src/alibaba-quota.js')
    const r = advanceEpisode({ lastOkAt: '2026-10-03T08:40:00.000Z', episode: null }, false, true, t('2026-10-03T08:45:00Z'), login)
    expect(r.absent?.reason).toBe('console_login_expired')
    expect(r.absent?.since).toBe('2026-10-03T08:45:00.000Z')
    expect(r.absent?.loginLifetimeMs).toEqual({ atLeast: 23 * 3600_000 + 55 * 60_000, atMost: 24 * 3600_000 })
    expect(r.notice).toContain('вход в консоль истёк')
  })

  test('пока строка не ушла — предлагается снова; ушла — больше ни одной за эпизод', async () => {
    const { advanceEpisode } = await import('../src/alibaba-quota.js')
    const first = advanceEpisode({ lastOkAt: null, episode: null }, false, true, t('2026-10-03T09:00:00Z'), login)
    const unsent = advanceEpisode(first.state, false, true, t('2026-10-03T09:05:00Z'), login)
    expect(unsent.notice).not.toBeNull()
    expect(unsent.absent?.since).toBe('2026-10-03T09:00:00.000Z')   // начало эпизода не сдвигается
    const sent = { ...first.state, episode: { ...first.state.episode!, notifiedAt: '2026-10-03T09:00:01Z' } }
    expect(advanceEpisode(sent, false, true, t('2026-10-03T09:10:00Z'), login).notice).toBeNull()
  })

  test('вход вернулся — эпизод закрыт, одна строка о восстановлении (если о беде говорили)', async () => {
    const { advanceEpisode } = await import('../src/alibaba-quota.js')
    const open = advanceEpisode({ lastOkAt: null, episode: null }, false, true, t('2026-10-03T09:00:00Z'), login).state
    const told = { ...open, episode: { ...open.episode!, notifiedAt: 'x' } }
    const back = advanceEpisode(told, true, false, t('2026-10-03T10:00:00Z'), login)
    expect(back.state.episode).toBeNull()
    expect(back.notice).toContain('снова видна')
    expect(advanceEpisode(back.state, true, false, t('2026-10-03T10:05:00Z'), login).notice).toBeNull()
  })

  test('сбой сети — не эпизод входа: фаундера не будим', async () => {
    const { advanceEpisode } = await import('../src/alibaba-quota.js')
    const r = advanceEpisode({ lastOkAt: null, episode: null }, false, false, t('2026-10-03T09:00:00Z'), login)
    expect(r.notice).toBeNull()
    expect(r.state.episode).toBeNull()
  })

  test('сбор целиком: файл несёт quotaAbsent, строка уходит один раз, notifiedAt пишется', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ali-ep-'))
    writeFileSync(join(dir, 'oc.jsonc'), CONFIG)
    writeFileSync(join(dir, 'bl.json'), '{}')
    const sent: string[] = []
    const opts = {
      opencodeConfigPath: join(dir, 'oc.jsonc'), planBases: BASES, blConfigPath: join(dir, 'bl.json'), gatewayHost: 'gw',
      outPath: join(dir, 'q.json'), statePath: join(dir, 'state.json'),
      fetcher: (async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }))) as any,
      readUsage: async () => ({ usage: null, error: 'console_login_required: run …' }),
      notice: { chatId: 'c', threadId: 't' },
      sendNotice: async (n: any) => { sent.push(n.text); return { sent: true } },
    }
    await collectOnce(opts)
    await collectOnce(opts)
    expect(sent.length).toBe(1)
    const q = JSON.parse(readFileSync(join(dir, 'q.json'), 'utf8'))
    expect(q.quotaAbsent.reason).toBe('console_login_expired')
    expect(q.accounts).toEqual({})
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).episode.notifiedAt).not.toBeNull()
  })
})
