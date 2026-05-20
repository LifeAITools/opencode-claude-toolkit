import { describe, test, expect } from 'bun:test'
import { ClaudeCodeSDK } from '../src/sdk.js'

describe('E2E: ClaudeCodeSDK', () => {

  test('sonnet-4-6', async () => {
    const sdk = new ClaudeCodeSDK()
    const chunks: string[] = []
    for await (const event of sdk.stream({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Say "hello" only.' }],
      maxTokens: 16384,
    })) {
      if (event.type === 'text_delta') chunks.push(event.text)
      if (event.type === 'message_stop') console.log('sonnet usage:', event.usage)
    }
    console.log('sonnet:', chunks.join(''))
    expect(chunks.join('').length).toBeGreaterThan(0)
  }, 60_000)

  test('opus-4-6', async () => {
    const sdk = new ClaudeCodeSDK()
    const chunks: string[] = []
    let thinkLen = 0
    for await (const event of sdk.stream({
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'Say "opus" only.' }],
      maxTokens: 16384,
    })) {
      if (event.type === 'text_delta') chunks.push(event.text)
      if (event.type === 'thinking_delta') thinkLen += event.text.length
      if (event.type === 'message_stop') console.log('opus usage:', event.usage)
    }
    console.log('opus:', chunks.join(''), '| thinking:', thinkLen, 'chars')
    expect(chunks.join('').length).toBeGreaterThan(0)
  }, 120_000)

  test('generate() non-streaming', async () => {
    const sdk = new ClaudeCodeSDK()
    const r = await sdk.generate({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: '2+2=?' }],
      maxTokens: 16384,
    })
    console.log('generate:', r.content, 'stop:', r.stopReason)
    expect(r.content.length).toBeGreaterThan(0)
  }, 60_000)
})
