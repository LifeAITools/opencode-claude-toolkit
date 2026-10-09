/**
 * opencode-go-quota: квота Go в форме quota-status.json (provider:"opencode-go").
 * Живая форма двери снята 07.10 (percent — целый израсходованный, resetsAt ISO).
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
  readGoUsage,
} from '../src/opencode-go-quota.js'

const AT = new Date('2026-10-07T12:00:00Z')
const LIVE = {
  usage: {
    rolling: { status: 'ok', percent: 11, resetsAt: '2026-10-07T15:40:49.000Z' },
    weekly: { status: 'ok', percent: 53, resetsAt: '2026-10-12T00:00:00.000Z' },
    monthly: { status: 'ok', percent: 26, resetsAt: '2026-11-05T12:27:21.000Z' },
  },
}

const okFetch = (usage: unknown) => (async () => ({
  ok: true, status: 200, json: async () => ({ usage }),
})) as any

describe('дверь', () => {
  test('живая форма разбирается; percent целый → доля', async () => {
    const { usage, error } = await readGoUsage('K', okFetch(LIVE.usage))
    expect(error).toBeNull()
    const s: any = buildGoQuotaStatus({ usage, error, accountHint: 'h', models: [], modelsSource: '', measuredAt: AT })
    const a = s.accounts.h
    expect(a.util5h).toBe(0.11)
    expect(a.util7d).toBe(0.53)
    expect(a.utilMonth).toBe(0.26)
    expect(a.reset5hAt).toBe('2026-10-07T15:40:49.000Z')
    expect(a.windows.map((w: any) => w.window)).toEqual(['5h', 'week', 'month'])
    expect(a.windows[0].util).toBe(0.11)
    // message — то, что видит человек: percent 11/53/26, НЕ 1100/5300/2600 (двойное ×100).
    expect(a.message).toBe('opencode-go: 5h 11%, week 53%, month 26%.')
  })

  test('percent клампится, кривой сброс — null', async () => {
    const s: any = buildGoQuotaStatus({
      usage: { rolling: { status: 'capped', percent: 137, resetsAt: 'nope' } },
      error: null, accountHint: 'h', models: [], modelsSource: '', measuredAt: AT,
    })
    expect(s.accounts.h.util5h).toBe(1)
    expect(s.accounts.h.windows[0].status).toBe('capped')
    expect(s.accounts.h.windows[0].resetAt).toBeNull()
  })

  test('нет ключа / отказ / пусто — названное отсутствие', async () => {
    expect((await readGoUsage(null)).error).toContain('go_key_missing')
    const fail = (async () => ({ ok: false, status: 403, json: async () => ({}) })) as any
    expect((await readGoUsage('K', fail)).error).toBe('go_http_403')
    const s: any = buildGoQuotaStatus({ usage: null, error: 'go_http_403', accountHint: 'h', models: ['m'], modelsSource: '', measuredAt: AT })
    expect(s.error).toBe('go_http_403')
    expect(s.accounts).toEqual({})
  })

  test('отпечаток не содержит ключа', () => {
    expect(accountHintFor('sk-SECRET')).not.toContain('SECRET')
  })
})

describe('чьи модели', () => {
  test('подписка: id с приставкой opencode-go/', async () => {
    const models = (async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'muse-spark-1.3-contributor' }, { id: 7 }] }) })) as any
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
  test('файл пишется атомарно той же формы', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-goq-'))
    try {
      const auth = join(dir, 'auth.json')
      writeFileSync(auth, JSON.stringify({ 'opencode-go': { type: 'api', key: 'K' } }))
      const out = join(dir, 'quota-status-opencode-go.json')
      const fetchFn = (async (url: string) => {
        if (String(url).includes('/models')) return { ok: true, status: 200, json: async () => ({ data: [{ id: 'm' }] }) }
        return { ok: true, status: 200, json: async () => LIVE }
      }) as any
      const s: any = await collectOnce({ authJsonPath: auth, litellmConfigPath: join(dir, 'nope.yaml'), outPath: out, fetcher: fetchFn, now: () => AT })
      expect(s.provider).toBe('opencode-go')
      const onDisk = JSON.parse(readFileSync(out, 'utf8'))
      expect(onDisk.provider).toBe('opencode-go')
      expect(Object.keys(onDisk.accounts)).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readGoKey терпит отсутствие файла', () => {
    expect(readGoKey('/nonexistent/auth.json')).toBeNull()
  })
})
