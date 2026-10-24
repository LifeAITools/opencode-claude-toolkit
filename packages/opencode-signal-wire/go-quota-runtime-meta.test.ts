/**
 * Плоские поля квоты для подвала — из ТОГО счётчика, который обслуживает сессию.
 *
 * Замер 22.10.2026: у сессии на OpenCode Go блок подвала был ПУСТЫМ (`5h= (pool )`), хотя окна
 * Go лежали в `providerQuota`. Причина: `quotaUtil5h/7d` заполнялись только из заголовков
 * rate-limit, а их даёт лишь дверь Anthropic. Договор ядра (коммит 6133884) называет, что отдать:
 * util 5h/7d, имя счёта, возраст снимка и источник — и НЕ отдавать `quotaPool*`/`quotaStale`.
 */
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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
    // Ярлык старости без доказательства по-прежнему НЕ ставим.
    expect(m.quotaStale).toBeUndefined()
  })

  // 🔴 ПРАВИЛО ПРО ПУЛ ПЕРЕСМОТРЕНО ВЛАДЕЛЬЦЕМ (фаундер 24.10.2026: «в подвале не показывается по
  // организации статистика; если цикл замкнут, всё должно браться из реестра и показываться»).
  // До этого `quotaPool*` не заполнялись намеренно: в `providerQuota` лежала ОДНА запись go, и
  // «пул» из неё был бы моим же числом под чужим именем. Теперь отчёт несёт ВСЕ организации
  // реестра, поэтому пул — настоящая величина: минимум по ним.
  test('пул — минимум по РЕЕСТРУ, а не копия своего числа', () => {
    process.env.KIBEROS_GO_ORG = 'hello@uniclowd.com'
    const dir = mkdtempSync(join(tmpdir(), 'sw-pool-'))
    const report = join(dir, 'go.json')
    writeFileSync(report, JSON.stringify({
      measured_at: NOW,
      orgs: [
        { name: 'hello@uniclowd.com', util5h: 0.22, util7d: 0.09, level: 'ok' },
        { name: 'hello@fresh.example', util5h: 0.0, util7d: 0.5, level: 'ok' },
        { name: 'hello@empty.example', util5h: null, util7d: null },
      ],
    }))
    const prev = process.env.GO_QUOTA_STATUS_JSON
    process.env.GO_QUOTA_STATUS_JSON = report
    try {
      const sw = make()
      sw.trackProviderQuota([goQuota()])
      const m: any = sw.getCurrentRuntimeMeta()
      // Своё число НЕ подменяется пулом: 5h моей организации остаётся 0.22.
      expect(m.quotaUtil5h).toBeCloseTo(0.22, 5)
      // Пул — минимум по реестру: свежая организация даёт 0.00.
      expect(m.quotaPoolUtil5h).toBeCloseTo(0, 5)
      expect(m.quotaPoolUtil7d).toBeCloseTo(0.09, 5)
      // Организация без чисел в счёт пула не идёт: «не знаю» не равно «ноль».
      expect(m.quotaPoolAccounts).toBe(2)
      expect(m.quotaLevel).toBe('ok')
    } finally {
      if (prev === undefined) delete process.env.GO_QUOTA_STATUS_JSON
      else process.env.GO_QUOTA_STATUS_JSON = prev
    }
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

  test('РЕЗЕРВ В ПЛОСКИЕ ПОЛЯ НЕ ПОПАДАЕТ вовсе', () => {
    // 🔴 22.10.2026: оценка по расходу всегда штампуется `now`, то есть ВСЕГДА выглядит свежей и
    // протухнуть не может. Живой случай: она выдала util5h=1 при окне 0.01, и правило позвало
    // агента на сдачу смены. Оценка не измерение — в плоских полях ей места нет.
    process.env.KIBEROS_GO_ORG = 'hello@kiberos.app'
    const sw = make()
    sw.trackProviderQuota([goQuota({ source: 'spend-estimate' })])
    const m: any = sw.getCurrentRuntimeMeta()
    expect(m.quotaUtil5h).toBeUndefined()
    expect(m.quotaUtil7d).toBeUndefined()
    expect(m.quotaAccountHint).toBeUndefined()
    expect(m.quotaSource).toBeUndefined()
  })
})
