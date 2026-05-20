/**
 * Tests: claude-max-proxy/src/logger.ts — toCompactStatsUsage compact
 * shape (Phase 3.B, plan §3.4 backward-compat contract).
 *
 * Coverage:
 *   1. All TTL-split subfields present → all keys serialized
 *   2. No TTL-split subfields → only legacy keys (in, out, cacheRead,
 *      cacheWrite) appear in JSON.stringify output; new keys are OMITTED
 *      (not null, not 0) — verified by parsing the JSON line and asserting
 *      key absence via `in` operator.
 *   3. Partial subfield presence (5m only) → other keys still omitted.
 */

import { describe, test, expect } from 'bun:test'
import { toCompactStatsUsage } from '../src/logger.js'
import type { UsageEventPayload } from '../src/event-bus.js'

describe('toCompactStatsUsage: omit-when-absent contract', () => {
  test('full payload renders all keys including TTL splits + deleted', () => {
    const u: UsageEventPayload = {
      inputTokens: 1,
      outputTokens: 645,
      cacheReadInputTokens: 167731,
      cacheCreationInputTokens: 1187,
      cacheCreation5mInputTokens: 148,
      cacheCreation1hInputTokens: 1039,
      cacheDeletedInputTokens: 0,
    }
    const out = toCompactStatsUsage(u)
    expect(out).toEqual({
      in: 1,
      out: 645,
      cacheRead: 167731,
      cacheWrite: 1187,
      cacheWrite5m: 148,
      cacheWrite1h: 1039,
      cacheDeleted: 0,
    })
    // 5m + 1h must sum to aggregate cacheWrite (REQ-05 invariant)
    expect((out.cacheWrite5m ?? 0) + (out.cacheWrite1h ?? 0)).toBe(out.cacheWrite)
  })

  test('legacy payload (no subfields) renders ONLY legacy keys', () => {
    const u: UsageEventPayload = {
      inputTokens: 1,
      outputTokens: 645,
      cacheReadInputTokens: 167731,
      cacheCreationInputTokens: 1187,
    }
    const out = toCompactStatsUsage(u)
    expect(out).toEqual({
      in: 1,
      out: 645,
      cacheRead: 167731,
      cacheWrite: 1187,
    })
    // Critical: keys MUST be absent from the object (not just undefined).
    // Verify via the `in` operator + JSON round-trip — this is the actual
    // contract surface a legacy reader of claude-max-stats.jsonl sees.
    expect('cacheWrite5m' in out).toBe(false)
    expect('cacheWrite1h' in out).toBe(false)
    expect('cacheDeleted' in out).toBe(false)
    const round = JSON.parse(JSON.stringify(out))
    expect(Object.keys(round).sort()).toEqual(['cacheRead', 'cacheWrite', 'in', 'out'])
  })

  test('partial subfields: 5m only — 1h and cacheDeleted omitted', () => {
    const u: UsageEventPayload = {
      inputTokens: 1,
      outputTokens: 100,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 200,
      cacheCreation5mInputTokens: 200,
      // no 1h, no cacheDeleted
    }
    const out = toCompactStatsUsage(u)
    expect(out.cacheWrite5m).toBe(200)
    expect('cacheWrite1h' in out).toBe(false)
    expect('cacheDeleted' in out).toBe(false)
  })

  test('zero is a meaningful value — preserved when explicitly reported', () => {
    // cacheDeleted=0 is materially different from "field absent": it means
    // the response DID include cache_deleted_input_tokens (so we know the
    // server reported zero), vs the field being absent (we have no signal).
    const u: UsageEventPayload = {
      inputTokens: 1,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheDeletedInputTokens: 0,
    }
    const out = toCompactStatsUsage(u)
    expect(out.cacheDeleted).toBe(0)
    expect('cacheDeleted' in out).toBe(true)
  })
})
