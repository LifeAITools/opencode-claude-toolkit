/**
 * ПРОГОН ИСПЫТАНИЙ НЕ БУДИТ ЖИВОГО ЧЕЛОВЕКА.
 *
 * 🔴 ЦЕНА, ЗАПЛАЧЕННАЯ ЗА ЭТО ИСПЫТАНИЕ, 19.09.2026. Владелец телеграм-службы
 * написал «стоп»: за две минуты в живую комнату фаундера пришло СЕМЬ настоящих
 * карточек с рабочими кнопками — s-unknown, s-live, s-trace, s-stale,
 * s-patient, s-known, s-freed. Это имена сессий из
 * `local-alert-stuck-liveness.test.ts`. Оно честно подменяло доставку тревоги
 * (`_setAlertDelivery`), но про дверь карточки не знало вовсе — и каждый мой
 * прогон набора стучался к человеку всерьёз. Нажми он «разрешить» — вердикт
 * ушёл бы по сессии, которой никогда не было.
 *
 * 🔴 И ГЛАВНОЕ — ПОЧЕМУ СТАРОГО ШВА БЫЛО МАЛО. Шов `_setCardSender` существовал
 * с самого начала, и он правильный. Но он требовал, чтобы КАЖДЫЙ новый файл
 * испытаний про него помнил, — то есть держался на дисциплине, а не на
 * построении. Дисциплина отказала на первом же файле, который писал не про
 * карточку. Поэтому замок переехал внутрь самой двери, а это испытание стоит
 * сторожем над замком: снимешь его — покраснеет здесь, а не в чужой комнате.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { raiseStuckCard, _setCardSender, type StuckCardAsk } from '../src/surface-card.js'

const ask: StuckCardAsk = {
  sessionId: 's-проба',
  guard: 'cache',
  reason: 'перезапись мёртвого кэша',
  stuckForSec: 3600,
}

afterEach(() => { _setCardSender(null); delete process.env.PROXY_SURFACE_CARD })

describe('дверь карточки под испытаниями', () => {
  test('🔴 БЕЗ ШВА В ПРОГОНЕ ИСПЫТАНИЙ ДВЕРЬ НЕ ЗОВЁТСЯ ВОВСЕ', async () => {
    // Именно так её звал `local-alert-stuck-liveness.test.ts` — не зная о ней.
    const r = await raiseStuckCard(ask)
    expect(r.raised).toBe(false)
    expect(r.reason).toContain('прогон испытаний')
    // и причина НАЗЫВАЕТ выход, чтобы следующий не искал его по коду
    expect(r.reason).toContain('_setCardSender')
  })

  test('этот прогон и правда помечен тестовым — иначе замок не про что', () => {
    expect(process.env.NODE_ENV).toBe('test')
  })

  test('кто проверяет саму отправку — ставит шов и проходит', async () => {
    let увидено: StuckCardAsk | null = null
    _setCardSender(async (a) => { увидено = a; return { raised: true, interactionUuid: 'u-1' } })
    const r = await raiseStuckCard(ask)
    expect(r.raised).toBe(true)
    expect(увидено!.sessionId).toBe('s-проба')
  })

  test('🔴 ЗАМОК НЕСНИМАЕМ ПЕРЕМЕННОЙ — одна забытая уборка открывала его всем', async () => {
    // Так он и протёк в первой редакции: испытание сняло замок ради проверки
    // секрета и не вернуло переменную — дальше весь прогон стучался в живую
    // комнату по НАСТОЯЩИМ номерам сессий из рабочего учёта машины.
    process.env.PROXY_SURFACE_CARD = '1'
    const r = await raiseStuckCard({ ...ask, sessionId: 's-нарочно' })
    expect(r.raised).toBe(false)
    expect(r.reason).toContain('прогон испытаний')
  })

  test('выключатель СТРОЖЕ замка и стоит раньше него — «0» гасит дверь всегда', async () => {
    // Порядок не косметика: «0» — это решение человека выключить дверь совсем,
    // и оно не должно тонуть в служебной причине про прогон испытаний.
    process.env.PROXY_SURFACE_CARD = '0'
    const r = await raiseStuckCard(ask)
    expect(r.raised).toBe(false)
    expect(r.reason).toContain('выключена')
  })
})
