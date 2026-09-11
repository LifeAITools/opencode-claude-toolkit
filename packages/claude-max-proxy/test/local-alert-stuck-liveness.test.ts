/**
 * Тревога по состоянию обязана знать, ЖИВ ЛИ ТОТ, О КОМ ОНА КРИЧИТ.
 *
 * 🔴 ЗАМЕР, КУПИВШИЙ ЭТИ ТЕСТЫ — 11.09.2026, свой собственный файл состояния.
 * В `~/.claude-local/blocked-sessions.json` лежали СЕМЬ стоящих сессий, и по
 * каждой обход честно напоминал от 9 до 18 раз. Живой из семи была ОДНА
 * (последний отказ накануне вечером); остальные шесть встали 02–05.09 и с тех
 * пор не сделали ни одной попытки — их процессов давно нет.
 *
 * Почему снятие с учёта не сработало: оно висит на событии `SESSION_DEAD`, а
 * его выдаёт `reapDead()`, обходя ПАМЯТЬ трекера. Память умирает с каждым
 * перезапуском службы (в иные дни их четыре за день), а файл стоящих —
 * переживает. Значит после первого же перезапуска о покойнике некому сказать,
 * что он покойник: трекер о нём больше не знает, а обход ждёт события, которое
 * уже никогда не придёт. Бессмертный стоящий.
 *
 * Цена не в шуме: этот же список вот-вот поедет фаундеру карточкой с кнопкой
 * «разрешить». Карточка про сессию, которой нет, тратит нажатие впустую и учит
 * не читать карточки — то есть ломает ровно то, ради чего всё и строится.
 *
 * Поэтому обход судит о жизни САМ, по владельцу, записанному в момент отказа.
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test'
import { emit } from '../src/event-bus.js'
process.env.PROXY_BLOCKED_STATE_PATH = '/tmp/__test_blocked_liveness.json'
const { startLocalAlert, _setAlertDelivery, _setAliveProbe, _stuckState } =
  await import('../src/local-alert.js')

let stop: (() => void) | null = null
let fired: Array<{ subject: string; body: string; journalOnly: boolean }> = []
const HOUR = 60 * 60_000
const DAY = 24 * HOUR

/** Кто жив на этом прогоне — испытание решает само, а не спрашивает машину. */
let alive = new Set<number>()

function startWith(resolvePid: (sid: string) => number | null) {
  try { stop?.() } catch { /* ещё не поднимали */ }
  stop = startLocalAlert((sid) => ({ pid: resolvePid(sid), cwd: null }))
  _stuckState.clear()
}

/** Владелец целиком — номер процесса и его рабочий каталог. */
function startWithOwner(resolve: (sid: string) => { pid: number | null; cwd: string | null }) {
  try { stop?.() } catch { /* ещё не поднимали */ }
  stop = startLocalAlert(resolve)
  _stuckState.clear()
}

beforeEach(() => {
  try { require('node:fs').unlinkSync('/tmp/__test_blocked_liveness.json') } catch { /* нет — и хорошо */ }
  fired = []
  alive = new Set<number>()
  _stuckState.clear()
  _setAlertDelivery((subject, body, journalOnly) => { fired.push({ subject, body, journalOnly: !!journalOnly }) })
  _setAliveProbe((pid) => alive.has(pid))
  stop = startLocalAlert(() => ({ pid: null, cwd: null }))
  _stuckState.clear()
})
afterEach(() => {
  try { stop?.() } catch { /* already stopped */ }
  _setAlertDelivery(null)
  _setAliveProbe(null)
  _stuckState.clear()
})

function block(sessionId: string, streak = 2) {
  emit({
    level: 'error', kind: 'CACHE_REWRITE_BLOCKED', sessionId,
    rewriteClass: 'avoidable:ttl-expiry', spendKind: 'rewrite',
    predictedTokens: 437_582, consecutiveBlocks: streak,
  } as never)
}

