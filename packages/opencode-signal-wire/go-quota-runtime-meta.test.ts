/**
 * Плоские поля квоты для подвала — из ТОГО счётчика, который обслуживает сессию.
 *
 * Замер 22.10.2026: у сессии на OpenCode Go блок подвала был ПУСТЫМ (`5h= (pool )`), хотя окна
 * Go лежали в `providerQuota`. Причина: `quotaUtil5h/7d` заполнялись только из заголовков
 * rate-limit, а их даёт лишь дверь Anthropic. Договор ядра (коммит 6133884) называет, что отдать:
 * util 5h/7d, имя счёта, возраст снимка и источник — и НЕ отдавать `quotaPool*`/`quotaStale`.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalWire } from './signal-wire'
import type { ProviderQuota } from './provider-quota'

process.env.SW_EXEC_OFF = '1'

const NOW = '2026-10-22T12:08:15.674Z'
const goQuota = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({
  provider: 'go',
  source: 'subscription',
  measuredAt: NOW,
  limits: [],
  windows: [
    { kind: '5h', util: 0.22, measuredAt: NOW },
    { kind: '7d', util: 0.09, measuredAt: NOW },
    { kind: '30d', util: 0.04, measuredAt: NOW },
  ],
  ...over,
})

function make(): SignalWire {
  return new SignalWire({
    serverUrl: 'http://127.0.0.1:0',
    sessionId: 'ses_quotameta',
    rulesPath: join(mkdtempSync(join(tmpdir(), 'sw-qm-')), 'none.json'),
    platform: 'opencode',
  })
}

describe('плоские поля квоты (договор ядра 6133884)', () => {
  let prevOrg: string | undefined
  beforeEach(() => { prevOrg = process.env.KIBEROS_GO_ORG })
  afterEach(() => {
    if (prevOrg === undefined) delete process.env.KIBEROS_GO_ORG
    else process.env.KIBEROS_GO_ORG = prevOrg
  })

  test('сессия на Go: 5h/7d, имя организации, источник и возраст — числа ЕЁ счёта', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeCloseTo(0.22, 5)
    expect(m.quotaUtil7d).toBeCloseTo(0.09, 5)
    expect(m.quotaAccountHint).toBe('hello@uniclowd.com')
    expect(m.quotaSource).toBe('subscription')
    expect(typeof m.quotaSnapshotAgeSeconds).toBe('number')
    // НЕ то, что договор запрещает: пул и ярлык старости без доказательства.
    expect(m.quotaPoolUtil5h).toBeUndefined()
    expect(m.quotaStale).toBeUndefined()
  })

  test('орг есть, а счётчика go нет → полей НЕТ (никакой подстановки чужого счёта)', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    const sw = make()
    sw.trackProviderQuota([{ provider: 'zai', measuredAt: NOW, limits: [], windows: [{ kind: '5h', util: 0.9, measuredAt: NOW }] }])
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaAccountHint).toBeUndefined()
  })

  test('орг не названа → полей НЕТ (неизвестно, а не ноль)', () => {
    delete process.env.KIBEROS_GO_ORG
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaAccountHint).toBeUndefined()
  })

  test('источник резерва называется своим словом, а не выдаётся за подписку', () => {
    process.env.KIBEROS_GO_ORG = 'hello@kiberos.app'
    const sw = make()
    sw.trackProviderQuota([goQuota({ source: 'spend-estimate' })])
    expect((sw.getCurrentRuntimeMeta() as any).quotaSource).toBe('spend-estimate')
  })
})
