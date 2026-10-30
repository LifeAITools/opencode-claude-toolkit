/**
 * Исключение сторожа холодной записи по зовущему (30.10.2026).
 *
 * Повод — живой случай: разговор в чат-сервисе (`kiberos-chat/1.0`), вернувшийся после 7 часов
 * простоя, получил 10 отказов подряд. Человеку сторож предлагал «перезапусти сессию», а у
 * человека другой сессии нет — есть только этот разговор.
 *
 * Правило здесь одно и оно ПУСТОЕ по умолчанию: пока список пуст, сторож работает как раньше
 * для всех. Ключ нужен, чтобы будущее решение фаундера было одной строкой в настройке и было
 * видно в журнале, а не подразумевалось.
 */
import { describe, expect, test } from 'bun:test'
import { callerExemption } from '../src/modules/go-door.js'

describe('исключение сторожа по метке зовущего', () => {
  test('пустой список — исключений нет, сторож для всех (поведение не меняется)', () => {
    expect(callerExemption('chat', [])).toBeNull()
    expect(callerExemption(null, [])).toBeNull()
  })

  test('точное совпадение, регистр не важен', () => {
    expect(callerExemption('Chat', ['chat'])).toBe('chat')
    expect(callerExemption('chat', ['CHAT'])).toBe('CHAT')
  })

  test('фрагмент не считается совпадением: метка — имя класса, а не подстрока', () => {
    // Иначе «chat-bot» подошёл бы под «chat», а «не-chat» — тоже: правило стало бы шире заявленного.
    expect(callerExemption('chat-bot', ['chat'])).toBeNull()
    expect(callerExemption('agent', ['chat'])).toBeNull()
    expect(callerExemption('', ['chat'])).toBeNull()
  })

  test('пустые элементы списка не превращаются в «исключить всех»', () => {
    expect(callerExemption('agent', ['', '   '])).toBeNull()
  })
})
