/**
 * Regression tests for spawn-depth and concurrency enforcement in
 * `checkSpawnAllowed`.
 *
 * Background: prior to 2026-05-08, `checkSpawnAllowed` returned depth in
 * its result but never actually enforced it — only concurrency was gated.
 * A role-based agent at depth >= maxSpawnDepth would still be allowed to
 * spawn, enabling unbounded recursion. The "helper" path (no role identity)
 * did enforce depth via __MAX_HELPER_DEPTH env var, but that check lives
 * in plugin.ts:handlePreToolUseSpawnCheck, not in checkSpawnAllowed itself.
 *
 * This test pins the contract for both axes (depth + concurrency) and
 * the priority order (depth checked FIRST — more fundamental violation).
 *
 * See: PRPs/spawn-depth-enforcement/01-analysis.md §"Bug 1"
 */

import { describe, expect, it } from 'bun:test'
import { checkSpawnAllowed } from './wake-listener'
import type { AgentIdentity } from './wake-types'

// ─── Helpers ────────────────────────────────────────────────────────

function makeIdentity(opts: {
  maxSpawnDepth?: number
  maxSubagents?: number
  maxConcurrent?: number
  roleName?: string
} = {}): AgentIdentity {
  const identity: any = {
    memberId: 'test-member-id',
    name: 'test-agent',
    roleName: opts.roleName ?? 'developer',
    budget: {
      maxSpawnDepth: opts.maxSpawnDepth ?? 2,
      maxSubagents: opts.maxSubagents ?? 5,
    },
  }
  if (opts.maxConcurrent !== undefined) identity._maxConcurrent = opts.maxConcurrent
  return identity as AgentIdentity
}

// ─── Depth enforcement ──────────────────────────────────────────────

describe('checkSpawnAllowed — depth axis', () => {
  it('allows spawn when currentDepth < maxSpawnDepth', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 2 }), 0, 0)
    expect(result.allowed).toBe(true)
    expect(result.depth).toBe(0)
    expect(result.maxDepth).toBe(2)
  })

  it('allows spawn at depth 1 with maxSpawnDepth 2', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 2 }), 1, 0)
    expect(result.allowed).toBe(true)
  })

  it('BLOCKS spawn when currentDepth === maxSpawnDepth', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 1 }), 1, 0)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Лимит глубины делегирования')
    expect(result.reason).toContain('depth 1/1')
  })

  it('BLOCKS spawn when currentDepth > maxSpawnDepth', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 1 }), 2, 0)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('depth 2/1')
  })

  it('depth-block reason includes role name', () => {
    const result = checkSpawnAllowed(
      makeIdentity({ maxSpawnDepth: 1, roleName: 'orchestrator' }), 1, 0,
    )
    expect(result.reason).toContain("'orchestrator'")
  })

  it('depth-block reason includes child-depth math (current+1)', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 2 }), 2, 0)
    expect(result.allowed).toBe(false)
    // Block at depth=2 → child would be depth 3
    expect(result.reason).toContain('child at depth 3')
  })

  it('depth-block reason advises HALT for orchestrator escalation', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 1 }), 1, 0)
    expect(result.reason).toContain('HALT: scope-too-large')
  })

  it('uses default budget when identity.budget absent', () => {
    const identity: AgentIdentity = {
      memberId: 'test',
      name: 'test',
      roleName: 'unknown',
    } as any
    const result = checkSpawnAllowed(identity, 0, 0)
    // Default budget is maxSpawnDepth=2, maxSubagents=5
    expect(result.allowed).toBe(true)
    expect(result.maxDepth).toBe(2)
    expect(result.maxConcurrent).toBe(5)
  })
})

// ─── Concurrency enforcement ────────────────────────────────────────

describe('checkSpawnAllowed — concurrency axis', () => {
  it('allows spawn when activeHelpers < maxConcurrent', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSubagents: 5 }), 0, 3)
    expect(result.allowed).toBe(true)
    expect(result.active).toBe(3)
    expect(result.maxConcurrent).toBe(5)
  })

  it('BLOCKS spawn when activeHelpers === maxConcurrent', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSubagents: 5 }), 0, 5)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Лимит одновременных хелперов')
    expect(result.reason).toContain('5/5')
  })

  it('BLOCKS spawn when activeHelpers > maxConcurrent', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSubagents: 3 }), 0, 7)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('7/3')
  })

  it('honors _maxConcurrent metadata override', () => {
    // _maxConcurrent (from metadata.maxConcurrentHelpers) overrides budget.maxSubagents
    const result = checkSpawnAllowed(
      makeIdentity({ maxSubagents: 5, maxConcurrent: 2 }), 0, 2,
    )
    expect(result.allowed).toBe(false)
    expect(result.maxConcurrent).toBe(2)
    expect(result.reason).toContain('2/2')
  })

  it('concurrency-block reason advises SynqTask delegation', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSubagents: 1 }), 0, 1)
    expect(result.reason).toContain('SynqTask')
    expect(result.reason).toContain('todo_tasks')
  })
})

