import { describe, expect, test } from 'bun:test'
import { formatWakeMessage } from './wake-listener'
import type { WakeEvent } from './wake-types'

function channelMessageEvent(payload: Record<string, unknown>): WakeEvent {
  return {
    eventId: 'evt-canonical-channel-message',
    source: 'synqtask',
    type: 'channel_message',
    priority: 'urgent',
    targetMemberId: 'agent-developer',
    payload,
    timestamp: '2026-04-28T20:16:48.833Z',
  }
}

describe('formatWakeMessage — channel_message author resolution', () => {
  test('canonical SynqTask payload (authorName/authorId) renders correct sender', () => {
    const text = formatWakeMessage(
      channelMessageEvent({
        channelId: 'chan-canonical-1',
        authorName: 'agent-ceo',
        authorId: '11111111-1111-1111-1111-111111111111',
        text: '@agent-developer please reply',
      }),
    )
    expect(text).toContain('Channel Message from agent-ceo')
    expect(text).not.toContain('Channel Message from unknown')
    expect(text).toContain('`chan-canonical-1`')
  })

  test('legacy non-SynqTask payload (sender_name) still works', () => {
    const text = formatWakeMessage(
      channelMessageEvent({
        channel_id: 'chan-legacy',
        sender_name: 'legacy-bot',
        text: 'hi from a legacy adapter',
      }),
    )
    expect(text).toContain('Channel Message from legacy-bot')
  })

  test('falls back to authorId when authorName missing', () => {
    const text = formatWakeMessage(
      channelMessageEvent({
        channelId: 'chan-id-only',
        authorId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        text: 'no name available',
      }),
    )
    expect(text).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(text).not.toContain('from unknown')
  })

  test('falls back to "unknown" only when no author hint at all', () => {
    const text = formatWakeMessage(
      channelMessageEvent({
        channelId: 'chan-no-author',
        text: 'orphan message',
      }),
    )
    expect(text).toContain('Channel Message from unknown')
  })
})

describe('formatWakeMessage — настроечные данные не повторяются в каждой побудке', () => {
  // Слово фаундера 02.10: блок «кто ты, роль, команда, напарники» приходил с каждым сообщением,
  // у одиночки — «Team: none. Teammates: none.». Роль агент получает один раз на старте сессии
  // стартовым контекстом ядра; в побудке её больше нет, даже если личность известна.
  test('с известной личностью — ни блока, ни роли, ни напарников', () => {
    const identity = {
      name: 'vibe-synqtalk-owner', roleName: 'Project Owner', rolePrompt: 'You own the project.',
      teamName: null, teammates: [], budget: { maxSubagents: 5, maxSpawnDepth: 2 },
    } as any
    const text = formatWakeMessage(channelMessageEvent({ channelId: 'c1', authorName: 'agent-ceo', text: 'привет' }), identity)
    expect(text).not.toContain('<agent-identity')
    expect(text).not.toContain('You own the project.')
    expect(text).not.toContain('Teammates')
    expect(text).toContain('Channel Message from agent-ceo')
    expect(text.startsWith('<system-reminder type="wake"')).toBe(true)
  })
})

describe('приёмник не пишет в SynqTask за агента', () => {
  // 02.10.2026, решение владельца SynqTask: статус задачи — дело самого агента, а runtime_state
  // через batch_update_active порождал на сервере agent_waking — адаптер сам себе вызывал подъём.
  test('в приёмнике нет смены статуса задачи, runtime_state и wakeLifecycle', async () => {
    const src = await Bun.file(new URL('./wake-listener.ts', import.meta.url)).text()
    expect(src).not.toContain("action: 'set_status'")
    expect(src).not.toContain('batch_update_active')
    expect(src).not.toContain("key: 'wakeLifecycle'")
    expect(src).not.toContain('Starting work on')
  })
})
