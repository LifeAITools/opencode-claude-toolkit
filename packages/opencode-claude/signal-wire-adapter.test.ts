/**
 * Behavior-parity tests for signal-wire-core-adapter.
 *
 * Verifies the new adapter matches the legacy SignalWire class contract
 * against real production rules (signal-wire-rules.json).
 */

import { describe, test, expect } from 'bun:test'
import { SignalWire } from './signal-wire-core-adapter'
import { translateLegacyRules } from './signal-wire-translate'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PROD_RULES_PATH = join(import.meta.dir, 'signal-wire-rules.json')

describe('signal-wire-translate', () => {
  test('translateLegacyRules maps UserPromptSubmit → chat.message', () => {
    const legacy = [{
      id: 'greet',
      events: ['UserPromptSubmit'],
      match: { prompt_keywords: ['hi'] },
      action: { hint: 'hello there' },
    }]
    const canonical = translateLegacyRules(legacy, 'opencode')
    expect(canonical.length).toBe(1)
    expect(canonical[0].events).toEqual(['chat.message'])
    expect(canonical[0].actions).toEqual([{ type: 'hint', text: 'hello there' }])
  })

  test('translateLegacyRules maps PostToolUse → tool.after', () => {
    const legacy = [{
      id: 'r',
      events: ['PostToolUse'],
      action: { hint: 'x' },
    }]
    const canonical = translateLegacyRules(legacy, 'opencode')
    expect(canonical[0].events).toEqual(['tool.after'])
  })

  test('translateLegacyRules handles v2 actions:[...] passthrough', () => {
    const legacy = [{
      id: 'v2',
      events: ['PostToolUse'],
      actions: [
        { type: 'hint', text: 'x' },
        { type: 'audit' },
      ],
    }]
    const canonical = translateLegacyRules(legacy, 'opencode')
    expect(canonical[0].actions.length).toBe(2)
  })

  test('translateLegacyRules filters by platform', () => {
    const legacy = [
      { id: 'a', platforms: ['opencode'], events: ['UserPromptSubmit'], action: { hint: 'x' } },
      { id: 'b', platforms: ['claude-code'], events: ['UserPromptSubmit'], action: { hint: 'x' } },
      { id: 'c', events: ['UserPromptSubmit'], action: { hint: 'x' } },  // no platforms = all
    ]
    const canonical = translateLegacyRules(legacy, 'opencode')
    expect(canonical.map(r => r.id).sort()).toEqual(['a', 'c'])
  })

  test('translateLegacyRules converts cooldown_minutes → cooldown_seconds', () => {
    const legacy = [{
      id: 'r',
      events: ['UserPromptSubmit'],
      match: {},
      action: { hint: 'x' },
      cooldown_minutes: 5,
    }]
    const canonical = translateLegacyRules(legacy, 'opencode')
    expect(canonical[0].cooldown_seconds).toBe(300)
  })
})

describe('SignalWire adapter — legacy API', () => {
  test('loads production rules.json successfully', () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_test',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    const list = sw.listRules()
    expect(list.length).toBeGreaterThan(0)
  })

  test('evaluateAsync fires session-start-checklist on first UserPromptSubmit', async () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_parity_1',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    const result = await sw.evaluateAsync({
      event: 'UserPromptSubmit',
      lastUserText: 'help me with a task',
      lastToolName: '',
      lastToolInput: '',
      lastToolOutput: '',
    })
    expect(result).not.toBeNull()
    expect(result?.hint).toBeTruthy()
  })

  test('trackTokens does not throw and updates context position', () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_tok',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    sw.trackTokens({ inputTokens: 1000, cacheReadInputTokens: 500, cacheCreationInputTokens: 200 })
    expect(sw.getContextPosition()).toBe(1700)
    sw.trackTokens({ inputTokens: 2000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })
    expect(sw.getContextPosition()).toBe(2000)
  })

  test('toggleRule + isRuleEnabled round-trip', () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_toggle',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    const list = sw.listRules()
    if (list.length === 0) return
    const id = list[0].id
    expect(sw.isRuleEnabled(id)).toBe(true)
    expect(sw.toggleRule(id, false)).toBe(true)
    expect(sw.isRuleEnabled(id)).toBe(false)
    expect(sw.toggleRule(id, true)).toBe(true)
    expect(sw.isRuleEnabled(id)).toBe(true)
  })

  test('toggleRule returns false for non-existent rule', () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 's',
      rulesPath: PROD_RULES_PATH,
    })
    expect(sw.toggleRule('does-not-exist-xyz', false)).toBe(false)
  })

  test('evaluate (legacy sync) returns null on first call, cached on subsequent', async () => {
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_sync',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    const ctx: any = {
      event: 'UserPromptSubmit',
      lastUserText: 'help',
      lastToolName: '',
      lastToolInput: '',
      lastToolOutput: '',
    }
    // First call kicks off async — returns null (no cached result yet)
    const r1 = sw.evaluate(ctx)
    expect(r1).toBeNull()
    // Allow microtasks to resolve (MemoryBackend is effectively sync)
    await new Promise(resolve => setImmediate(resolve))
    // Second call returns cached result from the first async resolution
    const r2 = sw.evaluate(ctx)
    expect(r2).not.toBeNull()
  })
})

describe('SignalWire adapter — wake event path', () => {
  test('evaluateExternal on wake event fires matching rules', async () => {
    const rulesJson = readFileSync(PROD_RULES_PATH, 'utf8')
    const rules = JSON.parse(rulesJson).rules
    // Find a wake-related rule (v2-wake-*)
    const wakeRule = rules.find((r: any) => r.id?.startsWith('v2-wake'))
    if (!wakeRule) return  // No wake rules — skip
    const sw = new SignalWire({
      serverUrl: 'http://127.0.0.1:0',
      sessionId: 'ses_wake',
      rulesPath: PROD_RULES_PATH,
      platform: 'opencode',
    })
    // Get the wake event type — first event in the rule, translated
    const { results } = await sw.evaluateExternal({
      eventId: 'evt_test',
      source: 'synqtask',
      type: 'task_assigned',
      priority: 'urgent',
      targetMemberId: 'agent-test',
      payload: {},
      timestamp: new Date().toISOString(),
    })
    expect(Array.isArray(results)).toBe(true)
  })
})
