/**
 * Дверь-справка о стоящей сессии — ТОЛЬКО ЧИТАЕТ.
 *
 * 🔴 ЗАЧЕМ ОНА ПОЯВИЛАСЬ, 19.09.2026. Владелец телеграм-службы принёс случай
 * фаундера: сессия соседа простояла у сторожа кэша десять с половиной часов, а
 * во всех приборах числилась ЖИВОЙ И ЗАНЯТОЙ. Механизм обмана простой: каждый
 * отбитый ход пишет в стенограмму запись, а свежесть записей и есть то, по чему
 * реестр судит о жизни. Стук в стену неотличим от работы для того, кто считает
 * только частоту. Дословно фаундер: «Почему агент показывает статус, что
 * работает… но если он заблокирован, он не может ничего дёргать».
 *
 * 🔴 И ПОЧЕМУ НЕЛЬЗЯ БЫЛО ОБОЙТИСЬ ТЕМ, ЧТО УЖЕ ЕСТЬ. Состояние у службы БЫЛО,
 * наружу выходило единственным путём — справкой при ВЫДАЧЕ согласия
 * (`/admin/cache-rewrite-ok`). То есть спросить «стоит ли он» было нельзя, не
 * разрешив заодно трату: вопрос был неотличим от ответа. Отсюда главное
 * требование к этой двери, закреплённое ниже испытанием: она не пишет НИЧЕГО.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { createAdminModule } from '../src/modules/admin.js'
import { _stuckState, stuckSessionReport, stuckSessionsAll } from '../src/local-alert.js'

/** Живой маршрут — из СОБРАННОГО модуля, то есть уже за гейтом control-auth. */
function route(path: string, method = 'GET') {
  const mod = createAdminModule(() => {})
  mod.init?.({
    config: { adminToken: null },
    proxyClient: {
      listSessions: () => [{ sessionId: 'живая-на-ходу' }],
      quotaHoldFor: (sid: string) => quotaAnswer(sid),
    },
  } as never)
  const r = (mod.routes ?? []).find((x: any) => x.path === path && x.method === method)
  if (!r) throw new Error(`маршрут ${method} ${path} не объявлен вовсе`)
  return r
}

/** Показание сторожа запаса подменяем: настоящий читает живой счёт аккаунта. */
let quotaAnswer: (sid: string) => unknown = () => ({
  holding: false, orgId: null, util5h: null, threshold: 0.95,
  resetAt: null, resetInSec: null, enabled: true,
})

function call(r: any, query = '') {
  return r.handler(
    new Request('http://127.0.0.1:5050' + r.path + query),
    { requestIP: () => ({ address: '127.0.0.1' }) },
  )
}

/** Поставить в учёт стоящую сессию — как это делает отказ сторожа кэша. */
function putStuck(sid: string, sinceMsAgo: number, tokens = 306345) {
  const now = Date.now()
  _stuckState.put(sid, {
    since: now - sinceMsAgo,
    lastBlockAt: now - 60_000,
    announcedAt: now - 60_000,
    announcements: 3,
    reason: 'перезапись мёртвого кэша',
    tokens,
    pid: null,
    idleMs: 6.3 * 3600_000,
    spendKind: 'rewrite',
    cwd: '/home/relishev/projects/vibe/yjs-todo-sync',
  } as never)
}

afterEach(() => {
  _stuckState.clear()
  quotaAnswer = () => ({
    holding: false, orgId: null, util5h: null, threshold: 0.95,
    resetAt: null, resetInSec: null, enabled: true,
  })
})

