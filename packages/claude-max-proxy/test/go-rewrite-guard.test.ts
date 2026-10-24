/**
 * Сторож переписи двери Go.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 23.10): перепись префикса — 2.8% токенов входа, и 92% из них
 * «промпт вырос, а кэша нет». Нужен сторож, который ОСТАНАВЛИВАЕТ такую перепись, когда
 * кэш ещё жив, и называет МЕСТО расхождения — чтобы было видно, кто и что поменял.
 *
 * 🔴 ВТОРОЕ, НЕ МЕНЕЕ ВАЖНОЕ: различать «движок сломал кэш» и «кэш истёк по времени».
 * Истёкший кэш — холодная запись, виноватых нет; перепись при живом кэше — вина
 * отправителя. Без этого различия прибор превращается в генератор ложных обвинений.
 *
 * Здесь проверяется РЕШЕНИЕ, а не живой трафик: двери сейчас почти никто не зовёт,
 * поэтому испытания — единственная проверка поведения.
 */

import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantConsent, consumeConsent } from '@life-ai-tools/claude-code-sdk'
import {
  analyse,
  assessPrefix,
  commitPrefix,
  hasMarkerInLastUserMessage,
  rewrittenTokens,
  shouldAutoRevert,
  shouldBlockRewrite,
  type PrefixAnalysis,
} from '../src/modules/go-door.js'

const m = (t: string) => ({ role: 'user', content: t })
const session = () => `ses_${Math.random().toString(36).slice(2)}`

describe('assessPrefix — чтение без записи', () => {
  test('два вызова подряд дают один ответ и НЕ сдвигают состояние', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b')] }, { now: 1 })
    const body = { messages: [m('a'), m('b'), m('c')] }
    expect(assessPrefix(s, body, { now: 2 }).verdict).toBe('append')
    expect(assessPrefix(s, body, { now: 3 }).verdict).toBe('append')
    // Если бы assess писал, второй вызов уже не был бы append. И commit всё ещё
    // сравнивает с ПЕРВОЙ записью, а не с телом, которое только что прочли.
    expect(commitPrefix(s, body, { now: 4 }).verdict).toBe('append')
  })

  test('assess на новой сессии говорит first, но ничего не заводит', () => {
    const s = session()
    expect(assessPrefix(s, { messages: [m('a')] }, { now: 1 }).verdict).toBe('first')
    // Первый commit для этой сессии всё ещё видит пустую память — и тоже first.
    expect(commitPrefix(s, { messages: [m('a')] }, { now: 2 }).verdict).toBe('first')
  })
})

describe('commitPrefix — прежнее поведение analyse', () => {
  test('first → append → rewrite', () => {
    const s = session()
    expect(commitPrefix(s, { messages: [m('a'), m('b')] }, { now: 1 }).verdict).toBe('first')
    expect(commitPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 2 }).verdict).toBe('append')
    expect(commitPrefix(s, { messages: [m('ИЗМЕНЕНО'), m('b'), m('c'), m('d')] }, { now: 3 }).verdict)
      .toBe('rewrite')
  })

  test('analyse остаётся псевдонимом commitPrefix', () => {
    const s = session()
    analyse(s, { messages: [m('a'), m('b')] }, 1)
    expect(analyse(s, { messages: [m('a'), m('b'), m('c')] }, 2).verdict).toBe('append')
  })
})

describe('idleMs — сколько прошло с прошлого вызова', () => {
  test('растёт вместе с now', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b')] }, { now: 1_000 })
    const a = assessPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 61_000 })
    const b = assessPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 121_000 })
    expect(a.idleMs).toBe(60_000)
    expect(b.idleMs).toBe(120_000)
  })
})

describe('avoidableRewrite — живой кэш против истёкшего', () => {
  const ttl = 60_000
  test('перепись при малом простое и тех же tools — avoidable', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 0 })
    const a = assessPrefix(s, { messages: [m('X'), m('b'), m('c'), m('d')] }, { now: 10_000, cacheTtlMs: ttl })
    expect(a.verdict).toBe('rewrite')
    expect(a.avoidableRewrite).toBe(true)
    expect(a.cacheTtlMs).toBe(ttl)
  })

  test('простой ≥ TTL — холодная запись, не avoidable', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 0 })
    const a = assessPrefix(s, { messages: [m('X'), m('b'), m('c'), m('d')] }, { now: 60_000, cacheTtlMs: ttl })
    expect(a.verdict).toBe('rewrite')
    expect(a.avoidableRewrite).toBe(false)
  })

  test('сменились tools — не avoidable, даже при малом простое', () => {
    const s = session()
    commitPrefix(s, { tools: [{ name: 'a' }], messages: [m('a'), m('b'), m('c')] }, { now: 0 })
    const a = assessPrefix(s, {
      tools: [{ name: 'a' }, { name: 'b' }],
      messages: [m('X'), m('b'), m('c'), m('d')],
    }, { now: 1_000, cacheTtlMs: ttl })
    expect(a.verdict).toBe('rewrite')
    expect(a.toolsChanged).toBe(true)
    expect(a.avoidableRewrite).toBe(false)
  })
})

