import { describe, test, expect } from 'bun:test'
import { ClaudeCodeSDK } from '../src/sdk.js'
import { Conversation } from '../src/conversation.js'
import { saveSession, loadSession } from '../src/session.js'
import { join } from 'path'
import { tmpdir } from 'os'
import { unlinkSync } from 'fs'

describe('Conversation: multi-turn', () => {

  test('2-turn conversation with memory + cache', async () => {
    const sdk = new ClaudeCodeSDK()
    const conv = new Conversation(sdk, {
      model: 'claude-sonnet-4-6',
      maxTokens: 16384,
    })

    // Turn 1
    const r1 = await conv.send('Remember this number: 42. Just say OK.')
    console.log('Turn 1:', r1.content)
    console.log('Turn 1 usage:', r1.usage)
    expect(r1.content.length).toBeGreaterThan(0)

    // Turn 2 — model should remember 42
    const r2 = await conv.send('What number did I ask you to remember? Just the number.')
    console.log('Turn 2:', r2.content)
    console.log('Turn 2 usage:', r2.usage)

    const text = r2.content.find(b => b.type === 'text')
    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.text).toContain('42')
    }

    // Check cache hit on turn 2
    console.log('Cache read:', r2.usage.cacheReadInputTokens)
    console.log('Total usage:', conv.totalUsage)
    expect(conv.length).toBe(4) // user1 + assistant1 + user2 + assistant2
  }, 120_000)

  test('rewind removes messages', async () => {
    const sdk = new ClaudeCodeSDK()
    const conv = new Conversation(sdk, {
      model: 'claude-sonnet-4-6',
      maxTokens: 16384,
    })

    await conv.send('Message A')
    await conv.send('Message B')
    expect(conv.length).toBe(4) // 2 user + 2 assistant

    const removed = conv.undoLastTurn()
    console.log('Removed:', removed.length, 'messages')
    expect(conv.length).toBe(2) // user1 + assistant1

    // Can continue after rewind
    const r3 = await conv.send('Message C (after rewind)')
    expect(r3.content.length).toBeGreaterThan(0)
    expect(conv.length).toBe(4)
  }, 120_000)

  test('branch creates independent copy', () => {
    const sdk = new ClaudeCodeSDK()
    const conv = new Conversation(sdk, { model: 'claude-sonnet-4-6' })

    // Simulate messages manually for branch test (no API call)
    ;(conv as any)._messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] },
    ]

    const branch = conv.branch()
    expect(branch.length).toBe(2)

    // Modify original — branch unaffected
    ;(conv as any)._messages.push({ role: 'user', content: 'More' })
    expect(conv.length).toBe(3)
    expect(branch.length).toBe(2)
  })

  test('session save/load', () => {
    const sdk = new ClaudeCodeSDK()
    const conv = new Conversation(sdk, { model: 'claude-sonnet-4-6' })

    ;(conv as any)._messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there!' }] },
      { role: 'user', content: 'How are you?' },
      { role: 'assistant', content: [{ type: 'text', text: 'Great!' }] },
    ]

    const path = join(tmpdir(), `test-session-${Date.now()}.jsonl`)
    saveSession(path, conv.messages)

    const loaded = loadSession(path)
    expect(loaded.length).toBe(4)
    expect(loaded[0].role).toBe('user')
    expect(loaded[0].content).toBe('Hello')
    expect(loaded[1].role).toBe('assistant')

    unlinkSync(path)
  })

  test('getHistory returns indexed list', () => {
    const sdk = new ClaudeCodeSDK()
    const conv = new Conversation(sdk, { model: 'claude-sonnet-4-6' })

    ;(conv as any)._messages = [
      { role: 'user', content: 'First message' },
      { role: 'assistant', content: [{ type: 'text', text: 'Response 1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'abc', content: 'result' }] },
    ]

    const history = conv.getHistory()
    expect(history.length).toBe(3)
    expect(history[0]).toEqual({ index: 0, role: 'user', preview: 'First message' })
    expect(history[2].preview).toContain('tool_result')
  })
})