// ─── Priority: depth wins over concurrency ──────────────────────────

describe('checkSpawnAllowed — depth checked BEFORE concurrency', () => {
  it('reports DEPTH violation when both depth and concurrency exceeded', () => {
    // Both violated: depth 2/1 AND active 7/5
    const result = checkSpawnAllowed(
      makeIdentity({ maxSpawnDepth: 1, maxSubagents: 5 }), 2, 7,
    )
    expect(result.allowed).toBe(false)
    // Depth message takes priority — more fundamental violation
    expect(result.reason).toContain('Лимит глубины')
    expect(result.reason).not.toContain('Лимит одновременных')
  })

  it('reports CONCURRENCY violation when only concurrency exceeded', () => {
    const result = checkSpawnAllowed(
      makeIdentity({ maxSpawnDepth: 5, maxSubagents: 2 }), 0, 2,
    )
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('Лимит одновременных')
    expect(result.reason).not.toContain('Лимит глубины')
  })
})

// ─── Result shape contract ──────────────────────────────────────────

describe('checkSpawnAllowed — result shape', () => {
  it('returns full metric set even when allowed', () => {
    const result = checkSpawnAllowed(makeIdentity(), 0, 0)
    expect(result).toMatchObject({
      allowed: true,
      depth: 0,
      maxDepth: 2,
      active: 0,
      maxConcurrent: 5,
    })
    expect(result.reason).toBeUndefined()
  })

  it('returns full metric set with reason when blocked by depth', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 1 }), 1, 0)
    expect(result).toMatchObject({
      allowed: false,
      depth: 1,
      maxDepth: 1,
      active: 0,
      maxConcurrent: 5,
    })
    expect(typeof result.reason).toBe('string')
    expect(result.reason!.length).toBeGreaterThan(0)
  })

  it('returns full metric set with reason when blocked by concurrency', () => {
    const result = checkSpawnAllowed(makeIdentity({ maxSubagents: 1 }), 0, 1)
    expect(result).toMatchObject({
      allowed: false,
      depth: 0,
      maxDepth: 2,
      active: 1,
      maxConcurrent: 1,
    })
  })
})

// ─── Multi-session same-dir scenarios (documentation-as-tests) ─────

/**
 * These tests don't exercise process-level isolation directly (that's
 * a runtime concern), but pin the EXPECTED behavior of checkSpawnAllowed
 * given per-session inputs, demonstrating that the function is correct
 * for multi-TUI same-dir scenarios as long as caller provides per-session
 * `currentDepth` and per-process `activeHelpers`.
 */
describe('checkSpawnAllowed — multi-session correctness (documented behavior)', () => {
  it('TUI A and TUI B (same dir) get independent depth verdicts', () => {
    // TUI A is at depth 0 in its lineage
    const a = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 2 }), 0, 0)
    // TUI B happens to be at depth 1 in its (different) lineage
    const b = checkSpawnAllowed(makeIdentity({ maxSpawnDepth: 2 }), 1, 0)
    // Both allowed (each within own limits)
    expect(a.allowed).toBe(true)
    expect(b.allowed).toBe(true)
    // depth field reflects each session's true depth — independent
    expect(a.depth).toBe(0)
    expect(b.depth).toBe(1)
  })

  it('per-process activeHelpers count: A and B counted independently in their own processes', () => {
    // Process P_A has its own _activeHelperTimestamps; activeHelpers comes
    // from getSpawnActive() at the call site. Test simulates that:
    //   In P_A: 5 active helpers spawned by A → blocks 6th from A
    //   In P_B: 0 active helpers → B can spawn freely
    const aBlocked = checkSpawnAllowed(makeIdentity({ maxSubagents: 5 }), 0, 5)
    const bAllowed = checkSpawnAllowed(makeIdentity({ maxSubagents: 5 }), 0, 0)
    expect(aBlocked.allowed).toBe(false)
    expect(bAllowed.allowed).toBe(true)
  })
})