describe('shouldBlockRewrite — матрица условий', () => {
  const avoidable: PrefixAnalysis = {
    verdict: 'rewrite', avoidableRewrite: true, idleMs: 1_000, cacheTtlMs: 2_700_000, toolsChanged: false,
  }
  const base = { enabled: true, analysis: avoidable, predictedTokens: 60_000, minTokens: 50_000, consented: false }

  test('все условия сходятся — блокировать', () => {
    expect(shouldBlockRewrite(base)).toBe(true)
  })
  test('выключен — не блокировать', () => {
    expect(shouldBlockRewrite({ ...base, enabled: false })).toBe(false)
  })
  test('перепись не avoidable — не блокировать', () => {
    expect(shouldBlockRewrite({ ...base, analysis: { ...avoidable, avoidableRewrite: false } })).toBe(false)
  })
  test('ниже порога — не блокировать', () => {
    expect(shouldBlockRewrite({ ...base, predictedTokens: 49_999 })).toBe(false)
  })
  test('согласие есть — не блокировать', () => {
    expect(shouldBlockRewrite({ ...base, consented: true })).toBe(false)
  })
  test('ровно порог — блокировать (>=, а не >)', () => {
    expect(shouldBlockRewrite({ ...base, predictedTokens: 50_000 })).toBe(true)
  })
})

describe('hasMarkerInLastUserMessage — согласие меткой', () => {
  const marker = '[%cache-rewrite-ok%]'
  test('строка в content', () => {
    const body = { messages: [m('hi'), { role: 'assistant', content: 'ok' }, m(`${marker} continue`)] }
    expect(hasMarkerInLastUserMessage(body, marker)).toBe(true)
  })
  test('массив частей: text и input_text', () => {
    expect(hasMarkerInLastUserMessage({
      messages: [
        m('hi'),
        { role: 'user', content: [{ type: 'text', text: marker }, { type: 'text', text: ' go' }] },
      ],
    }, marker)).toBe(true)
    expect(hasMarkerInLastUserMessage({
      messages: [{ role: 'user', content: [{ type: 'input_text', input_text: marker }] }],
    }, marker)).toBe(true)
  })
  test('без сообщений пользователя — false, не бросает', () => {
    expect(hasMarkerInLastUserMessage({ messages: [{ role: 'assistant', content: marker }] }, marker)).toBe(false)
    expect(hasMarkerInLastUserMessage({}, marker)).toBe(false)
    expect(hasMarkerInLastUserMessage(null, marker)).toBe(false)
  })
})

