/**
 * КАРТОЧКА ЧЕЛОВЕКУ — ТРЕТЬЯ ДВЕРЬ ТРЕВОГИ.
 *
 * Замер, ради которого она есть (владелец tixi-cold, 13.09.2026): его смена
 * простояла у сторожа двое суток, фаундер трижды написал ей и трижды получил
 * ответ не от неё, а от сторожа — «снаружи „агент молчит“ и „агента сняли“
 * выглядели одинаково». Круг не размыкается изнутри: чтобы дать согласие,
 * агенту нужен ход, а отказ приходит раньше хода.
 *
 * Здесь проверяется ровно то, на чём эта цепь может сломаться молча:
 * 1) стоящая сессия ДЕЙСТВИТЕЛЬНО зовёт человека, а не только журнал;
 * 2) конверт — той формы, которую чужая дверь разбирает (иначе 400 у соседа);
 * 3) совет считается по замеру, а при отсутствии срока НЕ ВЫДУМЫВАЕТСЯ;
 * 4) провал чужой двери НЕ роняет тревогу и не остаётся немым;
 * 5) 🔴 прогон набора НЕ СТУЧИТСЯ в живую дверь машины.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startLocalAlert, _setAlertDelivery, _setAliveProbe, _stuckState } from '../src/local-alert.js'
import { _setCardSender, adviceFor, type StuckCardAsk } from '../src/surface-card.js'
import { emit } from '../src/event-bus.js'

let stop: (() => void) | null = null
let dir: string | null = null

afterEach(() => {
  try { stop?.() } catch { /* уже остановлена */ }
  stop = null
  if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ушёл сам */ } }
  dir = null
  _setCardSender(null)
  _setAlertDelivery(null)
  _setAliveProbe(null)
  _stuckState.clear()
})

/** Тревога на СВОЁМ файле состояния — живой файл машины не в игре. */
function arm(owner?: { pid: number | null; cwd: string | null }): void {
  dir = mkdtempSync(join(tmpdir(), 'surface-card-'))
  const statePath = join(dir, 'blocked-sessions.json')
  // Одной строкой НАРОЧНО: сторож `local-alert-never-writes-live-state` читает
  // исходники испытаний и требует `statePath` в той же строке, что и зов. Он
  // прав — перенос делает его слепым, а цена слепоты уже заплачена 11.09.2026,
  // когда прогон дважды переписал боевой учёт машины.
  stop = startLocalAlert(() => owner ?? { pid: null, cwd: null }, { statePath })
}

/** Ловим конверты вместо сети. */
function capture(result: Partial<{ raised: boolean; reason: string; interactionUuid: string }> = {}) {
  const seen: StuckCardAsk[] = []
  _setCardSender(async (ask) => { seen.push(ask); return { raised: true, ...result } })
  return seen
}

const blocked = (over: Record<string, unknown> = {}) => emit({
  level: 'error',
  kind: 'CACHE_REWRITE_BLOCKED',
  sessionId: 'sess-stuck-1',
  consecutiveBlocks: 3,
  predictedTokens: 307_367,
  rewriteClass: 'avoidable:ttl-expiry',
  spendKind: 'rewrite',
  idleMs: 17_280_000,          // 4.8 ч — кэша давно нет
  ...over,
} as never)

describe('стоящая сессия зовёт человека, а не только журнал', () => {
  test('на объявлении карточка поднимается и несёт обязательные четыре поля', async () => {
    _setAlertDelivery(() => {})
    arm({ pid: 4242, cwd: '/home/relishev/projects/vibe/tixi-cold' })
    const seen = capture()
    blocked()
    await Promise.resolve()

    expect(seen.length).toBe(1)
    const ask = seen[0]
    // Четыре обязательных — без любого из них чужая дверь отвечает 400.
    expect(ask.sessionId).toBe('sess-stuck-1')
    expect(ask.guard).toBe('cache')
    expect(typeof ask.reason).toBe('string')
    expect(ask.reason.length).toBeGreaterThan(0)
    expect(typeof ask.stuckForSec).toBe('number')
    expect(ask.stuckForSec).toBeGreaterThanOrEqual(0)
  })

  test('каталог и процесс владельца едут как есть — «сессия abc» человеку ничего не говорит', async () => {
    _setAlertDelivery(() => {})
    arm({ pid: 4242, cwd: '/home/relishev/projects/vibe/tixi-cold' })
    _setAliveProbe(() => true)
    const seen = capture()
    blocked()
    await Promise.resolve()

    expect(seen[0].cwd).toBe('/home/relishev/projects/vibe/tixi-cold')
    expect(seen[0].pid).toBe(4242)
    expect(seen[0].liveness).toBe('alive')
  })

  test('владельца опознать не удалось → liveness говорит «проверить нечем», а не «жив»', async () => {
    _setAlertDelivery(() => {})
    arm({ pid: null, cwd: null })
    const seen = capture()
    blocked()
    await Promise.resolve()

    expect(seen[0].liveness).toBe('unknown')
    expect(seen[0].pid).toBeUndefined()
  })

  test('мёртвый процесс назван мёртвым', async () => {
    _setAlertDelivery(() => {})
    arm({ pid: 777, cwd: '/tmp/x' })
    _setAliveProbe(() => false)
    const seen = capture()
    blocked()
    await Promise.resolve()

    expect(seen[0].liveness).toBe('dead')
  })
})

