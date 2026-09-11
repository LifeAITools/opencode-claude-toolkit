/**
 * Дверь согласия сторожа кэша — вторая половина пары к `/admin/quota-ok`.
 *
 * 🔴 ЗАЧЕМ ОНА ПОЯВИЛАСЬ, 11.09.2026. Владелец роутера побудок строит
 * исполнителя для нажатия фаундера на кнопке «разрешить» и попросил у меня три
 * вещи: адрес двери, заголовок и тело. Двери НЕ БЫЛО ВОВСЕ: согласие сторожа
 * кэша до сих пор клала только команда `context cache-rewrite-ok`, живущая в
 * чужом репозитории. То есть исполнителю пришлось бы звать чужой CLI и зависеть
 * от его наличия в пути — там, где мне достаточно отдать свою дверь.
 *
 * 🔴 И ГЛАВНОЕ ТРЕБОВАНИЕ К НЕЙ — ПАРИТЕТ СО СТАРЫМ ПУТЁМ. Два пути к одному
 * согласию, дающие РАЗНЫЙ срок, — это способ получить беду, которую никто не
 * воспроизведёт: человек набрал команду, всё сработало; нажал кнопку — сработало
 * иначе. Поэтому сроки здесь списаны с команды: 180 секунд по умолчанию и год
 * при «до исполнения» (`_UNTIL_CONSUMED_MS` в cli.py:993).
 *
 * 🔴 ПОЧЕМУ ЗДЕСЬ НЕТ НИ ОДНОЙ ПРОВЕРКИ ПО ФАЙЛУ, ХОТЯ ДВЕРЬ ПИШЕТ ФАЙЛ.
 * Первая редакция подменяла путь к настройкам через переменную окружения — и
 * была ЗЕЛЁНОЙ в одиночку, но падала в общем прогоне: путь к файлу настроек
 * берётся один раз при загрузке модуля, а в общем прогоне модуль успевает
 * загрузить кто-то раньше. То есть проверка зависела от порядка файлов, а
 * «зелено у меня» значило бы «писало в ЖИВОЙ склад согласий машины». Поэтому
 * здесь проверяется только то, что дверь ГОВОРИТ, а куда она кладёт — доказано
 * живой пробой по выкаченной службе (см. расписку в журнале смены 11.09).
 */

import { describe, test, expect } from 'bun:test'
import { createAdminModule, resolveRewriteConsentTtlSec } from '../src/modules/admin.js'
import { loadKeepaliveConfig } from '@life-ai-tools/claude-code-sdk'

const YEAR_SEC = 365 * 24 * 60 * 60

/** Живой маршрут двери — берётся из СОБРАННОГО модуля, то есть уже за гейтом
 *  control-auth, ровно как его получает сервер. Без `init` модуль не знает про
 *  свой контекст, и гейт упал бы на нём раньше, чем на самом деле. */
function route(path: string, method = 'POST') {
  const mod = createAdminModule(() => {})
  mod.init?.({ config: { adminToken: null } } as never)
  const r = (mod.routes ?? []).find((x: any) => x.path === path && x.method === method)
  if (!r) throw new Error(`маршрут ${method} ${path} не объявлен вовсе`)
  return r
}

/** Запрос с петли: control-auth пропускает своих без всякого секрета. */
function call(r: any, body: unknown) {
  return r.handler(
    new Request('http://127.0.0.1:5050' + r.path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { requestIP: () => ({ address: '127.0.0.1' }) },
  )
}

describe('дверь согласия сторожа кэша', () => {
  test('дверь вообще объявлена — исполнителю нажатия есть куда стучаться', () => {
    expect(() => route('/admin/cache-rewrite-ok')).not.toThrow()
  })

  test('склады двух сторожей РАЗНЫЕ — грант одного не годится другому', () => {
    const cfg = loadKeepaliveConfig()
    expect(cfg.rewriteGuard.consentGrantPath).not.toBe(cfg.quotaGuard.consentGrantPath)
  })

  test('по умолчанию срок тот же, что у команды — 180 секунд, а не свой', () => {
    expect(resolveRewriteConsentTtlSec({}, 180)).toBe(180)
  })

  test('«до исполнения» — год, ровно как пишет команда (cli.py:993)', () => {
    expect(resolveRewriteConsentTtlSec({ untilConsumed: true }, 180)).toBe(YEAR_SEC)
    // и оно сильнее явного срока: нажавший «до исполнения» просил именно это
    expect(resolveRewriteConsentTtlSec({ untilConsumed: true, ttlSec: 5 }, 180)).toBe(YEAR_SEC)
  })

  test('срок можно назвать явно, но не бесконечный', () => {
    expect(resolveRewriteConsentTtlSec({ ttlSec: 600 }, 180)).toBe(600)
    expect(resolveRewriteConsentTtlSec({ ttlSec: 99 * YEAR_SEC }, 180)).toBe(YEAR_SEC)
    expect(resolveRewriteConsentTtlSec({ ttlSec: 0 }, 180)).toBe(180)      // ноль — не срок
    expect(resolveRewriteConsentTtlSec({ ttlSec: -5 }, 180)).toBe(180)
  })

  test('без номера сессии — отказ ВСЛУХ, а не тихое «принято»', async () => {
    const res = await call(route('/admin/cache-rewrite-ok'), {})
    expect(res.status).toBe(400)
  })

  test('чужой, не с петли, без секрета НЕ пройдёт — дверь пишет согласие', async () => {
    const r = route('/admin/cache-rewrite-ok')
    const res = await r.handler(
      new Request('http://10.0.0.7:5050' + r.path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'sid-remote' }),
      }),
      { requestIP: () => ({ address: '10.0.0.7' }) },
    )
    expect(res.status).toBe(401)
  })
})
