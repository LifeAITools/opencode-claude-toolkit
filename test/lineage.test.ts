/**
 * lineage.ts — pure-function tests for cache-prefix lineage + role detection.
 */

import { describe, test, expect } from 'bun:test'
import {
  lineageKey,
  prefixHashes,
  classifyRole,
  classifyRewrite,
} from '../src/lineage.js'

// ─── lineageKey ──────────────────────────────────────────────────

describe('lineageKey', () => {
  const main = {
    system: [{ type: 'text', text: 'You are Claude Code' }],
    tools: [{ name: 'Bash' }, { name: 'Read' }, { name: 'Agent' }],
  }

  test('deterministic — same body yields same key', () => {
    expect(lineageKey(main)).toBe(lineageKey(main))
  })

  test('tool order does not change the key (names are sorted)', () => {
    const reordered = { system: main.system, tools: [{ name: 'Agent' }, { name: 'Read' }, { name: 'Bash' }] }
    expect(lineageKey(reordered)).toBe(lineageKey(main))
  })

  test('different system → different key', () => {
    const sub = { system: [{ type: 'text', text: 'You are a sub-agent' }], tools: main.tools }
    expect(lineageKey(sub)).not.toBe(lineageKey(main))
  })

  test('different tool set → different key', () => {
    const fewer = { system: main.system, tools: [{ name: 'Bash' }, { name: 'Read' }] }
    expect(lineageKey(fewer)).not.toBe(lineageKey(main))
  })

  test('string system supported', () => {
    expect(lineageKey({ system: 'plain string sys', tools: [] })).toBeString()
  })

  test('volatile non-cache_control block (billing header) does NOT change the key', () => {
    // Claude Code prepends `x-anthropic-billing-header` with a per-request
    // `cch=` token and no cache_control — the lineage key must ignore it,
    // otherwise per-lineage tracking churns on every request.
    const cached = [{ type: 'text', text: 'You are Claude Code', cache_control: { type: 'ephemeral' } }]
    const req1 = { system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=aaaaa' }, ...cached], tools: [{ name: 'Bash' }] }
    const req2 = { system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=zzzzz' }, ...cached], tools: [{ name: 'Bash' }] }
    expect(lineageKey(req1)).toBe(lineageKey(req2))
  })

  test('a change inside a cache_control block DOES change the key', () => {
    const a = { system: [{ type: 'text', text: 'agent A', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'Bash' }] }
    const b = { system: [{ type: 'text', text: 'agent B', cache_control: { type: 'ephemeral' } }], tools: [{ name: 'Bash' }] }
    expect(lineageKey(a)).not.toBe(lineageKey(b))
  })

  test('malformed bodies never throw', () => {
    expect(() => lineageKey(null)).not.toThrow()
    expect(() => lineageKey(undefined)).not.toThrow()
    expect(() => lineageKey('not an object')).not.toThrow()
    expect(() => lineageKey({ tools: 'broken' })).not.toThrow()
    expect(() => lineageKey({ tools: [null, 5, {}] })).not.toThrow()
  })
})

// ─── prefixHashes ────────────────────────────────────────────────

describe('prefixHashes', () => {
  test('returns the documented shape', () => {
    const h = prefixHashes({ system: 'sys', tools: [{ name: 'A' }] })
    expect(h).toHaveProperty('system')
    expect(h).toHaveProperty('tools')
    expect(h).toHaveProperty('toolNames')
    expect(h.toolCount).toBe(1)
  })

  test('catches a tool DESCRIPTION change that lineageKey would miss', () => {
    const v1 = { system: 's', tools: [{ name: 'Bash', description: 'run shell' }] }
    const v2 = { system: 's', tools: [{ name: 'Bash', description: 'run shell commands now' }] }
    // Same name set → same lineageKey (identity unchanged)...
    expect(lineageKey(v1)).toBe(lineageKey(v2))
    // ...but the full tools hash differs → predictor sees the real cache change.
    expect(prefixHashes(v1).tools).not.toBe(prefixHashes(v2).tools)
    expect(prefixHashes(v1).toolNames).toBe(prefixHashes(v2).toolNames)
  })

  test('malformed never throws', () => {
    expect(() => prefixHashes(null)).not.toThrow()
    expect(() => prefixHashes({ tools: 'x' })).not.toThrow()
  })
})

// ─── classifyRole ────────────────────────────────────────────────

describe('classifyRole', () => {
  const richTools = Array.from({ length: 20 }, (_, i) => ({ name: `tool${i}` }))

  test('agent-id header present → sub', () => {
    const r = classifyRole({ tools: richTools }, { 'x-claude-code-agent-id': 'abc123' })
    expect(r.role).toBe('sub')
    expect(r.confidence).toBeGreaterThan(0.9)
  })

  test('agent-id header is case-insensitive', () => {
    const r = classifyRole({ tools: richTools }, { 'X-Claude-Code-Agent-Id': 'abc' })
    expect(r.role).toBe('sub')
  })

  test('no agent-id + 0/1 tools → aux (title-gen / quota probe)', () => {
    expect(classifyRole({ tools: [] }, {}).role).toBe('aux')
    expect(classifyRole({ tools: [{ name: 'OnlyOne' }] }, {}).role).toBe('aux')
  })

  test('no agent-id + spawn-tool present → main', () => {
    const r = classifyRole({ tools: [...richTools, { name: 'Agent' }] }, {})
    expect(r.role).toBe('main')
    expect(r.basis).toContain('spawn-tool')
  })

  test('spawn-tool detection is name-agnostic (opencode `task`, `delegate`)', () => {
    expect(classifyRole({ tools: [...richTools, { name: 'task' }] }, {}).role).toBe('main')
    expect(classifyRole({ tools: [...richTools, { name: 'delegate' }] }, {}).role).toBe('main')
  })

  test('no spawn-tool, no hints → unknown (not a failure — over-KA-safe default)', () => {
    const r = classifyRole({ tools: richTools }, {})
    expect(r.role).toBe('unknown')
    expect(r.confidence).toBeLessThan(0.5)
  })

  test('behavioural hint resumedAfterIdle alone confirms main', () => {
    const r = classifyRole({ tools: richTools }, {}, { resumedAfterIdle: true })
    expect(r.role).toBe('main')
    expect(r.basis).toContain('resumed-after-idle')
  })

  test('positional hints (oldest + richest) lift unknown to main', () => {
    const r = classifyRole({ tools: richTools }, {}, { oldestInGroup: true, richestToolsInGroup: true })
    expect(r.role).toBe('main')
  })

  test('never throws on malformed input', () => {
    expect(() => classifyRole(null, null)).not.toThrow()
    expect(() => classifyRole('x', 'y')).not.toThrow()
    expect(classifyRole(null, null).role).toBe('aux')  // no tools → aux
  })
})

// ─── classifyRewrite ─────────────────────────────────────────────

describe('classifyRewrite', () => {
  test('first request → expected:cold-start (the user’s "первичный запуск = норм")', () => {
    const v = classifyRewrite({ isFirstRequest: true })
    expect(v.class).toBe('expected:cold-start')
    expect(v.expected).toBe(true)
  })

  test('tools changed → expected:tools-changed', () => {
    const v = classifyRewrite({ toolsChanged: true })
    expect(v.class).toBe('expected:tools-changed')
    expect(v.expected).toBe(true)
  })

  test('idle past TTL → avoidable:ttl-expiry (a problem)', () => {
    const v = classifyRewrite({ idleMs: 400_000, ttlMs: 300_000 })
    expect(v.class).toBe('avoidable:ttl-expiry')
    expect(v.expected).toBe(false)
  })

  test('rewrite on a KA fire → anomalous:stale-ka-snapshot (a problem)', () => {
    const v = classifyRewrite({ isKaFire: true })
    expect(v.class).toBe('anomalous:stale-ka-snapshot')
    expect(v.expected).toBe(false)
  })

  test('isKaFire takes precedence over other signals', () => {
    expect(classifyRewrite({ isKaFire: true, isFirstRequest: true }).class)
      .toBe('anomalous:stale-ka-snapshot')
  })

  test('org changed → anomalous:org-switch (a problem)', () => {
    const v = classifyRewrite({ orgChanged: true })
    expect(v.class).toBe('anomalous:org-switch')
    expect(v.expected).toBe(false)
  })

  test('org-switch outranks expected:* signals (cross-org spend is the hazard)', () => {
    // A request can both change tools AND cross orgs — the org switch is the
    // dangerous classification, so it must win.
    expect(classifyRewrite({ orgChanged: true, toolsChanged: true }).class)
      .toBe('anomalous:org-switch')
    expect(classifyRewrite({ orgChanged: true, idleMs: 400_000, ttlMs: 300_000 }).class)
      .toBe('anomalous:org-switch')
  })

  test('isKaFire still outranks org-switch', () => {
    expect(classifyRewrite({ isKaFire: true, orgChanged: true }).class)
      .toBe('anomalous:stale-ka-snapshot')
  })

  test('never throws', () => {
    expect(() => classifyRewrite({})).not.toThrow()
    expect(() => classifyRewrite(null as any)).not.toThrow()
  })
})
