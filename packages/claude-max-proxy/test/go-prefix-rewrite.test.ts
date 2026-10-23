import { describe, expect, test } from 'bun:test'
import { prefixVerdict } from '../src/modules/go-door.js'

/**
 * Прибор для вопроса фаундера 23.10: «есть ли движки, которые ломают кэш — их надо вычислить».
 * Правило: кэш поставщика держится за ПРЕФИКС, поэтому «продолжение» и «перепись» различаются
 * двумя хлебами — и это можно решить, не храня тел запросов.
 */
describe('prefixVerdict — продолжение истории или переписывание', () => {
  const m = (t: string) => ({ role: 'user', content: t })
  const session = () => `ses_${Math.random().toString(36).slice(2)}`

  test('первый вызов сессии назван first', () => {
    expect(prefixVerdict(session(), { messages: [m('a'), m('b')] })).toBe('first')
  })

  test('дописали сообщение — append: префикс нового равен всему прошлому', () => {
    const s = session()
    prefixVerdict(s, { messages: [m('a'), m('b')] })
    expect(prefixVerdict(s, { messages: [m('a'), m('b'), m('c')] })).toBe('append')
  })

  test('ранняя часть переписана — rewrite (это и есть промах кэша)', () => {
    const s = session()
    prefixVerdict(s, { messages: [m('a'), m('b'), m('c')] })
    // тот же размер, но первый элемент другой: «промпт вырос, а кэша нет»
    expect(prefixVerdict(s, { messages: [m('A2'), m('b'), m('c'), m('d')] })).toBe('rewrite')
  })

  test('сжатие истории — тоже rewrite, но назван отдельным фактом, а не тишиной', () => {
    const s = session()
    prefixVerdict(s, { messages: [m('a'), m('b'), m('c'), m('d')] })
    expect(prefixVerdict(s, { messages: [m('SUMMARY'), m('d2')] })).toBe('rewrite')
  })

  test('без имени зовущего прибора нет — unknown, а не догадка', () => {
    expect(prefixVerdict(null, { messages: [m('a')] })).toBe('unknown')
  })

  test('тело без messages не ломает прибор', () => {
    expect(prefixVerdict(session(), {})).toBe('unknown')
    expect(prefixVerdict(session(), { messages: [] })).toBe('unknown')
  })

  test('одно сообщение — читать нечего, first', () => {
    const s = session()
    prefixVerdict(s, { messages: [m('a'), m('b')] })
    expect(prefixVerdict(s, { messages: [m('a')] })).toBe('first')
  })

  test('две сессии не мешают друг другу', () => {
    const a = session(), b = session()
    prefixVerdict(a, { messages: [m('a1'), m('a2')] })
    prefixVerdict(b, { messages: [m('b1'), m('b2')] })
    expect(prefixVerdict(a, { messages: [m('a1'), m('a2'), m('a3')] })).toBe('append')
    expect(prefixVerdict(b, { messages: [m('X'), m('b2'), m('b3')] })).toBe('rewrite')
  })
})
