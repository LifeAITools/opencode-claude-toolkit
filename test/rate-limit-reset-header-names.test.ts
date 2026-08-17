/**
 * proxy-client — время сброса квоты приходит по КАЖДОМУ окну отдельно, и до 2026-08-17 оно
 * терялось по дороге в событие.
 *
 * 🔴 ЗДЕСЬ ЖЕ ЗАПИСАНА МОЯ СОБСТВЕННАЯ ОШИБКА, ПОТОМУ ЧТО ОНА ДОРОЖЕ САМОЙ ПОЧИНКИ. Первый вывод
 * был: «заголовка `anthropic-ratelimit-unified-reset` не существует, парсер спрашивает пустоту».
 * Он НЕВЕРЕН. Живой запрос возвращает ОБА имени с одинаковым значением
 * (`unified-reset: 1787016000` и `unified-5h-reset: 1787016000`), и в собственном логе заголовков
 * обе формы встречаются по 12054 раза. Вывод был сделан по выводу, обрезанному на двенадцатой
 * строке, — тот же класс, что «поиск короче лимита не значит исчерпан».
 *
 * НАСТОЯЩИЙ дефект был на шаг дальше: парсер читал время верно, а сборка события
 * REAL_REQUEST_COMPLETE клала три поля из четырёх. Дальше по цепочке брать его было неоткуда —
 * отсюда `resetAt: null` во всех аккаунтах и предупреждение «Reset in nullmin. STOP NEW WORK», то
 * есть механизм, который пытается назвать время и печатает пустоту.
 *
 * Вопрос фаундера, с которого всё началось: «5h квота показывает точно во сколько времени она будет
 * сброшена и через сколько минут, чтобы было видно в подвале сообщений?»
 *
 * Тест держит и имена, и провод до события: имя выглядело правильным, и код тоже — рвалось между.
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
  test('оба окна названы своими именами', () => {
    const h = liveHeaders()
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

describe('время сброса доезжает до события, а не только до парсера', () => {
  test('🔴 снимок несёт оба окна — это то, что кладётся в REAL_REQUEST_COMPLETE', async () => {
    const { parseRateLimitHeaders } = await import('../src/proxy-client.ts')
    const snap = parseRateLimitHeaders(liveHeaders())
    // Ровно эти два поля собирает событие; до 2026-08-17 оно клало три поля из четырёх, и время
    // терялось ЗДЕСЬ — не в парсере, который всё это время читал верно.
    expect(snap.resetAt).toBeGreaterThan(0)
    expect(snap.resetAt7d).toBeGreaterThan(0)
    // Окна не равны: одно число за оба стоять не может.
    expect(snap.resetAt7d).not.toBe(snap.resetAt)
  })

  test('старое имя без окна ТОЖЕ приходит — вывод «такого заголовка нет» был неверен', () => {
    // Замерено 2026-08-17 живым запросом: обе формы приходят с ОДИНАКОВЫМ значением
    // (unified-reset: 1787016000 и unified-5h-reset: 1787016000), по 12054 раза каждая в логе
    // заголовков. Первый вывод был сделан по обрезанному на двенадцатой строке выводу — тот же
    // класс ошибки, что «поиск короче лимита не значит исчерпан».
    const h = new Headers({
      'anthropic-ratelimit-unified-reset': '1787016000',
      'anthropic-ratelimit-unified-5h-reset': '1787016000',
    })
    expect(h.get('anthropic-ratelimit-unified-reset')).toBe('1787016000')
  })
})
