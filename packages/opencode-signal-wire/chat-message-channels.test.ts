/**
 * Каналы `chat.message` и проза агента (2026-10-11, переписано 2026-10-12).
 *
 * Правила по прозе агента (`anti-silent-defer`, `agent-claims-continue`, …) читают ТОЛЬКО
 * `payload.channels.agent_text`. Взять её из `chat.message` по роли НЕЛЬЗЯ: opencode зовёт этот
 * хук только на сообщение человека (бинарь 1.19.0: `trigger("chat.message")` — одно вхождение,
 * внутри `createUserMessage`, роль всегда `user`). Поэтому `normalizeChatMessage` несёт только
 * `user_text`, а `agent_text` копится из дельт `message.part.updated` (session-lifecycle.ts).
 */
import { describe, test, expect } from 'bun:test'
import { normalizeChatMessage } from './hook-listener'
import { appendAgentProse, peekAgentProse, takeAgentProse } from './session-lifecycle'

const parts = (t: string) => [{ type: 'text', text: t }]

describe('normalizeChatMessage — канал человека', () => {
  test('user → channels.user_text, agent_text НЕ ставится', () => {
    const ev = normalizeChatMessage({ sessionID: 's1' }, { message: { role: 'user' }, parts: parts('сделай X') })
    const channels = (ev.payload as { channels?: Record<string, string> }).channels
    expect(channels?.user_text).toBe('сделай X')
    expect(channels?.agent_text).toBeUndefined()
  })

  test('роль неизвестна → user_text (прежнее поведение, хук всегда про человека)', () => {
    const ev = normalizeChatMessage({ sessionID: 's1' }, { message: {}, parts: parts('текст') })
    const channels = (ev.payload as { channels?: Record<string, string> }).channels
    expect(channels?.user_text).toBe('текст')
  })
})

describe('копилка прозы агента (канал agent_text)', () => {
  test('append копит куски; peek читает БЕЗ обнуления; take читает И обнуляет', () => {
    const store = new Map<string, string>()
    appendAgentProse(store, 's1', 'Иду ')
    appendAgentProse(store, 's1', 'дальше.')
    // tool.after: проза текущего хода читается, но остаётся для следующих вызовов
    expect(peekAgentProse(store, 's1')).toBe('Иду дальше.')
    expect(peekAgentProse(store, 's1')).toBe('Иду дальше.')
    // chat.message: граница хода — прочитали и обнулили
    expect(takeAgentProse(store, 's1')).toBe('Иду дальше.')
    expect(takeAgentProse(store, 's1')).toBeUndefined()
    expect(peekAgentProse(store, 's1')).toBeUndefined()
  })

  test('пустая сессия и пустой кусок не копятся (иначе «проза» из пустоты)', () => {
    const store = new Map<string, string>()
    appendAgentProse(store, '', 'текст')
    appendAgentProse(store, 's1', '')
    expect(peekAgentProse(store, 's1')).toBeUndefined()
    expect(store.size).toBe(0)
  })

  test('сессии не смешиваются', () => {
    const store = new Map<string, string>()
    appendAgentProse(store, 'a', 'проза A')
    appendAgentProse(store, 'b', 'проза B')
    expect(takeAgentProse(store, 'a')).toBe('проза A')
    expect(peekAgentProse(store, 'b')).toBe('проза B')
  })
})
