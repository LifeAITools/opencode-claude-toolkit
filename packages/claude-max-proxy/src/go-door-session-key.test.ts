/**
 * Якорь липкости, когда номер сессии не пришёл. Полюс — правило фаундера (26.10):
 * «прыгать между сессиями категорически плохо, потому что сожжём холодный кэш на всех
 * организациях… если сессию знаем, значит организация была уже выдана».
 *
 * Поэтому якорь обязан переживать УПЛОТНЕНИЕ контекста: клиент присылает пересказ вместо
 * истории, и первое не-системное сообщение меняется. Держимся за системный промпт и инструменты.
 */
import { describe, expect, test } from 'bun:test'
import { agentKey } from './modules/go-door.js'

const SYS = [{ role: 'system', content: 'ты агент проекта X' }]
const TOOLS = [{ type: 'function', function: { name: 'bash', parameters: { type: 'object' } } }]
const body = (msgs: unknown[], extra: Record<string, unknown> = {}) => ({ model: 'm', messages: msgs, ...extra })

describe('якорь липкости переживает рост и уплотнение разговора', () => {
  test('рост разговора ключ не меняет', () => {
    const first = body([...SYS, { role: 'user', content: 'первый вопрос' }], { tools: TOOLS })
    const later = body([...SYS, { role: 'user', content: 'первый вопрос' }, { role: 'assistant', content: 'ответ' }, { role: 'user', content: 'второй' }], { tools: TOOLS })
    expect(agentKey(first)).toBeTruthy()
    expect(agentKey(later)).toBe(agentKey(first))
  })

  test('УПЛОТНЕНИЕ: история заменена пересказом — ключ тот же', () => {
    const before = body([...SYS, { role: 'user', content: 'длинная история' }, { role: 'assistant', content: '...' }], { tools: TOOLS })
    const after = body([...SYS, { role: 'user', content: 'КРАТКОЕ СОДЕРЖАНИЕ разговора' }], { tools: TOOLS })
    expect(agentKey(after)).toBe(agentKey(before))
  })

  test('другой системный промпт — другой ключ (другой агент)', () => {
    const a = agentKey(body([{ role: 'system', content: 'агент A' }], { tools: TOOLS }))
    const b = agentKey(body([{ role: 'system', content: 'агент B' }], { tools: TOOLS }))
    expect(a).not.toBe(b)
  })

  test('другой набор инструментов — другой ключ', () => {
    const a = agentKey(body(SYS, { tools: TOOLS }))
    const b = agentKey(body(SYS, { tools: [{ type: 'function', function: { name: 'other' } }] }))
    expect(a).not.toBe(b)
  })

  test('нет ни системы, ни инструментов — честное «якоря нет»', () => {
    expect(agentKey(body([{ role: 'user', content: 'привет' }]))).toBeNull()
    expect(agentKey({ model: 'm' })).toBeNull()
    expect(agentKey(null)).toBeNull()
  })

  test('ключ — стабильный hex', () => {
    expect(agentKey(body(SYS, { tools: TOOLS }))).toMatch(/^[0-9a-f]{16}$/)
  })
})
