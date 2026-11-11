/**
 * Потолок одновременности OpenDesign — испытания.
 *
 * ЖИВОЙ СЛУЧАЙ (11.11.2026 09:17:02Z): двенадцать вызовов флота пришли одновременно,
 * дверь выбрала аккаунт по запасу (запас у них одинаковый) — все на hello@uniclowd.com,
 * и одиннадцатый получил от поставщика `400 tier_limit_exceeded: membership concurrency
 * limit exceeded: 11/10`. Свой потолок ниже поставщиковского — единственный способ
 * не получить его отказ; очередь — единственный способ не превратить потолок в 400.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import {
  acquireOdSlot,
  odInFlightByEmail,
  odQueueMaxWaitMs,
  odSlotCap,
  odSlotFree,
  odSlotSnapshot,
  OdSlotQueueTimeout,
  pickOpenDesignAccount,
  resetOdSlotsForTest,
  tryAcquireOdSlot,
  odMergedRates,
  odRecordSpendForTest,
  odRealSpendSnapshot,
  resetOdRatesCacheForTest,
  resetOdSpendForTest,
  type OdAccountView,
} from './modules/open-design-door.js'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const KEY = (email: string | null) => (email ? `KEY_${email}` : null)

const NOW = Date.parse('2026-11-11T12:00:00Z')
/** Окно ИЗМЕРЕНО (resetAt задан): без него вердикт `unknown`, и запас не считается. */
const acc = (account: string, usedFraction = 0.2, resetsInH = 4): OdAccountView => ({
  account,
  status: 'active',
  headroomFraction: 1 - usedFraction,
  windows: [{ name: '5h', usedFraction, resetsAt: new Date(NOW + resetsInH * 3_600_000).toISOString() }],
})

const realEnv = { ...process.env }
afterEach(() => {
  resetOdSlotsForTest()
  process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = realEnv.OD_MAX_CONCURRENT_PER_ACCOUNT
  process.env.OD_QUEUE_MAX_WAIT_MS = realEnv.OD_QUEUE_MAX_WAIT_MS
})

describe('потолок слотов — настройка, а не константа', () => {
  test('по умолчанию 8 из 10 (поставщиковский потолок — 10)', () => {
    expect(odSlotCap({} as NodeJS.ProcessEnv)).toBe(8)
    expect(odQueueMaxWaitMs({} as NodeJS.ProcessEnv)).toBe(30_000)
  })

  test('выше 10 не поднимаем: это потолок поставщика, а не наш', () => {
    expect(odSlotCap({ OD_MAX_CONCURRENT_PER_ACCOUNT: '50' } as NodeJS.ProcessEnv)).toBe(10)
    expect(odSlotCap({ OD_MAX_CONCURRENT_PER_ACCOUNT: '0' } as NodeJS.ProcessEnv)).toBe(8)
    expect(odSlotCap({ OD_MAX_CONCURRENT_PER_ACCOUNT: 'abc' } as NodeJS.ProcessEnv)).toBe(8)
  })
})

describe('занятие слота', () => {
  test('слоты занимаются до потолка и не больше', () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '2'
    const r1 = tryAcquireOdSlot('a')
    const r2 = tryAcquireOdSlot('a')
    expect(r1).not.toBeNull()
    expect(r2).not.toBeNull()
    expect(tryAcquireOdSlot('a')).toBeNull()
    expect(odInFlightByEmail().get('a')).toBe(2)
    r1?.()
    expect(odSlotFree('a')).toBe(true)
  })

  test('слоты считаются ПО АККАУНТУ, а не общим счётчиком', () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '1'
    expect(tryAcquireOdSlot('a')).not.toBeNull()
    expect(tryAcquireOdSlot('b')).not.toBeNull()
    expect(odInFlightByEmail().get('a')).toBe(1)
    expect(odInFlightByEmail().get('b')).toBe(1)
  })

  test('повторное освобождение не уводит счётчик в минус', () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '1'
    const r = tryAcquireOdSlot('a')!
    r(); r()
    expect(odInFlightByEmail().get('a')).toBeUndefined()
    expect(odSlotFree('a')).toBe(true)
  })
})