describe('совет считается по замеру и не выдумывается', () => {
  test('кэш умер больше часа назад → перезапуск, а не покупка позавчерашнего разговора', async () => {
    _setAlertDelivery(() => {})
    arm()
    const seen = capture()
    blocked({ idleMs: 4 * 3_600_000, spendKind: 'rewrite' })
    await Promise.resolve()

    expect(seen[0].advice).toBe('restart')
  })

  test('первая запись ничего не выбрасывает → разрешить', async () => {
    _setAlertDelivery(() => {})
    arm()
    const seen = capture()
    blocked({ spendKind: 'first-write', rewriteClass: 'expected:cold-start', idleMs: 9 * 3_600_000 })
    await Promise.resolve()

    expect(seen[0].advice).toBe('grant')
  })

  test('🔴 срока нет — совета НЕТ ВОВСЕ: выдуманный совет человек примет за замер', async () => {
    _setAlertDelivery(() => {})
    arm()
    const seen = capture()
    blocked({ idleMs: undefined })
    await Promise.resolve()

    expect(seen[0].advice).toBeUndefined()
  })

  test('правило совета само по себе: граница — срок жизни кэша', () => {
    expect(adviceFor('rewrite', 59 * 60_000)).toBe('grant')
    expect(adviceFor('rewrite', 61 * 60_000)).toBe('restart')
    expect(adviceFor('first-write', 99 * 3_600_000)).toBe('grant')
    expect(adviceFor('rewrite', null)).toBe('grant')
  })
})

describe('чужая дверь может подвести, и это не должно быть немым', () => {
  test('отказ двери не роняет тревогу и попадает в журнал своими словами', async () => {
    const said: string[] = []
    _setAlertDelivery((subject, body) => said.push(`${subject} :: ${body}`))
    arm()
    _setCardSender(async () => ({ raised: false, reason: 'дверь отказала: stuck_card_not_wired' }))
    blocked()
    await new Promise((r) => setTimeout(r, 5))

    expect(said.some((s) => s.includes('поднять не удалось'))).toBe(true)
    expect(said.some((s) => s.includes('stuck_card_not_wired'))).toBe(true)
    // И главная тревога всё равно прозвучала — местные двери от сети не зависят.
    expect(said.some((s) => s.includes('стоит у сторожа кэша'))).toBe(true)
  })

  test('брошенное исключение из двери не выходит наружу', async () => {
    _setAlertDelivery(() => {})
    arm()
    _setCardSender(async () => { throw new Error('сеть легла') })
    expect(() => blocked()).not.toThrow()
    await new Promise((r) => setTimeout(r, 5))
  })
})

describe('🔴 сторож: прогон набора не стучится в живую дверь машины', () => {
  test('без шва и без секрета карточка не уходит, а называет причину', async () => {
    const prevEnv = process.env.SURFACE_SPAWN_CONSENT_SECRET
    const prevFile = process.env.SURFACE_CONSENT_ENV
    const prevOff = process.env.PROXY_SURFACE_CARD
    delete process.env.PROXY_SURFACE_CARD   // проверяем именно отсутствие секрета
    delete process.env.SURFACE_SPAWN_CONSENT_SECRET
    process.env.SURFACE_CONSENT_ENV = join(tmpdir(), 'no-such-surface-consent.env')
    const { raiseStuckCard, _forgetSecret } = await import('../src/surface-card.js')
    _forgetSecret()
    try {
      const r = await raiseStuckCard({
        sessionId: 's', guard: 'cache', reason: 'проверка', stuckForSec: 1,
      })
      expect(r.raised).toBe(false)
      expect(r.reason).toContain('секрет не найден')
    } finally {
      if (prevEnv !== undefined) process.env.SURFACE_SPAWN_CONSENT_SECRET = prevEnv
      if (prevFile !== undefined) process.env.SURFACE_CONSENT_ENV = prevFile
      else delete process.env.SURFACE_CONSENT_ENV
      if (prevOff !== undefined) process.env.PROXY_SURFACE_CARD = prevOff
      _forgetSecret()
    }
  })

  test('выключатель PROXY_SURFACE_CARD=0 закрывает дверь целиком', async () => {
    const prev = process.env.PROXY_SURFACE_CARD
    process.env.PROXY_SURFACE_CARD = '0'
    const { raiseStuckCard } = await import('../src/surface-card.js')
    try {
      const r = await raiseStuckCard({
        sessionId: 's', guard: 'cache', reason: 'проверка', stuckForSec: 1,
      })
      expect(r.raised).toBe(false)
      expect(r.reason).toContain('выключена')
    } finally {
      if (prev !== undefined) process.env.PROXY_SURFACE_CARD = prev
      else delete process.env.PROXY_SURFACE_CARD
    }
  })
})
