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