describe('очередь вместо 400', () => {
  test('ждавший получает слот ПРЯМО, когда его отпускают', async () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '1'
    process.env.OD_QUEUE_MAX_WAIT_MS = '5000'
    const held = tryAcquireOdSlot('a')!
    let got = false
    const waiting = acquireOdSlot('a', { sessionId: 'ses_x', model: 'eco' }).then(rel => { got = true; return rel })
    expect(odSlotSnapshot().accounts.a).toEqual({ inFlight: 1, queued: 1 })
    held()
    const rel = await waiting
    expect(got).toBe(true)
    expect(odSlotSnapshot().accounts.a.inFlight).toBe(1)
    rel()
    expect(odSlotFree('a')).toBe(true)
  })

  test('ожидание ограничено и отказ НАЗВАН (Slot guard), а не сырой 400', async () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '1'
    process.env.OD_QUEUE_MAX_WAIT_MS = '60'
    const held = tryAcquireOdSlot('a')!
    const p = acquireOdSlot('a', { sessionId: null, model: 'eco' })
    await expect(p).rejects.toBeInstanceOf(OdSlotQueueTimeout)
    try { await p } catch (e: any) {
      expect(e.message.startsWith('Slot guard:')).toBe(true)
      expect(e.waitedMs).toBeGreaterThanOrEqual(50)
    }
    // Отказавший не занимает слот и не висит в очереди.
    expect(odSlotSnapshot().accounts.a).toEqual({ inFlight: 1, queued: 0 })
    held()
    expect(odSlotFree('a')).toBe(true)
  })

  test('снимок называет, кто занял и кто ждёт', () => {
    process.env.OD_MAX_CONCURRENT_PER_ACCOUNT = '1'
    process.env.OD_QUEUE_MAX_WAIT_MS = '5000'
    const held = tryAcquireOdSlot('a')!
    void acquireOdSlot('a', { sessionId: 'ses_wait', model: 'eco' }).then(r => r())
    const snap = odSlotSnapshot()
    expect(snap.cap).toBe(1)
    expect(snap.accounts.a.inFlight).toBe(1)
    expect(snap.waiters[0]?.sessionId).toBe('ses_wait')
    expect(snap.waiters[0]?.account).toBe('a')
    held()
  })
})

describe('расход в реальном времени поверх опроса', () => {
  test('токены наших запросов дают мгновенную скорость, опрос — проставку', () => {
    const file = join(tmpdir(), `od-samples-${Date.now()}.jsonl`)
    const lines = [
      JSON.stringify({ ms: NOW - 30 * 60_000, provider: 'open-design', orgs: [{ name: 'a', windows: [{ window: '5h', util: 0.10 }] }] }),
      JSON.stringify({ ms: NOW - 10 * 60_000, provider: 'open-design', orgs: [{ name: 'a', windows: [{ window: '5h', util: 0.20 }] }] }),
    ].join('\n')
    writeFileSync(file, lines)
    process.env.QUOTA_SAMPLES_PATH = file
    resetOdRatesCacheForTest()
    resetOdSpendForTest()
    try {
      // Опрос: 0.10 доли за 20 минут = 0.30/час.
      // Наши записи за те же 30 минут: 300k токенов → 600k/час → проставка 0.3/600k = 5e-7.
      odRecordSpendForTest('a', { input: 150_000, output: 0 }, NOW - 25 * 60_000)
      odRecordSpendForTest('a', { input: 140_000, output: 10_000 }, NOW - 5 * 60_000)
      // За последние 10 минут: 150k токенов → 900k/час → 0.45/час, больше опроса.
      const rates = odMergedRates(NOW)
      expect(rates.get('a')?.['5h']).toBeCloseTo(0.45, 6)
      expect(odRealSpendSnapshot(NOW).a.tokensIn10m).toBe(150_000)
    } finally {
      delete process.env.QUOTA_SAMPLES_PATH
      resetOdRatesCacheForTest()
      resetOdSpendForTest()
      try { unlinkSync(file) } catch { /* уже нет */ }
    }
  })

  test('без проставки (нет опроса) мгновенная скорость не выдумывается', () => {
    resetOdRatesCacheForTest()
    resetOdSpendForTest()
    odRecordSpendForTest('b', { input: 100_000, output: 0 }, NOW - 5 * 60_000)
    delete process.env.QUOTA_SAMPLES_PATH
    resetOdRatesCacheForTest()
    try {
      expect(odMergedRates(NOW).has('b')).toBe(false)
    } finally {
      resetOdSpendForTest()
      resetOdRatesCacheForTest()
    }
  })
})

