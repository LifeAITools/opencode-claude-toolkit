/**
 * Regression tests for todowrite tool input repair.
 *
 * Background: opencode's todowrite tool defines schema
 *   K.Struct({todos: K.mutable(K.Array(...))})
 * but Claude models occasionally emit a bare array `[{...}, ...]` without the
 * `{todos: ...}` wrapper. This causes a TUI crash with:
 *   SchemaError(Expected array, got "[{...}]")
 *
 * `repairTodowriteInput()` is the shared pure function used by both doGenerate
 * and doStream paths in provider.ts to detect + wrap bare arrays.
 *
 * These tests pin the contract so future refactors can't silently regress.
 * Pure logic, no I/O — runs fast in any Node environment.
 */

import { describe, expect, it } from 'bun:test'
import { repairTodowriteInput } from '../packages/opencode-claude/provider.js'

// Realistic input as observed in production logs.
const REAL_BARE_ARRAY = JSON.stringify([
  { content: 'Build worker file: scripts/translate-worker.mjs', status: 'in_progress', priority: 'high' },
  { content: 'Build endpoint: app/api/internal/jobs-run/route.ts', status: 'pending', priority: 'high' },
  { content: 'Patch deploy-tenant.sh: generate INTERNAL_WORKER_TOKEN', status: 'pending', priority: 'medium' },
])

describe('repairTodowriteInput — bare array (the canonical drift)', () => {
  it('wraps bare JSON-array into {todos: [...]}', () => {
    const r = repairTodowriteInput(REAL_BARE_ARRAY)
    expect(r.didRepair).toBe(true)
    expect(r.reason).toBeUndefined()
    const parsed = JSON.parse(r.repaired)
    expect(Array.isArray(parsed.todos)).toBe(true)
    expect(parsed.todos.length).toBe(3)
    expect(parsed.todos[0]).toEqual({
      content: 'Build worker file: scripts/translate-worker.mjs',
      status: 'in_progress',
      priority: 'high',
    })
  })

  it('handles empty array', () => {
    const r = repairTodowriteInput('[]')
    expect(r.didRepair).toBe(true)
    expect(JSON.parse(r.repaired)).toEqual({ todos: [] })
  })

  it('handles single-element array', () => {
    const r = repairTodowriteInput('[{"content":"a","status":"pending","priority":"low"}]')
    expect(r.didRepair).toBe(true)
    expect(JSON.parse(r.repaired).todos.length).toBe(1)
  })

  it('preserves item order and structure', () => {
    const items = [
      { content: 'first', status: 'in_progress', priority: 'high' },
      { content: 'second', status: 'pending', priority: 'low' },
    ]
    const r = repairTodowriteInput(JSON.stringify(items))
    expect(JSON.parse(r.repaired).todos).toEqual(items)
  })
})

describe('repairTodowriteInput — already correctly shaped', () => {
  it('passes through {todos: [...]} unchanged', () => {
    const wrapped = JSON.stringify({
      todos: [{ content: 'a', status: 'pending', priority: 'high' }],
    })
    const r = repairTodowriteInput(wrapped)
    expect(r.didRepair).toBe(false)
    expect(r.repaired).toBe(wrapped)
    expect(r.reason).toBeUndefined()
  })

  it('passes through {todos: []} (empty wrapped) unchanged', () => {
    const r = repairTodowriteInput('{"todos":[]}')
    expect(r.didRepair).toBe(false)
    expect(r.repaired).toBe('{"todos":[]}')
  })
})

describe('repairTodowriteInput — error paths (fail-safe pass-through)', () => {
  it('returns parse_failed reason on invalid JSON', () => {
    const r = repairTodowriteInput('not json at all')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/parse_failed/)
    expect(r.repaired).toBe('not json at all') // pass-through, downstream validator decides
  })

  it('returns unexpected_shape on object without todos', () => {
    const r = repairTodowriteInput('{"items": [1, 2]}')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/unexpected_shape/)
    expect(r.reason).toContain('items')
  })

  it('returns unexpected_shape on primitive', () => {
    const r = repairTodowriteInput('42')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/unexpected_shape/)
  })

  it('returns unexpected_shape on null', () => {
    const r = repairTodowriteInput('null')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/unexpected_shape/)
  })

  it('returns unexpected_shape on string', () => {
    const r = repairTodowriteInput('"plain string"')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/unexpected_shape/)
  })

  it('handles empty string input', () => {
    const r = repairTodowriteInput('')
    expect(r.didRepair).toBe(false)
    expect(r.reason).toMatch(/parse_failed/)
  })
})

describe('repairTodowriteInput — output is always valid JSON', () => {
  // Critical contract: caller assumes the returned `repaired` is parseable.
  // Failing this contract would propagate corrupted JSON into opencode TUI.
  it.each([
    REAL_BARE_ARRAY,
    '[]',
    '{"todos":[]}',
    '{"todos":[{"content":"x","status":"pending","priority":"low"}]}',
    '{"items":[]}',     // unexpected shape
    '42',               // unexpected shape (primitive)
    'null',             // unexpected shape
  ])('valid JSON output for input: %s', (input) => {
    const r = repairTodowriteInput(input)
    // Must not throw — even when repaired === input pass-through case
    expect(() => JSON.parse(r.repaired)).not.toThrow()
  })

  it('does NOT guarantee valid JSON for un-parseable input (pass-through)', () => {
    // Documented edge: parse_failed → repaired === original. Caller must
    // tolerate this; downstream schema validator will reject.
    const r = repairTodowriteInput('garbage{')
    expect(r.repaired).toBe('garbage{')
    expect(() => JSON.parse(r.repaired)).toThrow()
  })
})

describe('repairTodowriteInput — preservation of nested data', () => {
  it('preserves unicode and special characters in content', () => {
    const items = [
      { content: 'Файл: тесты + emojis 🚀', status: 'pending', priority: 'high' },
      { content: 'Quote: "test" \'apostrophe\'', status: 'pending', priority: 'low' },
    ]
    const r = repairTodowriteInput(JSON.stringify(items))
    expect(r.didRepair).toBe(true)
    expect(JSON.parse(r.repaired).todos).toEqual(items)
  })

  it('preserves arbitrary additional fields on todo items', () => {
    // Schema may allow extra fields; we should not strip them during repair.
    const items = [{ content: 'a', status: 'pending', priority: 'high', id: 'task-001', meta: { foo: 'bar' } }]
    const r = repairTodowriteInput(JSON.stringify(items))
    const out = JSON.parse(r.repaired).todos[0]
    expect(out.id).toBe('task-001')
    expect(out.meta).toEqual({ foo: 'bar' })
  })
})
