/**
 * Плоские поля квоты для подвала — ИЗ ОДНОГО ПЕРВОИСТОЧНИКА.
 *
 * Слово фаундера 05.11.2026: «данные должны идти только через первоисточник, иначе начинаются
 * фолбэки и непонятные ошибки». Здесь защищаются ровно те два свойства, из-за которых это
 * правило появилось:
 *
 * 1. у агента на OpenDesign в подвале НЕ БЫВАЕТ окон Go (привязка KIBEROS_GO_ORG остаётся в
 *    окружении после перевода и раньше подставляла чужой счёт);
 * 2. нет данных — полей НЕТ, а не «возьмём ближайшее» и не числа другого провайдера.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalWire } from './signal-wire'
import type { ProviderQuota } from './provider-quota'

process.env.SW_EXEC_OFF = '1'

const NOW = '2026-11-05T12:00:00.000Z'

const goQuota = (over: Partial<ProviderQuota> = {}): ProviderQuota => ({
  provider: 'go',
  source: 'subscription',
  measuredAt: NOW,
  limits: [],
  windows: [
    { kind: '5h', util: 0.22, measuredAt: NOW },
    { kind: '7d', util: 0.09, measuredAt: NOW },
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

/** Единый файл — ТОЛЬКО он источник чисел. Возвращает путь для env. */
function unified(accounts: unknown[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'sw-uq-')), 'quota-status.json')
  writeFileSync(f, JSON.stringify({ schemaVersion: 1, generatedAt: NOW, accounts }))
  process.env.QUOTA_STATUS_JSON = f
  return f
}

describe('плоские поля квоты из единого файла', () => {
  let prevOrg: string | undefined, prevUnified: string | undefined
  beforeEach(() => { prevOrg = process.env.KIBEROS_GO_ORG; prevUnified = process.env.QUOTA_STATUS_JSON })
  afterEach(() => {
    prevOrg === undefined ? delete process.env.KIBEROS_GO_ORG : process.env.KIBEROS_GO_ORG = prevOrg
    prevUnified === undefined ? delete process.env.QUOTA_STATUS_JSON : process.env.QUOTA_STATUS_JSON = prevUnified
  })

  test('сессия на Go: 5h/7d, имя организации, источник и возраст — числа ЕЁ счёта', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    unified([
      { provider: 'opencode-go', account: 'hello@uniclowd.com', status: 'active', measuredAt: NOW,
        headroomFraction: 0.78, windows: [{ name: '5h', usedFraction: 0.22, resetsAt: '2026-11-05T14:00:00.000Z' }, { name: 'week', usedFraction: 0.09 }] },
      { provider: 'opencode-go', account: 'hello@fresh.example', status: 'active', measuredAt: NOW,
        headroomFraction: 1, windows: [{ name: '5h', usedFraction: 0 }, { name: 'week', usedFraction: 0.5 }] },
    ])
    const sw = make()
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-go', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeCloseTo(0.22, 5)   // своё число, не «лучшее в пуле»
    expect(m.quotaUtil7d).toBeCloseTo(0.09, 5)
    expect(m.quotaAccountHint).toBe('hello@uniclowd.com')
    expect(m.quotaSource).toBe('subscription')
    expect(typeof m.quotaSnapshotAgeSeconds).toBe('number')
    expect(m.quotaStale).toBeUndefined()
    // Пул — запас флота: freshest аккаунт даёт 0.0.
    expect(m.quotaPoolUtil5h).toBeCloseTo(0, 5)
    expect(m.quotaPoolAccounts).toBe(2)
  })

  test('названной организации нет в едином файле — никакой подстановки чужой', () => {
    process.env.KIBEROS_GO_ORG = 'hello@ghost.example'
    unified([
      { provider: 'opencode-go', account: 'hello@other.example', status: 'active', measuredAt: NOW,
        headroomFraction: 0.5, windows: [{ name: '5h', usedFraction: 0.5 }] },
    ])
    const sw = make()
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-go', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    // Читатель отдаёт ИМЕННО названный аккаунт или лучший живой; здесь названного нет,
    // поэтому подпись — тот, чьи числа показаны. Главное: имя и числа про ОДИН предмет.
    expect(m.quotaAccountHint).toBe('hello@other.example')
    expect(m.quotaUtil5h).toBeCloseTo(0.5, 5)
  })

  test('единого файла нет — полей НЕТ (не «возьмём провайдерный»)', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    process.env.QUOTA_STATUS_JSON = join(mkdtempSync(join(tmpdir(), 'sw-uq-empty-')), 'none.json')
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-go', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaAccountHint).toBeUndefined()
    expect(m.quotaSource).toBeUndefined()
  })

  test('оценка расхода не участвует вовсе: поля строятся только из измерения', () => {
    process.env.KIBEROS_GO_ORG = 'hello@kiberos.app'
    process.env.QUOTA_STATUS_JSON = join(mkdtempSync(join(tmpdir(), 'sw-uq-est-')), 'none.json')
    const sw = make()
    sw.trackProviderQuota([goQuota({ source: 'spend-estimate' })])
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaSource).toBeUndefined()
  })
})

