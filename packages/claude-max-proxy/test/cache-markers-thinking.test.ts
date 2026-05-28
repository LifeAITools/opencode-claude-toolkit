/**
 * injectCacheMarkers must NEVER add cache_control to a thinking/redacted_thinking
 * block. Anthropic rejects ANY modification of thinking blocks in the latest
 * assistant message ("`thinking` blocks ... cannot be modified") with a 400 —
 * which blocked live /v1/messages traffic after the facade enrichment shipped.
 */

import { describe, test, expect } from 'bun:test'
import { injectCacheMarkers } from '../src/openai-translate.js'

describe('injectCacheMarkers — thinking-block safety (BP3)', () => {
  test('does NOT mark a trailing thinking block; marks the last non-thinking block', () => {
    const body: any = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [
          { type: 'text', text: 'answer' },
          { type: 'thinking', thinking: 'reasoning...' },
        ] },
      ],
    }
    injectCacheMarkers(body)
    const blocks = body.messages[1].content
    expect(blocks[1].cache_control).toBeUndefined()   // thinking untouched
    expect(blocks[0].cache_control).toBeDefined()      // marker on the text block
  })

  test('skips BP3 entirely when ALL trailing blocks are thinking', () => {
    const body: any = {
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'a' },
          { type: 'redacted_thinking', data: 'b' },
        ] },
      ],
    }
    injectCacheMarkers(body)
    for (const b of body.messages[1].content) expect(b.cache_control).toBeUndefined()
  })

  test('still marks the last block when no thinking present (unchanged behavior)', () => {
    const body: any = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
    }
    injectCacheMarkers(body)
    expect(body.messages[0].content[0].cache_control).toBeDefined()
  })
})
