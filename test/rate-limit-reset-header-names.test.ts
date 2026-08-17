/**
 * proxy-client — время сброса квоты приходит ПО ОКНАМ, и парсер спрашивал имя, которого нет.
 *
 * 🔴 ЗАМЕРЕНО 2026-08-17, а не выведено. Живой запрос через прокси вернул:
 *     anthropic-ratelimit-unified-5h-reset: 1786998000
 *     anthropic-ratelimit-unified-7d-reset: 1787508000
 *     anthropic-ratelimit-unified-5h-utilization: 0.93
 * Заголовка `anthropic-ratelimit-unified-reset` (без окна) в ответе НЕТ — и не было: собственный
 * лог этого же кода (`~/.claude/claude-max-headers.log`) показывает те же имена с окнами ещё от
 * 26 июля. Соседние чтения `utilization` суффикс окна учитывали, и только `reset` был написан без
 * него.
 *
 * Цена дефекта видна была всем и каждый день: `resetAt` оставался null навсегда, а критическое
 * сообщение прокси печаталось как «Reset in nullmin. STOP NEW WORK» — то есть механизм пытался
 * назвать время и выдавал пустоту. Фаундер спросил прямо: «5h квота показывает точно во сколько
 * времени она будет сброшена?»
 *
 * Тест держит ИМЕНА ЗАГОЛОВКОВ, потому что дефект был именно в имени: код выглядел правильным.
 */

import { describe, test, expect } from 'bun:test'

/** Ровно те заголовки, что вернул живой запрос (значения — оттуда же). */
function liveHeaders(): Headers {
  return new Headers({
    'anthropic-ratelimit-unified-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-status': 'allowed_warning',
    'anthropic-ratelimit-unified-5h-reset': '1786998000',
    'anthropic-ratelimit-unified-5h-utilization': '0.93',
    'anthropic-ratelimit-unified-7d-status': 'allowed',
    'anthropic-ratelimit-unified-7d-reset': '1787508000',
    'anthropic-ratelimit-unified-7d-utilization': '0.35',
    'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  })
}

/** Парсер живёт в модуле без экспорта, поэтому проверяется через его собственную семантику:
 * читаем те же имена тем же способом. Если правка уедет, эти утверждения останутся истинными о
 * реальности и ложными о коде — поэтому ниже стоит и проверка САМОГО модуля. */
describe('время сброса квоты читается по окнам, а не по имени без окна', () => {
  test('🔴 заголовок без окна в живом ответе ОТСУТСТВУЕТ', () => {
    const h = liveHeaders()
    expect(h.get('anthropic-ratelimit-unified-reset')).toBeNull()
    expect(h.get('anthropic-ratelimit-unified-5h-reset')).toBe('1786998000')
    expect(h.get('anthropic-ratelimit-unified-7d-reset')).toBe('1787508000')
  })

  test('пятичасовое и недельное окна — РАЗНЫЕ часы, одно число за оба стоять не может', () => {
    const fiveH = Number(liveHeaders().get('anthropic-ratelimit-unified-5h-reset'))
    const sevenD = Number(liveHeaders().get('anthropic-ratelimit-unified-7d-reset'))
    // Замер того же момента: 13 минут против 142 часов.
    expect(sevenD - fiveH).toBeGreaterThan(24 * 3600)
  })

  test('🔴 парсер отдаёт ОБА окна — это и есть провод, ради которого всё', async () => {
    // Функция экспортирована ради этой проверки: сторож, который не может дотянуться до провода,
    // сторожит только сам себя — а дефект был именно в проводе, при правильном на вид коде.
    const { parseRateLimitHeaders } = await import('../src/proxy-client.ts')
    const snap = parseRateLimitHeaders(liveHeaders())
    expect(snap.resetAt).toBe(1786998000)
    expect(snap.resetAt7d).toBe(1787508000)
  })

  test('старое имя всё ещё принимается, если однажды вернётся одно окно', async () => {
    const { parseRateLimitHeaders } = await import('../src/proxy-client.ts')
    const snap = parseRateLimitHeaders(new Headers({ 'anthropic-ratelimit-unified-reset': '1786998000' }))
    expect(snap.resetAt).toBe(1786998000)
  })
})
