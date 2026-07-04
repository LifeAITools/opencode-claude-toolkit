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

describe('injectCacheMarkers — cache-AWARE client pass-through (Anthropic 4-mark cap)', () => {
  // Live regression 2026-07-04: kiberos-agent@0.3.1 budgets EXACTLY 4 marks
  // (2×system + last-tool + moving messages mark). The old per-slot logic saw the
  // UNMARKED last message and topped up a 5th mark → Anthropic 400 "A maximum of 4
  // blocks with cache_control may be provided. Found 5." on every multi-step turn.
  // A client that placed ANY mark owns its plan — zero injection.
  test('kiberos-shaped step-2 body (4 own marks, unmarked last message) gets ZERO injection', () => {
    const cc = { cache_control: { type: 'ephemeral' } }
    const body: any = {
      system: [
        { type: 'text', text: 'frozen prefix', ...cc },
        { type: 'text', text: 'static warm + legend', ...cc },
      ],
      tools: [
        { name: 'tool_a', input_schema: {} },
        { name: 'tool_b', input_schema: {}, ...cc },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: '⟦mode→PLAN⟧ prompt', ...cc }] },
        { role: 'user', content: [{ type: 'text', text: 'step-2 volatile tail' }] },
      ],
    }
    const injected = injectCacheMarkers(body)
    expect(injected).toBe(0)
    // The unmarked last message stays unmarked — total marks stay 4, never 5.
    expect(body.messages[1].content[0].cache_control).toBeUndefined()
    const total =
      body.system.filter((b: any) => b.cache_control).length +
      body.tools.filter((t: any) => t.cache_control).length +
      body.messages.flatMap((m: any) => m.content).filter((b: any) => b.cache_control).length
    expect(total).toBe(4)
  })

  test('a single message-level mark alone also disables injection (cache-aware)', () => {
    const body: any = {
      system: [{ type: 'text', text: 'sys' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }] }],
    }
    expect(injectCacheMarkers(body)).toBe(0)
    expect(body.system[0].cache_control).toBeUndefined()
  })

  test('marker-less body keeps the full BP1-3 injection (unchanged legacy path)', () => {
    const body: any = {
      system: [{ type: 'text', text: 'sys' }],
      tools: [{ name: 't', input_schema: {} }],
      messages: [{ role: 'user', content: 'hello' }],
    }
    expect(injectCacheMarkers(body)).toBe(3)
  })
})