describe('выбор по ПРЕДСКАЗАННОМУ давлению, а не по текущей занятости', () => {
  const accAt = (account: string, used: number, resetsInH: number): OdAccountView => ({
    account,
    status: 'active',
    headroomFraction: 1 - used,
    windows: [{ name: '5h', usedFraction: used, resetsAt: new Date(NOW + resetsInH * 3_600_000).toISOString() }],
  })

  test('медленно горящая с большим util идёт раньше быстро горящей с малым util', () => {
    // Слово фаундера: «через пять-десять минут она будет самой занятой». A сожжёт остаток
    // за ~3 часа (0.3/час), B — за ~7 часов (0.09/час), хотя util у B выше.
    const pick = pickOpenDesignAccount(
      [accAt('fast', 0.1, 4), accAt('slow', 0.35, 1)],
      KEY,
      {
        nowMs: NOW,
        recentRatesByEmail: new Map([['fast', { '5h': 0.3 }]]),
        slotCap: 8,
        inFlightByEmail: new Map([['fast', 0], ['slow', 0]]),
        seed: 's',
      },
    )
    expect(pick?.email).toBe('slow')
  })

  test('одинаковые окна — лишние одновременные вызовы повышают давление', () => {
    const pick = pickOpenDesignAccount([accAt('busy', 0.2, 4), accAt('free', 0.2, 4)], KEY, {
      nowMs: NOW,
      slotCap: 8,
      inFlightByEmail: new Map([['busy', 5], ['free', 0]]),
      seed: 's',
    })
    expect(pick?.email).toBe('free')
  })

  test('ряд скорости не выдумывается: без производной решает запас', () => {
    const pick = pickOpenDesignAccount([accAt('a', 0.1, 4), accAt('b', 0.3, 4)], KEY, {
      nowMs: NOW, slotCap: 8, seed: 's',
    })
    expect(pick?.email).toBe('a')
  })
})

describe('выбор аккаунта знает про слоты', () => {
  test('занятый аккаунт не выбирается, даже когда у него лучший запас', () => {
    const accounts = [acc('busy', 0.1), acc('free', 0.5)]
    const inflight = new Map([['busy', 2]])
    const pick = pickOpenDesignAccount(accounts, KEY, {
      nowMs: Date.parse('2026-11-11T12:00:00Z'),
      inFlightByEmail: inflight,
      slotCap: 2,
      seed: 's',
    })
    expect(pick?.email).toBe('free')
  })

  test('все слоты заняты — кандидата нет (дверь уходит в очередь, а не отвечает 400)', () => {
    const accounts = [acc('a', 0.1), acc('b', 0.2)]
    const inflight = new Map([['a', 2], ['b', 2]])
    const pick = pickOpenDesignAccount(accounts, KEY, {
      nowMs: Date.parse('2026-11-11T12:00:00Z'),
      inFlightByEmail: inflight,
      slotCap: 2,
    })
    expect(pick).toBeNull()
  })

  test('РАЗМАЗЫВАНИЕ: одинаково свободные — решает запас (прежний порядок)', () => {
    const pick = pickOpenDesignAccount([acc('a', 0.1), acc('b', 0.2)], KEY, {
      nowMs: NOW,
      inFlightByEmail: new Map([['a', 0], ['b', 0]]),
      slotCap: 8,
      seed: 's',
    })
    expect(pick?.email).toBe('a')
  })

  test('РАЗМАЗЫВАНИЕ: последовательные вызовы расходятся по аккаунтам, а не копятся на одном', () => {
    // Окна РАВНЫЕ, поэтому решает только занятость: лишний одновременный вызов поднимает
    // прогнозируемое давление и уступает соседнему аккаунту.
    const inflight = new Map<string, number>([['a', 0], ['b', 0]])
    const picks: string[] = []
    for (let i = 0; i < 6; i++) {
      const p = pickOpenDesignAccount([acc('a', 0.2), acc('b', 0.2)], KEY, {
        nowMs: NOW, inFlightByEmail: inflight, slotCap: 8, seed: `s${i}`,
      })
      expect(p).not.toBeNull()
      const email = p!.email
      picks.push(email)
      inflight.set(email, (inflight.get(email) ?? 0) + 1)
    }
    // Не «всё на один»: оба аккаунта получили нагрузку, перекос не больше двух.
    const counts = { a: picks.filter(e => e === 'a').length, b: picks.filter(e => e === 'b').length }
    expect(Math.min(counts.a, counts.b)).toBeGreaterThanOrEqual(2)
  })

  test('без slotCap слоты в выборе не учитываются — прежнее поведение не тронуто', () => {
    const pick = pickOpenDesignAccount([acc('a', 0.1)], KEY, {
      nowMs: Date.parse('2026-11-11T12:00:00Z'),
      inFlightByEmail: new Map([['a', 99]]),
    })
    expect(pick?.email).toBe('a')
  })
})
