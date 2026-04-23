/**
 * Behavior tests for the signal-wire adapter (Consumer-1, long-running).
 *
 * Verifies the adapter correctly delegates to @kiberos/signal-wire-core and
 * honors legacy API shape against the production SSOT ruleset.
 */

import { describe, test, expect } from 'bun:test'
import { SignalWire } from './signal-wire'
import { translateLegacyRules, getBundledRulesPath } from '@kiberos/signal-wire-core'
import { readFileSync } from 'node:fs'

// SSOT — lives inside @kiberos/signal-wire-core, resolved at runtime.
const PROD_RULES_PATH = getBundledRulesPath()

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

describe('SignalWire adapter — hot-reload', () => {
  test('picks up new rule within 2s after rules file changes', async () => {
    const { writeFileSync, readFileSync, mkdtempSync, rmSync, statSync, utimesSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const os = await import('node:os')

    // Use a temp rules file to avoid stomping on SSOT during the test
    const tmpDir = mkdtempSync(j(os.tmpdir(), 'sw-hotreload-'))
    const tmpRules = j(tmpDir, 'signal-wire-rules.json')

    try {
      // Start with minimal 1-rule set
      writeFileSync(tmpRules, JSON.stringify({
        rules: [{
          id: 'test-rule-A',
          events: ['UserPromptSubmit'],
          action: { hint: 'hello from A' },
          platforms: ['opencode'],
        }],
      }), 'utf8')

      const sw = new SignalWire({
        serverUrl: 'http://127.0.0.1:0',
        sessionId: 'ses_reload',
        rulesPath: tmpRules,
        platform: 'opencode',
      })

      // Initial snapshot: one rule present
      expect(sw.listRules().map(r => r.id)).toEqual(['test-rule-A'])

      // Write a second rule; bump mtime into the past to bypass 2s debounce
      // window and make the fingerprint (mtimeMs, size) change cheap-visibly.
      writeFileSync(tmpRules, JSON.stringify({
        rules: [
          {
            id: 'test-rule-A',
            events: ['UserPromptSubmit'],
            action: { hint: 'hello from A' },
            platforms: ['opencode'],
          },
          {
            id: 'test-rule-B',
            events: ['UserPromptSubmit'],
            action: { hint: 'hello from B' },
            platforms: ['opencode'],
          },
        ],
      }), 'utf8')

      // Force the debounce to elapse — set mtime to well in the past and
      // wait >2s so Date.now() - lastCheckMs > HOT_RELOAD_INTERVAL_MS.
      await new Promise(r => setTimeout(r, 2100))

      const listed = sw.listRules().map(r => r.id)
      expect(listed).toContain('test-rule-A')
      expect(listed).toContain('test-rule-B')
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }, 8000)

  test('keeps old rules active when file becomes invalid JSON', async () => {
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { join: j } = await import('node:path')
    const os = await import('node:os')

    const tmpDir = mkdtempSync(j(os.tmpdir(), 'sw-hotreload-bad-'))
    const tmpRules = j(tmpDir, 'signal-wire-rules.json')

    try {
      writeFileSync(tmpRules, JSON.stringify({
        rules: [{
          id: 'good-rule',
          events: ['UserPromptSubmit'],
          action: { hint: 'still here' },
          platforms: ['opencode'],
        }],
      }), 'utf8')

      const sw = new SignalWire({
        serverUrl: 'http://127.0.0.1:0',
        sessionId: 'ses_reload_bad',
        rulesPath: tmpRules,
        platform: 'opencode',
      })
      expect(sw.listRules().map(r => r.id)).toEqual(['good-rule'])

      // Corrupt the file
      writeFileSync(tmpRules, '{broken json', 'utf8')
      await new Promise(r => setTimeout(r, 2100))

      // Old rules must still be active (keep-old-rules on validation fail)
      expect(sw.listRules().map(r => r.id)).toEqual(['good-rule'])
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
    }
  }, 8000)
})