describe('consent-пропуск из SDK — одноразовый', () => {
  test('grant → consume true → consume false', () => {
    const path = join(tmpdir(), `go-rewrite-grant-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
    const s = session()
    grantConsent(path, s, 180_000)
    expect(consumeConsent(path, s)).toBe(true)
    expect(consumeConsent(path, s)).toBe(false)
  })
})


describe('rewrittenTokens — сколько КЭША перепишется, а не сколько весит запрос', () => {
  // 🔴 Слово фаундера 24.10: «проверяет байт-идентичность слепка и того, что агент шлёт, чтобы
  // детектировать, СКОЛЬКО КЭША перепишется». До этой правки порог считался по всему телу: у
  // сессии на 300k токенов правка первой строки давала «~300k» и упиралась в порог, хотя
  // переписывается только хвост.
  const big = (t: string) => ({ role: 'user', content: t.repeat(400) })

  test('расхождение в начале — считаем хвост, а не всю историю', () => {
    const msgs = [big('a'), big('b'), big('c'), big('d')]
    const parsed = { messages: msgs, tools: [] }
    const whole = Math.round(JSON.stringify(parsed).length / 4)
    const tail = rewrittenTokens(parsed, { verdict: 'rewrite', firstDiffIndex: 2 } as PrefixAnalysis)
    expect(tail).toBeGreaterThan(0)
    // Хвост заметно меньше целого — именно на этом порог и должен срабатывать.
    expect(tail).toBeLessThan(whole / 2)
  })

  test('сменился набор инструментов — переписывается всё, префикс новый', () => {
    const parsed = { messages: [big('a'), big('b')], tools: [{ name: 'x' }] }
    const whole = Math.round(JSON.stringify(parsed).length / 4)
    expect(rewrittenTokens(parsed, { verdict: 'rewrite', firstDiffIndex: 1, toolsChanged: true } as PrefixAnalysis)).toBe(whole)
  })

  test('место расхождения неизвестно — не преуменьшаем убыток', () => {
    const parsed = { messages: [big('a')], tools: [] }
    const whole = Math.round(JSON.stringify(parsed).length / 4)
    expect(rewrittenTokens(parsed, { verdict: 'unknown' } as PrefixAnalysis)).toBe(whole)
  })
})

describe('холодная перепись и АВТО-ОТКАТ', () => {
  // 🔴 Слово фаундера 24.10.2026: «включай, если готово, но с автоматическим откатом, если всё
  // поплывёт и все агенты не смогут общаться, чтобы через минуту откатилось обратно».
  const warm = (over: Partial<PrefixAnalysis> = {}): PrefixAnalysis =>
    ({ verdict: 'rewrite', avoidableRewrite: true, cacheExpired: false, ...over })
  const cold = (over: Partial<PrefixAnalysis> = {}): PrefixAnalysis =>
    ({ verdict: 'rewrite', avoidableRewrite: false, cacheExpired: true, ...over })

  test('холодная перепись НЕ блокируется, пока второй ключ выключен', () => {
    expect(shouldBlockRewrite({ enabled: true, analysis: cold(), predictedTokens: 10_000_000, minTokens: 50_000, consented: false })).toBe(false)
  })

  test('дорогая запись блокируется только своим ключом', () => {
    expect(shouldBlockRewrite({ enabled: true, coldEnabled: true, analysis: cold(), predictedTokens: 90_000, minTokens: 50_000, consented: false })).toBe(true)
  })

  // 🔴 Колено (20 мин) — ДРУГОЕ число, чем срок жизни кэша (45 мин): кэш может быть ещё жив,
  // а запись уже стоит как холодный старт. Вызывающий говорит это полем `coldRewrite`.
  test('кэш ещё жив, но перепись после колена — блокируется холодным ключом', () => {
    const warmButLate = { verdict: 'rewrite' as const, avoidableRewrite: true, cacheExpired: false }
    expect(shouldBlockRewrite({ enabled: false, coldEnabled: true, coldRewrite: true, analysis: warmButLate, predictedTokens: 90_000, minTokens: 50_000, consented: false })).toBe(true)
  })

  test('до колена та же перепись холодным ключом не блокируется', () => {
    const warmEarly = { verdict: 'rewrite' as const, avoidableRewrite: true, cacheExpired: false }
    expect(shouldBlockRewrite({ enabled: false, coldEnabled: true, coldRewrite: false, analysis: warmEarly, predictedTokens: 90_000, minTokens: 50_000, consented: false })).toBe(false)
  })

  test('ниже порога не блокируется ни в одном случае', () => {
    expect(shouldBlockRewrite({ enabled: true, coldEnabled: true, analysis: cold(), predictedTokens: 49_999, minTokens: 50_000, consented: false })).toBe(false)
    expect(shouldBlockRewrite({ enabled: true, analysis: warm(), predictedTokens: 49_999, minTokens: 50_000, consented: false })).toBe(false)
  })

  test('согласие снимает блокировку в обоих случаях', () => {
    expect(shouldBlockRewrite({ enabled: true, coldEnabled: true, analysis: cold(), predictedTokens: 90_000, minTokens: 50_000, consented: true })).toBe(false)
  })

  // АВТО-ОТКАТ: условие — «остановили и никто не прошёл», а не «прошло время».
  test('окно с последнего отказа не истекло — не откатываем', () => {
    expect(shouldAutoRevert({ now: 100_000, lastRefusalAt: 70_000, lastPassAt: 0, windowMs: 60_000 })).toBe(false)
  })

  test('отказ был, окно истекло, пропусков после — откатываем', () => {
    expect(shouldAutoRevert({ now: 131_000, lastRefusalAt: 70_000, lastPassAt: 0, windowMs: 60_000 })).toBe(true)
  })

  test('хоть один прошёл ПОСЛЕ отказа — кислород не перекрыт', () => {
    expect(shouldAutoRevert({ now: 200_000, lastRefusalAt: 70_000, lastPassAt: 90_000, windowMs: 60_000 })).toBe(false)
  })

  // 🔴 ОКНО СКОЛЬЗЯЩЕЕ: провал ПОСЛЕ более раннего успеха обязан считаться.
  test('прошлый успех не спасает: новый отказ и тишина после него — откат', () => {
    expect(shouldAutoRevert({ now: 300_000, lastRefusalAt: 200_000, lastPassAt: 90_000, windowMs: 60_000 })).toBe(true)
  })

  test('тишина — не поломка: отказов не было вовсе', () => {
    expect(shouldAutoRevert({ now: 900_000, lastRefusalAt: 0, lastPassAt: 0, windowMs: 60_000 })).toBe(false)
  })

  test('окно 0 — авто-откат выключен', () => {
    expect(shouldAutoRevert({ now: 900_000, lastRefusalAt: 100, lastPassAt: 0, windowMs: 0 })).toBe(false)
  })
})