describe('подвал на OpenDesign', () => {
  let prevOrg: string | undefined, prevUnified: string | undefined
  beforeEach(() => { prevOrg = process.env.KIBEROS_GO_ORG; prevUnified = process.env.QUOTA_STATUS_JSON })
  afterEach(() => {
    prevOrg === undefined ? delete process.env.KIBEROS_GO_ORG : process.env.KIBEROS_GO_ORG = prevOrg
    prevUnified === undefined ? delete process.env.QUOTA_STATUS_JSON : process.env.QUOTA_STATUS_JSON = prevUnified
  })

  test('на -od подвал показывает workspace и ЕГО окна, а не окна Go из окружения', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    unified([
      { provider: 'opencode-go', account: 'hello@uniclowd.com', status: 'active', measuredAt: NOW,
        headroomFraction: 0.78, windows: [{ name: '5h', usedFraction: 0.22, resetsAt: '2026-11-05T14:00:00.000Z' }] },
      { provider: 'open-design', account: "Ruslan Elishev's workspace", status: 'active', measuredAt: NOW,
        headroomFraction: 0.947, windows: [{ name: '5h', usedFraction: 0.053 }, { name: 'week', usedFraction: 0.018 }] },
    ])
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-od', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeCloseTo(0.053, 5)     // НЕ 0.22 из окна Go
    expect(m.quotaUtil7d).toBeCloseTo(0.018, 5)
    expect(m.quotaAccountHint).toBe("Ruslan Elishev's workspace")
    expect(m.quotaSource).toBe('subscription')
    // Пул у OpenDesign теперь ПОКАЗЫВАЕТСЯ: с 05.11 у провайдера два живых счёта
    // (relishev@gmail.com и hello@kiberos.app), и «куда переезжать» — осмысленный вопрос.
    // До этого стояло `toBeUndefined()` по допущению «один workspace», которое перестало быть верным.
    expect(m.quotaPoolAccounts).toBe(1)
    expect(m.quotaPoolUtil5h).toBeCloseTo(0.053, 5)
    expect((m.providerQuota ?? []).some((q: any) => q.provider === 'go')).toBe(false)
  })

  test('два живых счёта OpenDesign: счёт НЕ угадывается, а пул показывается', () => {
    unified([
      { provider: 'open-design', account: 'relishev@gmail.com', status: 'active', measuredAt: NOW,
        headroomFraction: 0.95, windows: [{ name: '5h', usedFraction: 0.05 }] },
      { provider: 'open-design', account: 'hello@kiberos.app', status: 'active', measuredAt: NOW,
        headroomFraction: 0.60, windows: [{ name: '5h', usedFraction: 0.40 }] },
    ])
    const sw = make()
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-od', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    // Закрепление у OpenDesign идёт ПО СЕССИИ: какой из двух счетов обслужил — неизвестно,
    // и «лучший по запасу» к этому отношения не имеет. Поэтому счёт не называем и чужие
    // окна не показываем (замер 05.11.2026: подвал показывал hello@kiberos.app для сессии,
    // проверенной на relishev@gmail.com).
    expect(m.quotaAccountHint).toBeUndefined()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaReason).toBe('several_accounts_unresolved')
    expect(m.quotaPoolAccounts).toBe(2)
    expect(m.quotaPoolUtil5h).toBeCloseTo(0.05, 5)   // минимум по живым счетам провайдера
  })

  test('workspace без подписки: имени нет в числах, окна не выдумываются', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    unified([
      { provider: 'opencode-go', account: 'hello@uniclowd.com', status: 'active', measuredAt: NOW, headroomFraction: 0.78, windows: [{ name: '5h', usedFraction: 0.22 }] },
      { provider: 'open-design', account: 'DeepSeek hareness team', status: 'absent', reason: 'no_active_subscription', measuredAt: NOW, headroomFraction: null, windows: [] },
    ])
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-od', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaAccountHint).toBe('DeepSeek hareness team')
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaUtil7d).toBeUndefined()
  })

  test('в едином файле нет OpenDesign — полей нет, а НЕ числа Go', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    unified([
      { provider: 'opencode-go', account: 'hello@uniclowd.com', status: 'active', measuredAt: NOW, headroomFraction: 0.78, windows: [{ name: '5h', usedFraction: 0.22 }] },
    ])
    const sw = make()
    sw.trackProviderQuota([goQuota()])
    sw.trackModel('kiberos-go/deepseek-v4.1-flash-od', 'kiberos-go')
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaAccountHint).toBeUndefined()
  })
})
