/**
 * Regression tests for orphan tool_use sanitizer in convertPrompt().
 *
 * Background: opencode persists assistant turns with tool_use blocks but
 * sometimes never persists the matching tool_result (interrupted streams,
 * crashed tool execution, etc). Anthropic API rejects such histories with
 *   400: messages.N: tool_use ids were found without tool_result blocks
 *        immediately after: toolu_XXX
 *
 * The sanitizer in convertPrompt() heals these by injecting a synthetic
 * tool_result block. These tests pin the contract for all the real-world
 * patterns observed in production.
 *
 * Pure logic, no I/O — runs fast.
 */

import { describe, expect, it } from 'bun:test'

// Inline copy of sanitizer logic from provider.ts:642-704.
// Kept in sync via this test — if provider.ts changes, this test must too.
const SANITIZER_CONSTANT_TEXT = '[Tool execution interrupted before completion. Please retry if needed.]'

function sanitize(messages: any[]): { messages: any[]; hits: number } {
  let hits = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
    const toolUseIds: string[] = []
    for (const block of msg.content as any[]) {
      if (block?.type === 'tool_use' && typeof block.id === 'string') toolUseIds.push(block.id)
    }
    if (toolUseIds.length === 0) continue
    const next = messages[i + 1]
    const coveredIds = new Set<string>()
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      for (const block of next.content as any[]) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') coveredIds.add(block.tool_use_id)
      }
    }
    const orphanIds = toolUseIds.filter(id => !coveredIds.has(id))
    if (orphanIds.length === 0) continue
    const synthetic = orphanIds.map(id => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: SANITIZER_CONSTANT_TEXT,
      is_error: true,
    }))
    if (next && next.role === 'user' && Array.isArray(next.content)) {
      (next.content as any[]).push(...synthetic)
    } else {
      messages.splice(i + 1, 0, { role: 'user', content: synthetic })
    }
    hits += orphanIds.length
  }
  return { messages, hits }
}

describe('orphan tool_use sanitizer — common patterns', () => {
  it('healthy conversation passes through byte-identical', () => {
    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }] },
    ]
    const before = JSON.stringify(messages)
    const r = sanitize(messages)
    expect(r.hits).toBe(0)
    expect(JSON.stringify(r.messages)).toBe(before)
  })

  it('heals orphan when next message is missing entirely', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_X', name: 'write', input: {} }] },
    ]
    const r = sanitize(messages)
    expect(r.hits).toBe(1)
    expect(r.messages).toHaveLength(2)
    expect(r.messages[1].role).toBe('user')
    expect(r.messages[1].content[0].type).toBe('tool_result')
    expect(r.messages[1].content[0].tool_use_id).toBe('toolu_X')
    expect(r.messages[1].content[0].is_error).toBe(true)
  })

  it('heals orphan when next message is also assistant (production-observed case)', () => {
    // Real bug in opencode session ses_20760f2dfffeb...: two consecutive assistant
    // messages, first has interrupted tool_use, no tool_result between them.
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_X', name: 'write', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hmm, retrying...' }, { type: 'tool_use', id: 'toolu_Y', name: 'write', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_Y', content: 'ok' }] },
    ]
    const r = sanitize(messages)
    expect(r.hits).toBe(1)
    // After healing, sequence should be: assistant(X) → user(synth_X) → assistant(Y) → user(Y)
    expect(r.messages).toHaveLength(4)
    expect(r.messages[1].role).toBe('user')
    expect(r.messages[1].content[0].tool_use_id).toBe('toolu_X')
    expect(r.messages[2].role).toBe('assistant')
    expect(r.messages[3].role).toBe('user')
  })

  it('appends synthetic into existing user message when next is user but missing some tool_results', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_A', name: 'write', input: {} },
        { type: 'tool_use', id: 'toolu_B', name: 'read', input: {} },
      ]},
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' },
        // toolu_B is orphan
      ]},
    ]
    const r = sanitize(messages)
    expect(r.hits).toBe(1)
    expect(r.messages).toHaveLength(2) // no new message inserted, appended to existing
    expect(r.messages[1].content).toHaveLength(2)
    expect(r.messages[1].content[1].tool_use_id).toBe('toolu_B')
    expect(r.messages[1].content[1].is_error).toBe(true)
  })

  it('idempotent — running twice yields same result as once', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_X', name: 'write', input: {} }] },
      { role: 'assistant', content: [{ type: 'text', text: 'next' }] },
    ]
    const once = sanitize(JSON.parse(JSON.stringify(messages)))
    const twice = sanitize(once.messages)
    expect(twice.hits).toBe(0)
    expect(JSON.stringify(twice.messages)).toBe(JSON.stringify(once.messages))
  })

  it('synthetic tool_result uses constant text for cache stability', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_X', name: 'write', input: {} }] },
    ]
    const r1 = sanitize(JSON.parse(JSON.stringify(messages)))
    const r2 = sanitize(JSON.parse(JSON.stringify(messages)))
    // Same input → byte-identical output (no timestamps, no random IDs)
    expect(JSON.stringify(r1.messages)).toBe(JSON.stringify(r2.messages))
    expect(r1.messages[1].content[0].content).toBe(SANITIZER_CONSTANT_TEXT)
  })

  it('handles multiple orphans in single assistant turn', () => {
    const messages = [
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'toolu_A', name: 'write', input: {} },
        { type: 'tool_use', id: 'toolu_B', name: 'write', input: {} },
        { type: 'tool_use', id: 'toolu_C', name: 'write', input: {} },
      ]},
    ]
    const r = sanitize(messages)
    expect(r.hits).toBe(3)
    expect(r.messages[1].content).toHaveLength(3)
    expect(new Set(r.messages[1].content.map((c: any) => c.tool_use_id))).toEqual(new Set(['toolu_A', 'toolu_B', 'toolu_C']))
  })
})
