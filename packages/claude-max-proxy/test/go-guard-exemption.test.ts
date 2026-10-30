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
import { guardExemption } from '../src/modules/go-door.js'

describe('исключение сторожа по user-agent', () => {
  test('пустой список — исключений нет, сторож для всех (поведение не меняется)', () => {
    expect(guardExemption('kiberos-chat/1.0', [])).toBeNull()
    expect(guardExemption('opencode/1.2', [])).toBeNull()
    expect(guardExemption(null, [])).toBeNull()
  })

  test('подстрока и регистр не важны', () => {
    expect(guardExemption('Kiberos-Chat/1.0', ['kiberos-chat'])).toBe('kiberos-chat')
    expect(guardExemption('kiberos-chat/1.0', ['KIBEROS-CHAT'])).toBe('KIBEROS-CHAT')
  })

  test('чужой агент под исключение не попадает', () => {
    expect(guardExemption('opencode/1.2', ['kiberos-chat'])).toBeNull()
    expect(guardExemption('', ['kiberos-chat'])).toBeNull()
  })

  test('пустые элементы списка не превращаются в «исключить всех»', () => {
    expect(guardExemption('opencode/1.2', ['', '   '])).toBeNull()
  })
})
