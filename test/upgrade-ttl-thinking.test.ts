/**
 * upgradeCacheControlTtl must NEVER touch a thinking/redacted_thinking block,
 * even one carrying a cache_control marker. Anthropic rejects any modification
 * of thinking blocks in the latest assistant message (400). The proxy's facade
 * enrichment adds the prompt-caching-scope beta, which enabled this upgrade path
 * for clients that carry cache_control on a thinking block → live 400s.
 */

import { describe, test, expect } from 'bun:test'
import { upgradeCacheControlTtl } from '../src/keepalive-engine.js'

describe('upgradeCacheControlTtl — thinking-block safety', () => {
  test('does NOT upgrade cache_control on a thinking block', () => {
    const body: any = {
      messages: [
        { role: 'assistant', content: [
          { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
          { type: 'thinking', thinking: 'x', cache_control: { type: 'ephemeral' } },
        ] },
      ],
    }
    const { upgraded } = upgradeCacheControlTtl(body)
    const blocks = body.messages[0].content
    expect(blocks[1].cache_control.ttl).toBeUndefined()  // thinking block untouched
    expect(blocks[0].cache_control.ttl).toBe('1h')        // normal text block upgraded
    expect(upgraded).toBe(1)
  })

  test('does NOT upgrade redacted_thinking blocks', () => {
    const body: any = {
      messages: [{ role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'y', cache_control: { type: 'ephemeral' } },
      ] }],
    }
    const { upgraded } = upgradeCacheControlTtl(body)
    expect(body.messages[0].content[0].cache_control.ttl).toBeUndefined()
    expect(upgraded).toBe(0)
  })

  test('still upgrades normal system/tool markers (unchanged behavior)', () => {
    const body: any = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
    }
    const { upgraded } = upgradeCacheControlTtl(body)
    expect(body.system[0].cache_control.ttl).toBe('1h')
    expect(body.tools[0].cache_control.ttl).toBe('1h')
    expect(upgraded).toBe(2)
  })
})