describe('обход судит о жизни сам, не дожидаясь события', () => {
  test('владелец записан в момент отказа — иначе судить будет нечем после перезапуска', () => {
    startWith(() => 4242)
    block('s-pid')
    expect(_stuckState.get('s-pid')!.pid).toBe(4242)
  })

  test('владельца больше нет — снимается с учёта БЕЗ события SESSION_DEAD', () => {
    startWith(() => 4242)          // 4242 не в `alive` — то есть процесса нет
    block('s-gone')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    expect(_stuckState.get('s-gone')).toBeUndefined()
    expect(fired.filter(f => !f.journalOnly).length).toBe(0)   // человека не тревожим
  })

  test('снятие оставляет след в журнале — «перестало кричать» должно быть объяснимо', () => {
    startWith(() => 4242)
    block('s-trace')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    const trace = fired.find(f => f.journalOnly)
    expect(trace).toBeDefined()
    expect(trace!.body).toContain('s-trace')
    expect(trace!.body).toContain('4242')
  })

  test('владелец ЖИВ — напоминание звучит как прежде (контроль на противоположном)', () => {
    alive.add(777)
    startWith(() => 777)
    block('s-live')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    const loud = fired.filter(f => !f.journalOnly)
    expect(loud.length).toBe(1)
    expect(loud[0].subject).toContain('стоит у сторожа кэша уже')
    expect(_stuckState.get('s-live')).toBeDefined()
  })

  test('владелец не опознан — пока стучится, зовём, но ГОВОРИМ, что жизнь не проверена', () => {
    startWith(() => null)
    block('s-unknown')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    const loud = fired.filter(f => !f.journalOnly)
    expect(loud.length).toBe(1)
    expect(loud[0].body).toContain('жив ли её процесс, проверить нечем')
  })

  test('владелец не опознан и двое суток ни одной попытки — перестаём утверждать', () => {
    startWith(() => null)
    block('s-stale')
    const st = _stuckState.get('s-stale')!
    const t0 = Date.now()
    st.lastBlockAt = t0 - 3 * DAY
    fired = []
    _stuckState.sweep(t0 + 20 * 60_000)
    expect(_stuckState.get('s-stale')).toBeUndefined()
    expect(fired.filter(f => !f.journalOnly).length).toBe(0)
    expect(fired.find(f => f.journalOnly)!.body).toContain('s-stale')
  })

  test('потолок молчания НЕ трогает того, чей владелец жив: он стоит хоть неделю', () => {
    alive.add(999)
    startWith(() => 999)
    block('s-patient')
    const st = _stuckState.get('s-patient')!
    const t0 = Date.now()
    st.lastBlockAt = t0 - 7 * DAY
    st.since = t0 - 7 * DAY
    fired = []
    _stuckState.sweep(t0 + 20 * 60_000)
    expect(_stuckState.get('s-patient')).toBeDefined()
    expect(fired.filter(f => !f.journalOnly).length).toBe(1)
  })

  test('запись, поднятая с диска БЕЗ владельца, судится как неопознанная, а не как живая', () => {
    // Ровно те семь, что лежали в живом файле: они писались до того, как
    // владелец стал записываться, и «поля нет» не должно читаться как «жив».
    require('node:fs').writeFileSync('/tmp/__test_blocked_liveness.json', JSON.stringify({
      's-legacy': {
        since: Date.now() - 9 * DAY, lastBlockAt: Date.now() - 9 * DAY,
        announcedAt: 0, announcements: 11, reason: 'кэш остыл', tokens: 184_389,
      },
    }), 'utf8')
    try { stop?.() } catch { /* ещё не поднимали */ }
    stop = startLocalAlert(() => ({ pid: null, cwd: null }))   // поднимает состояние с диска
    expect(_stuckState.get('s-legacy')).toBeDefined()
    fired = []
    _stuckState.sweep(Date.now())
    expect(_stuckState.get('s-legacy')).toBeUndefined()
    expect(fired.filter(f => !f.journalOnly).length).toBe(0)
  })

  test('рабочий каталог владельца записывается рядом — карточке нужен ПРОЕКТ, а не голый номер', () => {
    alive.add(555)
    startWithOwner(() => ({ pid: 555, cwd: '/home/relishev/projects/vibe/photo3d' }))
    block('s-cwd')
    expect(_stuckState.get('s-cwd')!.cwd).toBe('/home/relishev/projects/vibe/photo3d')
  })

  test('и он же стоит в напоминании: «сессия abc» без проекта человеку ничего не говорит', () => {
    alive.add(555)
    startWithOwner(() => ({ pid: 555, cwd: '/home/relishev/projects/vibe/photo3d' }))
    block('s-cwd2')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    expect(fired.find(f => !f.journalOnly)!.body).toContain('/home/relishev/projects/vibe/photo3d')
  })

  test('каталога нет — напоминание не ломается и лишнего не выдумывает', () => {
    alive.add(555)
    startWithOwner(() => ({ pid: 555, cwd: null }))
    block('s-nocwd')
    fired = []
    _stuckState.sweep(Date.now() + 20 * 60_000)
    const b = fired.find(f => !f.journalOnly)!.body
    expect(b).toContain('s-nocwd')
    expect(b).not.toContain('undefined')
    expect(b).not.toContain('null')
  })
})
