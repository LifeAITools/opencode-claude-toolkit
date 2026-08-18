/**
 * Every keepalive fire that STARTS must announce exactly one outcome.
 *
 * 🔴 Why this exists. Until 2026-08-19 the engine announced only SUCCESS
 * (`onHeartbeat` → KA_FIRE_COMPLETE). A fire that failed was handled in full —
 * classified, retried, quota-paused, disarmed — and left NOTHING in the event
 * stream. Measured that day over a full day's proxy log: 363 KA_FIRE_COMPLETE
 * and not one record of an attempt that did not complete.
 *
 * That is the same failures-only blindness that made the request_id question
 * unanswerable in the real-request path, only mirrored: there we recorded only
 * failures and had no control group; here we recorded only successes and could
 * not see failures at all. Both produce a reading that cannot be wrong because
 * nothing can contradict it.
 *
 * It matters beyond tidiness: what the quota-reset storms ARE is still open —
 * the fleet's keepalive, or the fleet resuming. Counting only successful fires
 * answers "keepalive was quiet" even in the world where every fire was failing.
 *
 * Fixture (bunfig preload): 5m TTL, 60s interval.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = () => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
})

type Seen = {
  starts: Array<{ lineageKey: string; idleMs: number }>
  errors: Array<{ status: number | null; category: string; message: string }>
  completes: number
}

function mkEngine(fail: { status?: number; message?: string } | null) {
  const seen: Seen = { starts: [], errors: [], completes: 0 }
  const e = new KeepaliveEngine({
    config: {
      onFireStart: (i) => { seen.starts.push({ lineageKey: i.lineageKey, idleMs: i.idleMs }) },
      onFireError: (i) => { seen.errors.push({ status: i.status, category: i.category, message: i.message }) },
      onHeartbeat: () => { seen.completes++ },
    },
    getToken: async () => 'fake-token',
    doFetch: async function* (): AsyncGenerator<StreamEvent> {
      if (fail) {
        const err: any = new Error(fail.message ?? 'upstream said no')
        if (fail.status !== undefined) err.status = fail.status
        throw err
      }
      yield {
        type: 'message_stop',
        usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 },
        stopReason: 'end_turn',
      } as StreamEvent
    },
    getRateLimitInfo: (): RateLimitInfo => ({
      status: 'allowed', resetAt: null, claim: null, retryAfter: null,
      utilization5h: 0, utilization7d: 0,
    }),
  })
  return { e, seen }
}

/** Arm a lineage and age its clocks so the very next tick fires it. */
function armAndAge(e: KeepaliveEngine): string {
  const key = e.notifyRealRequestStart('claude-opus-4-7', sys(), {})
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  e._setCacheWrittenAt(Date.now() - 70_000)
  ;(e as any).lastActivityAt = Date.now() - 70_000
  { const st = e._lineageStats.get(key); if (st) (st as any).lastWarmedAt = Date.now() - 70_000 }
  ;(e as any).jitterMs = 0
  return key
}

describe('keepalive fire — outcome invariant', () => {
  test('a fire that SUCCEEDS is announced as started, then completed', async () => {
    const { e, seen } = mkEngine(null)
    const key = armAndAge(e)
    await e._tick()

    expect(seen.starts.length).toBe(1)
    expect(seen.starts[0]!.lineageKey).toBe(key)
    expect(seen.completes).toBe(1)
    expect(seen.errors.length).toBe(0)
  })

  test('a fire that FAILS is announced too — this is the half that was missing', async () => {
    // 529 Overloaded: the exact shape that vanished silently all through the
    // 2026-08-18 storm, while the log showed only the fires that worked.
    const { e, seen } = mkEngine({ status: 529, message: 'Overloaded' })
    const key = armAndAge(e)
    await e._tick()

    expect(seen.starts.length).toBe(1)
    expect(seen.errors.length).toBe(1)
    expect(seen.errors[0]!.status).toBe(529)
    expect(seen.errors[0]!.message).toContain('Overloaded')
    // The engine's own classification travels with it, so an analysis can tell
    // an upstream wobble from a dead link without re-parsing the message.
    expect(seen.errors[0]!.category.length).toBeGreaterThan(0)
    expect(seen.completes).toBe(0)
    expect(seen.starts[0]!.lineageKey).toBe(key)
  })

  test('a quota refusal counts as an outcome, not as silence', async () => {
    // 429 takes a different branch inside the engine (smart-pause, not retry).
    // The announcement must not depend on which branch handled it — otherwise
    // the quota case, the one that matters most at a reset, stays invisible.
    const { e, seen } = mkEngine({ status: 429, message: 'rate_limit_error' })
    armAndAge(e)
    await e._tick()

    expect(seen.starts.length).toBe(1)
    expect(seen.errors.length).toBe(1)
    expect(seen.errors[0]!.status).toBe(429)
    expect(seen.completes).toBe(0)
  })

  test('no fire is ever left without an outcome', async () => {
    for (const fail of [null, { status: 529 }, { status: 429 }, { status: 401 }, { message: 'fetch failed' }]) {
      const { e, seen } = mkEngine(fail as any)
      armAndAge(e)
      await e._tick()
      expect(seen.starts.length).toBe(1)
      expect(seen.completes + seen.errors.length).toBe(1)
    }
  })
})
