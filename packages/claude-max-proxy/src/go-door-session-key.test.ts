/**
 * Якорь липкости из тела. Полюс: LiteLLM не передаёт номер сессии, и без якоря весь флот
 * сидит на одной организации, а при смене лидера переезжает разом — с холодной перезаписью
 * префикса на каждом разговоре (замер 26.10.2026: медиана prompt 390 тыс. токенов).
 */
import { describe, expect, test } from 'bun:test'
import { conversationKey } from './modules/go-door.js'

const body = (msgs: unknown[]) => ({ model: 'deepseek-v4.1-flash', messages: msgs })

describe('ключ разговора для липкости', () => {
  test('растущий разговор сохраняет ключ — иначе липкость бесполезна', () => {
    const first = body([
      { role: 'system', content: 'ты агент' },
      { role: 'user', content: 'первый вопрос' },
    ])
    const later = body([
      { role: 'system', content: 'ты агент' },
      { role: 'user', content: 'первый вопрос' },
      { role: 'assistant', content: 'ответ' },
      { role: 'user', content: 'второй вопрос' },
    ])
    expect(conversationKey(first)).toBeTruthy()
    expect(conversationKey(later)).toBe(conversationKey(first))
  })

  test('разные разговоры получают разные ключи — иначе весь флот на одной организации', () => {
    const a = conversationKey(body([{ role: 'user', content: 'вопрос A' }, { role: 'user', content: 'x' }]))
    const b = conversationKey(body([{ role: 'user', content: 'вопрос B' }, { role: 'user', content: 'x' }]))
    expect(a).not.toBe(b)
  })

  test('одинаковый системный промпт НЕ склеивает разговоры', () => {
    const a = conversationKey(body([{ role: 'system', content: 'один и тот же' }, { role: 'user', content: 'A' }]))
    const b = conversationKey(body([{ role: 'system', content: 'один и тот же' }, { role: 'user', content: 'B' }]))
    expect(a).not.toBe(b)
  })

  test('тело без не-системных сообщений → null (честное «якоря нет»)', () => {
    expect(conversationKey(body([{ role: 'system', content: 'только система' }]))).toBeNull()
    expect(conversationKey({ model: 'x' })).toBeNull()
    expect(conversationKey(null)).toBeNull()
  })

  test('содержимое частями (мультимодальный вход) тоже даёт якорь', () => {
    const k = conversationKey(body([{ role: 'user', content: [{ type: 'text', text: 'картинка и текст' }] }]))
    expect(k).toMatch(/^[0-9a-f]{16}$/)
  })
})
