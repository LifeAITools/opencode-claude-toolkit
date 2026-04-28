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
