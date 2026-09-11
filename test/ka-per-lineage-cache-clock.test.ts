/**
 * ОДНИ ЧАСЫ НА ВСЕ СНИМКИ — ИМЕННО ЭТО ОТКРЫВАЛО ВОРОТА ПЕРЕД МЁРТВЫМ КЭШЕМ.
 *
 * Ворота «не стрелять по мёртвому префиксу» (keepalive-engine, gate
 * `cache_dead_at_fire_gate`) существуют с 19.08.2026 и меряют возраст кэша
 * ОДНИМ полем на весь движок — `cacheWrittenAt`. А регистр держит НЕСКОЛЬКО
 * веток, у каждой свой кэш и свой срок: замер 11.09.2026 — 5–7 родословных на
 * сессию (518359ff и 316f5fca по 7, bac675cc 6).
 *
 * Любой настоящий ход по ЛЮБОЙ ветке переводил общие часы на «сейчас», и
 * ворота открывались для ВСЕХ веток разом — включая те, чей кэш умер час
 * назад. Выстрел по такой ветке не освежает ничего: он ПОКУПАЕТ префикс
 * заново.
 *
 * ЦЕНА, ЗАМЕРЕННАЯ 11.09.2026 ЗА ОДНО УТРО: 29 таких покупок, 3 347 852
 * токена записи, крупнейшая одиночная 431 290. ВСЕ 29 — первый выстрел по
 * ветке, и в 25 случаях из 29 по этой ветке больше не стреляли ни разу, то
 * есть купленное никто не прочитал. По курсу 493 672 токена записи на один
 * пункт пятичасового окна это ~6.8 пункта, выброшенных впустую; в то же утро
 * окно упёрлось в потолок и Anthropic час отбивал прогрев всего флота.
 *
 * Примета, по которой дыру было видно и раньше: за те же сутки ворота
 * сработали 9 раз, и все 9 — внутри тестов. На живой службе ни разу.
 *
 * ТРЕБОВАНИЕ ФАУНДЕРА (голосом 11.09.2026, дословно): «У каждого снимка
 * должен быть абсолютно свой таймер и своё время. В общем, не просто таймер,
 * а именно время, от которого отсчитываем, чтобы таймер не промахнулся, не
 * сбросился, не забылся».
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

/** Тело со своим маркером — разный текст даёт разную родословную. */
const body = (tag: string) => ({
  system: [{ type: 'text', text: `sys-${tag}`, cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

/** Выстрел, который отвечает как ПОКУПКА мёртвого префикса. */
function buyingFetch(seen: { keys: string[] }) {
  return async function* (b: Record<string, unknown>): AsyncGenerator<StreamEvent> {
    const sys = (b as any)?.system?.[0]?.text ?? '?'
    seen.keys.push(String(sys))
    yield {
      type: 'message_stop',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 300_000 },
      stopReason: 'end_turn',
    } as any
  }
}

const rl: RateLimitInfo = {
  status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0,
}

function mkEngine(seen: { keys: string[] }) {
  return new KeepaliveEngine({
    config: { cacheTtlMs: 3_600_000, intervalMs: 60_000 },
    getToken: async () => 'tok',
    doFetch: buyingFetch(seen) as any,
    getRateLimitInfo: () => rl,
  })
}

/** Регистрирует одну ветку и возвращает её ключ. */
function arm(e: KeepaliveEngine, tag: string): string {
  const key = e.notifyRealRequestStart('claude-opus-5', body(tag) as any, {})
  e.notifyRealRequestComplete(
    { inputTokens: 200_000, outputTokens: 10, cacheReadInputTokens: 0 } as any,
    key,
  )
  e._setLineageRole(key, 'main')
  return key
}

describe('у каждого снимка своё время, от которого считают его срок', () => {
  test('ветка, чей кэш умер, НЕ обстреливается — даже когда соседняя только что грелась', async () => {
    // Ровно та связка, что жгла квоту: одна ветка свежая, вторая давно мертва.
    // Общие часы показывают свежесть первой и пропускают выстрел по второй.
    const seen = { keys: [] as string[] }
    const e = mkEngine(seen)

    const stale = arm(e, 'stale')
    e._setLineageCacheWrittenAt(stale, Date.now() - 3_600_000 - 60_000) // час с лишним назад — мёртв
    const fresh = arm(e, 'fresh')
    e._setLineageCacheWrittenAt(fresh, Date.now() - 120_000)            // две минуты назад — жив

    // Обе ветки «простаивают» достаточно, чтобы попасть под выстрел.
    e._ageLineages(3_600_000)
    await e._tick()

    expect(seen.keys).toContain('sys-fresh')      // живую греем — она бесплатна
    expect(seen.keys).not.toContain('sys-stale')  // СУТЬ: за мёртвую не платим
    e.stop()
  })

  test('мёртвая ветка не глушит прогрев всей сессии — снимается только она', async () => {
    // Прежние ворота на срабатывании звали clearRegistry() + stop(), то есть
    // гасили движок целиком. При поветочной проверке это означало бы, что одна
    // забытая ветка лишает тепла все остальные кэши сессии — цена, ради
    // избежания которой ворота и ставились.
    const seen = { keys: [] as string[] }
    const e = mkEngine(seen)

    const stale = arm(e, 'stale')
    e._setLineageCacheWrittenAt(stale, Date.now() - 3_600_000 - 60_000)
    const fresh = arm(e, 'fresh')
    e._setLineageCacheWrittenAt(fresh, Date.now() - 120_000)

    e._ageLineages(3_600_000)
    await e._tick()

    // Мёртвая ушла из регистра, живая осталась и продолжает греться.
    const keys = Array.from(e._registry.keys())
    expect(keys).not.toContain(stale)
    expect(keys).toContain(fresh)
    e.stop()
  })

  test('своё время ветки переживает чужой ход — общие часы его больше не обнуляют', async () => {
    // Требование фаундера дословно: «чтобы таймер не промахнулся, не сбросился,
    // не забылся». Ход по СОСЕДНЕЙ ветке не смеет молодить мёртвую.
    const seen = { keys: [] as string[] }
    const e = mkEngine(seen)

    const stale = arm(e, 'stale')
    e._setLineageCacheWrittenAt(stale, Date.now() - 3_600_000 - 60_000)

    // Настоящий ход по другой ветке — он обновляет общие часы движка.
    arm(e, 'fresh')

    e._ageLineages(3_600_000)
    await e._tick()

    expect(seen.keys).not.toContain('sys-stale')  // чужая свежесть её не воскресила
    e.stop()
  })
})
