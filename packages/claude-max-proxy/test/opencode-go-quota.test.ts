/**
 * opencode-go-quota: квота Go в форме quota-status.json (provider:"opencode-go").
 * Числа — из двери реестра kiberos-app (`go_refresher.py status --json`): берётся
 * АКТИВНАЯ организация, не та, чей ключ в auth.json. Форма usage — как у поставщика
 * (percent — целый израсходованный, resetsAt ISO).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  accountHintFor,
  buildGoQuotaStatus,
  collectOnce,
  goSubscriptionModels,
  litellmGoAliases,
  readGoKey,
  readGoRegistry,
} from '../src/opencode-go-quota.js'

const AT = new Date('2026-10-07T12:00:00Z')
const LIVE = {
  rolling: { status: 'ok', percent: 11, resetsAt: '2026-10-07T15:40:49.000Z' },
  weekly: { status: 'ok', percent: 53, resetsAt: '2026-10-12T00:00:00.000Z' },
  monthly: { status: 'ok', percent: 26, resetsAt: '2026-11-05T12:27:21.000Z' },
}

const okFetch = (body: unknown) => (async () => ({
  ok: true, status: 200, json: async () => body,
})) as any

describe('построение файла из usage активной организации', () => {
  test('percent целый → доля; message называет организацию', () => {
    const s: any = buildGoQuotaStatus({
      usage: LIVE, error: null, org: 'console-berezovskaya', active: true,
      accountHint: 'console-berezovskaya', models: [], modelsSource: '', measuredAt: AT,
    })
    const a = s.accounts['console-berezovskaya']
    expect(a.util5h).toBe(0.11)
    expect(a.util7d).toBe(0.53)
    expect(a.utilMonth).toBe(0.26)
    expect(a.org).toBe('console-berezovskaya')
    expect(a.active).toBe(true)
    expect(s.org).toBe('console-berezovskaya')
    expect(a.windows.map((w: any) => w.window)).toEqual(['5h', 'week', 'month'])
    // message — то, что видит человек: percent 11/53/26, НЕ 1100/5300/2600 (двойное ×100),
    // и названа организация, которую обслуживает посредник.
    expect(a.message).toBe('opencode-go (console-berezovskaya, активна): 5h 11%, week 53%, month 26%.')
  })

  test('percent клампится, кривой сброс — null', () => {
    const s: any = buildGoQuotaStatus({
      usage: { rolling: { status: 'capped', percent: 137, resetsAt: 'nope' } },
      error: null, org: 'x', active: false, accountHint: 'x', models: [], modelsSource: '', measuredAt: AT,
    })
    expect(s.accounts.x.util5h).toBe(1)
    expect(s.accounts.x.windows[0].status).toBe('capped')
    expect(s.accounts.x.windows[0].resetAt).toBeNull()
    expect(s.accounts.x.message).toContain('не активна')
  })

  test('нет usage — названное отсутствие, accounts пусто', () => {
    const s: any = buildGoQuotaStatus({
      usage: null, error: 'go_refresher_unavailable: x', org: 'unknown', active: false,
      accountHint: 'h', models: ['m'], modelsSource: '', measuredAt: AT,
    })
    expect(s.error).toBe('go_refresher_unavailable: x')
    expect(s.accounts).toEqual({})
  })

  test('отпечаток не содержит ключа', () => {
    expect(accountHintFor('sk-SECRET')).not.toContain('SECRET')
  })
})

describe('дверь реестра kiberos-app', () => {
  test('читает active и окна каждой организации', async () => {
    const body = JSON.stringify({
      active: 'console-berezovskaya',
      measured_at_ms: AT.getTime(),
      orgs: [
        { name: 'console-berezovskaya', active: true, usage: LIVE, exhausted: [] },
        { name: 'apikey-founder', active: false, usage: { weekly: { status: 'rate-limited', percent: 100 } }, exhausted: ['weekly'] },
      ],
    })
    const runner = (async () => ({ code: 0, stdout: body, stderr: '' })) as any
    const { registry, error } = await readGoRegistry('/door.py', runner)
    expect(error).toBeNull()
    expect(registry?.active).toBe('console-berezovskaya')
    expect(registry?.orgs.length).toBe(2)
    expect(registry?.orgs[1].exhausted).toEqual(['weekly'])
  })

  test('дверь упала — названная причина, не догадка', async () => {
    const runner = (async () => ({ code: 2, stdout: '', stderr: 'boom' })) as any
    expect((await readGoRegistry('/door.py', runner)).error).toBe('go_refresher_exit_2')
  })
})

describe('чьи модели', () => {
  test('подписка: id с приставкой opencode-go/', async () => {
    const models = okFetch({ data: [{ id: 'muse-spark-1.3-contributor' }, { id: 7 }] })
    const r = await goSubscriptionModels('K', models)
    expect(r.models).toEqual(['opencode-go/muse-spark-1.3-contributor'])
  })

  test('алиасы LiteLLM — по api_base, не по имени', () => {
    const cfg = {
      model_list: [
        { model_name: 'muse-spark-1.3-contributor', litellm_params: { api_base: 'https://opencode.ai/zen/go/v1' } },
        { model_name: 'deepseek-v4.1-flash-go', litellm_params: { api_base: 'https://opencode.ai/zen/go/v1/chat' } },
        { model_name: 'deepseek-v4.1-flash', litellm_params: { api_base: 'https://dashscope.aliyuncs.com/x' } },
        { model_name: 'plain', litellm_params: {} },
      ],
    }
    // Голое deepseek-имя на DashScope — НЕ берём (ловушка из поручения).
    expect(litellmGoAliases(cfg).sort()).toEqual(['deepseek-v4.1-flash-go', 'muse-spark-1.3-contributor'])
    expect(litellmGoAliases({})).toEqual([])
  })
})

describe('сборка целиком (без сети)', () => {
  test('берётся АКТИВНАЯ организация, файл пишется атомарно', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-goq-'))
    try {
      const auth = join(dir, 'auth.json')
      writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'K' } }))
      const out = join(dir, 'quota-status-opencode-go.json')
      const body = JSON.stringify({
        active: 'console-berezovskaya',
        measured_at_ms: AT.getTime(),
        orgs: [
          { name: 'apikey-founder', active: false, usage: { weekly: { status: 'rate-limited', percent: 100 } }, exhausted: ['weekly'] },
          { name: 'console-berezovskaya', active: true, usage: LIVE, exhausted: [] },
        ],
      })
      const runner = (async () => ({ code: 0, stdout: body, stderr: '' })) as any
      const fetchFn = okFetch({ data: [{ id: 'm' }] })
      const s: any = await collectOnce({
        authJsonPath: auth, litellmConfigPath: join(dir, 'nope.yaml'),
        goRefresherPath: '/door.py', outPath: out, fetcher: fetchFn, runner, now: () => AT,
      })
      expect(s.provider).toBe('opencode-go')
      expect(s.org).toBe('console-berezovskaya')
      expect(s.active).toBe(true)
      const onDisk = JSON.parse(readFileSync(out, 'utf8'))
      expect(onDisk.org).toBe('console-berezovskaya')
      expect(Object.keys(onDisk.accounts)).toEqual(['console-berezovskaya'])
      expect(onDisk.accounts['console-berezovskaya'].util7d).toBe(0.53)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readGoKey терпит отсутствие файла', () => {
    expect(readGoKey('/nonexistent/auth.json')).toBeNull()
  })
})
