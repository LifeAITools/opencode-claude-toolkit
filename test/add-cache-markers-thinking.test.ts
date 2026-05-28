/**
 * ClaudeCodeSDK.addCacheMarkers (the generate() marker path, also used by the
 * opencode-claude provider) must NEVER add cache_control to a thinking/
 * redacted_thinking block in the latest assistant message. Anthropic rejects ANY
 * modification of thinking blocks (400 "thinking blocks ... cannot be modified").
 * Same regression class as upgradeCacheControlTtl / injectCacheMarkers.
 */

import { describe, test, expect } from 'bun:test'
import { ClaudeCodeSDK } from '../src/sdk.js'

function addMarkers(body: any): any {
  const sdk = new ClaudeCodeSDK({})
  ;(sdk as any).addCacheMarkers(body)
  return body
}

describe('addCacheMarkers — thinking-block safety (BP3)', () => {
  test('walks back to last NON-thinking block, leaving the thinking block untouched', () => {
    const body = {
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'reasoning', signature: 's' },
        ] },
      ],
    }
    addMarkers(body)
    const blocks = body.messages[1].content as any[]
    expect(blocks[1].cache_control).toBeUndefined()   // thinking block untouched
    expect(blocks[0].cache_control).toBeDefined()      // marker on the text block instead
  })

  test('skips BP3 entirely when ALL trailing blocks are thinking', () => {
    const body = {
      system: 'sys',
      messages: [
        { role: 'assistant', content: [
          { type: 'redacted_thinking', data: 'x' },
          { type: 'thinking', thinking: 'y', signature: 's' },
        ] },
      ],
    }
    addMarkers(body)
    const blocks = body.messages[0].content as any[]
    expect(blocks[0].cache_control).toBeUndefined()
    expect(blocks[1].cache_control).toBeUndefined()
  })

  test('still marks a normal trailing block (unchanged behavior)', () => {
    const body = {
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    }
    addMarkers(body)
    const blocks = body.messages[0].content as any[]
    expect(blocks[0].cache_control).toBeDefined()
  })
})
