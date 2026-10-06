/**
 * Двери лимитов Zhipu/Z.ai — разбор ответа без сети (provider-quota.ts).
 * Формы ответов — живые, 06.10.2026 (секреты вычищены, числа настоящие).
 */
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { mapLimitsToWindows, PROVIDER_QUOTA_ENDPOINTS, queryProviderQuota } from './provider-quota'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'

const NOW = new Date('2026-10-06T06:00:00.000Z')

// Живой ответ bigmodel.cn: у первого лимита нет usage/currentValue/reset —
// только percentage; у второго есть percentage и сброс, но нет usage.
const zhipuBody = {
  code: 200, msg: 'ok', success: true,
  data: { limits: [
    { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 0 },
    { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 16, nextResetTime: 1791363922960 },
    { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 1000, currentValue: 0, remaining: 1000, percentage: 0, nextResetTime: 1793523922999 },
  ] },
}

const fetchOk = (body: unknown) => async (url: string, _init: any) => {
  expect(url).toBe(PROVIDER_QUOTA_ENDPOINTS.zai)
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

describe('двери лимитов: разбор без толкования', () => {
  test('лимиты везутся как есть; сброс — ISO-строкой; unit/number — сырьём', async () => {
    const q = (await queryProviderQuota(fetchOk(zhipuBody), 'zai', 'KEY', NOW))!
    expect(q.provider).toBe('zai')
    expect(q.measuredAt).toBe(NOW.toISOString())
    expect(q.limits).toEqual([
      { type: 'TOKENS_LIMIT', percentage: 0, unit: 3, number: 5 },
      { type: 'TOKENS_LIMIT', percentage: 16, resetAt: new Date(1791363922960).toISOString(), unit: 6, number: 1 },
      { type: 'TIME_LIMIT', percentage: 0, used: 0, total: 1000, remaining: 1000, resetAt: new Date(1793523922999).toISOString(), unit: 5, number: 1 },
    ])
    // Окна — по отображению владельца ядра: unit 3 → 5h, unit 6 → 7d, TIME_LIMIT не окна.
    expect(q.windows).toEqual([
      { kind: '5h', util: 0, measuredAt: NOW.toISOString() },
      { kind: '7d', util: 0.16, resetAt: new Date(1791363922960).toISOString(), measuredAt: NOW.toISOString() },
    ])
  })

  test('проводка: лимиты едут в runtimeMeta, пусто — ключа нет', () => {
    const sw = new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_q', rulesPath: join(process.env.SW_HEARTBEAT_DIR!, 'none.json'), platform: 'opencode' })
    expect((sw.getCurrentRuntimeMeta() as any).providerQuota).toBeUndefined()
    sw.trackProviderQuota([{ provider: 'zai', measuredAt: NOW.toISOString(), limits: [{ type: 'TOKENS_LIMIT', percentage: 16 }], windows: [{ kind: '5h', util: 0.16, measuredAt: NOW.toISOString() }] }])
    expect((sw.getCurrentRuntimeMeta() as any).providerQuota).toEqual([
      { provider: 'zai', measuredAt: NOW.toISOString(), limits: [{ type: 'TOKENS_LIMIT', percentage: 16 }], windows: [{ kind: '5h', util: 0.16, measuredAt: NOW.toISOString() }] },
    ])
    sw.trackProviderQuota(null)
    expect((sw.getCurrentRuntimeMeta() as any).providerQuota).toBeUndefined()
  })
  test('пусто = null: нет ключа, отказ, чужой код, не массив, мусор вместо лимитов', async () => {
    expect(await queryProviderQuota(fetchOk(zhipuBody), 'zai', '', NOW)).toBeNull()
    const fail = async () => ({ ok: false, status: 429, json: async () => ({}), text: async () => 'busy' })
    expect(await queryProviderQuota(fail as any, 'zai', 'KEY', NOW)).toBeNull()
    const badCode = async () => ({ ok: true, status: 200, json: async () => ({ code: 500, success: false }), text: async () => '' })
    expect(await queryProviderQuota(badCode as any, 'zai', 'KEY', NOW)).toBeNull()
    const noLimits = async () => ({ ok: true, status: 200, json: async () => ({ code: 200, success: true, data: {} }), text: async () => '' })
    expect(await queryProviderQuota(noLimits as any, 'zai', 'KEY', NOW)).toBeNull()
    const junk = async () => ({ ok: true, status: 200, json: async () => ({ code: 200, success: true, data: { limits: [{ type: 'NOPE' }] } }), text: async () => '' })
    expect(await queryProviderQuota(junk as any, 'zai', 'KEY', NOW)).toBeNull()
    const throws = async (): Promise<never> => { throw new Error('down') }
    expect(await queryProviderQuota(throws as any, 'zai', 'KEY', NOW)).toBeNull()
  })
})

describe('отображение в окна — дословно по строке владельца ядра', () => {
  // Импорт mapLimitsToWindows — через тот же модуль, без новых зависимостей.
  test('другой unit — tokens-uN как есть; без unit — tokens-unknown; TIME_LIMIT не окно', () => {
    const m = '2026-10-06T06:20:00.000Z'
    expect(mapLimitsToWindows([
      { type: 'TOKENS_LIMIT', percentage: 50, unit: 9, number: 2 },
      { type: 'TOKENS_LIMIT', percentage: 10 },
      { type: 'TIME_LIMIT', percentage: 0, used: 0, total: 1000 },
    ], m)).toEqual([
      { kind: 'tokens-u9', util: 0.5, measuredAt: m },
      { kind: 'tokens-unknown', util: 0.1, measuredAt: m },
    ])
  })
})