describe('справка о стоящей сессии', () => {
  test('дверь объявлена ИМЕННО как GET — читающий не должен слать POST в дверь согласия', () => {
    expect(() => route('/admin/stuck-session', 'GET')).not.toThrow()
    expect(() => route('/admin/stuck-sessions', 'GET')).not.toThrow()
  })

  test('стоящая названа стоящей, и названо ЧЕМ и СКОЛЬКО', async () => {
    putStuck('9f11dcf4', 10.5 * 3600_000)
    const res = await call(route('/admin/stuck-session'), '?sessionId=9f11dcf4')
    const j = await res.json() as any
    expect(j.stuck).toBe(true)
    expect(j.guard).toBe('cache')
    expect(j.stuckForSec).toBeGreaterThan(10 * 3600)
    expect(j.tokens).toBe(306345)
    expect(j.known).toBe(true)
  })

  test('🔴 СПРАВКА НИЧЕГО НЕ МЕНЯЕТ: спросили — учёт тот же, что был', async () => {
    putStuck('9f11dcf4', 3600_000)
    const before = JSON.stringify(_stuckState.get('9f11dcf4'))
    await call(route('/admin/stuck-session'), '?sessionId=9f11dcf4')
    await call(route('/admin/stuck-sessions'))
    expect(JSON.stringify(_stuckState.get('9f11dcf4'))).toBe(before)
    expect(_stuckState.size()).toBe(1)
  })

  test('🔴 ПРИДЕРЖАННУЮ ЗАПАСОМ ТОЖЕ ВИДНО — иначе дверь врёт в половине случаев', async () => {
    // Учёт стоящих про неё не знает НИЧЕГО: сторож запаса держит по аккаунту.
    quotaAnswer = () => ({
      holding: true, orgId: 'f9420373-0aff', util5h: 0.98, threshold: 0.95,
      resetAt: Math.round(Date.now() / 1000) + 2400, resetInSec: 2400, enabled: true,
    })
    const res = await call(route('/admin/stuck-session'), '?sessionId=кто-то-на-исчерпанном')
    const j = await res.json() as any
    expect(j.stuck).toBe(true)
    expect(j.guard).toBe('quota')
    expect(j.quota.resetInSec).toBe(2400)
    // и человеку сказано ГЛАВНОЕ: кэш жив, надо ждать, а не перезапускать
    expect(j.note).toContain('кэш при этом жив')
  })

  test('сторож кэша сильнее запаса: он УЖЕ отбил ход, а запас только отобьёт', async () => {
    putStuck('обе-беды', 7200_000)
    quotaAnswer = () => ({
      holding: true, orgId: 'f9420373-0aff', util5h: 0.99, threshold: 0.95,
      resetAt: null, resetInSec: null, enabled: true,
    })
    const j = await (await call(route('/admin/stuck-session'), '?sessionId=обе-беды')).json() as any
    expect(j.guard).toBe('cache')
    expect(j.quota.holding).toBe(true)   // вторая беда не потеряна, просто не главная
  })

  test('🔴 «НЕ СТОИТ» И «НЕ ЗНАЮ» — РАЗНЫЕ ОТВЕТЫ: молчание прибора не есть здоровье', async () => {
    const живая = await (await call(route('/admin/stuck-session'), '?sessionId=живая-на-ходу')).json() as any
    expect(живая.stuck).toBe(false)
    expect(живая.known).toBe(true)

    const чужая = await (await call(route('/admin/stuck-session'), '?sessionId=никогда-не-видели')).json() as any
    expect(чужая.stuck).toBe(false)
    expect(чужая.known).toBe(false)
    expect(чужая.note).toContain('не известно ничего')
  })

  test('без номера сессии — отказ ВСЛУХ, а не пустая справка', async () => {
    const res = await call(route('/admin/stuck-session'))
    expect(res.status).toBe(400)
  })

  test('список всех стоящих — старейшая первой, чтобы человек начал с худшей', () => {
    putStuck('час', 3600_000)
    putStuck('сутки', 24 * 3600_000)
    putStuck('минута', 60_000)
    const all = stuckSessionsAll()
    expect(all.map(r => r.sessionId)).toEqual(['сутки', 'час', 'минута'])
  })

  test('владелец не опознан → liveness=unknown, а НЕ «наверное, жив»', () => {
    putStuck('безхозная', 3600_000)
    expect(stuckSessionReport('безхозная')!.liveness).toBe('unknown')
  })

  test('совет даётся только когда есть чем обосновать — иначе его нет вовсе', () => {
    putStuck('со-сроком', 3600_000)
    expect(stuckSessionReport('со-сроком')!.advice).not.toBeNull()

    _stuckState.put('без-срока', {
      since: Date.now() - 3600_000, lastBlockAt: Date.now(), announcedAt: Date.now(),
      announcements: 1, reason: 'перезапись', tokens: 1000, pid: null,
      idleMs: null, spendKind: null, cwd: null,
    } as never)
    expect(stuckSessionReport('без-срока')!.advice).toBeNull()
  })

  test('нет такой в учёте → отчёт null, а не пустой объект, который сойдёт за ответ', () => {
    expect(stuckSessionReport('нет-такой')).toBeNull()
  })
})
