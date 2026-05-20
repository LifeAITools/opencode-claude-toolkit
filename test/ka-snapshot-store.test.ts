/**
 * ka-snapshot-store — unit tests.
 *
 * The revive-vs-drop decision is the load-bearing correctness gate of the
 * KA-persistence feature: a wrong "revive" on a dead snapshot fires KA on an
 * evicted cache = a cold cache_creation write = quota burned. So `assessRevival`
 * is tested exhaustively, plus the never-throw load/save round-trip.
 */

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assessRevival,
  loadKaSnapshots,
  saveKaSnapshots,
  KA_SNAPSHOT_SCHEMA_VERSION,
  type PersistedEngineState,
  type PersistedSession,
} from '../src/ka-snapshot-store.js'

const OPTS = { safetyMarginMs: 60_000, intervalMs: 120_000, maxAgeMs: 3_600_000, fireBudgetMs: 5_000 }

function state(over: Partial<PersistedEngineState> = {}): PersistedEngineState {
  return {
    cacheWrittenAt: Date.now(),
    cacheTtlMs: 300_000,
    cacheTtlOverridden: true,
    cacheTtlObservedLocked: false,
    lastObservedTtlMs: 300_000,
    ttlEverObserved: true,
    lastKnownCacheTokensByModel: { 'claude-opus-4-7': 142_000 },
    registry: [{
      body: { model: 'claude-opus-4-7', system: 's', tools: [] },
      headers: {}, model: 'claude-opus-4-7', lineageKey: 'lin-1',
      role: 'main', inputTokens: 142_000, hasCacheControl: true,
    }],
    ...over,
  }
}

describe('assessRevival', () => {
  const now = Date.now()

  test('cache fresh with ample TTL → revive', () => {
    const v = assessRevival(state({ cacheWrittenAt: now - 10_000 }), now, OPTS)
    expect(v.revive).toBe(true)
  })

  test('cache already past cacheDiesAt → drop cache-already-dead', () => {
    // written 300s ago, ttl 300s, margin 60s → cacheDiesAt = now - 60s
    const v = assessRevival(state({ cacheWrittenAt: now - 300_000 }), now, OPTS)
    expect(v).toEqual({ revive: false, reason: 'cache-already-dead' })
  })

  test('cache alive now but dies before a KA could land → drop cache-dies-before-ka', () => {
    // written 5s ago, ttl 100s, margin 60s → cacheDiesAt = now + 35s.
    // remainingWait ≈ 103s → now + 103s + 5s ≫ now + 35s.
    const v = assessRevival(state({ cacheWrittenAt: now - 5_000, cacheTtlMs: 100_000 }), now, OPTS)
    expect(v).toEqual({ revive: false, reason: 'cache-dies-before-ka' })
  })

  test('last warm-up older than maxAge → drop too-old', () => {
    const v = assessRevival(state({ cacheWrittenAt: now - 2 * 3_600_000 }), now, OPTS)
    expect(v).toEqual({ revive: false, reason: 'too-old' })
  })

  test('empty registry → drop no-snapshot', () => {
    const v = assessRevival(state({ registry: [] }), now, OPTS)
    expect(v).toEqual({ revive: false, reason: 'no-snapshot' })
  })

  test('a wire-downlocked short TTL is honoured, not SSOT default', () => {
    // ttl downlocked to 60s; written 30s ago → cacheDiesAt = now - 30s → dead.
    // (Proves the decision uses the persisted TTL, not a longer SSOT value.)
    const v = assessRevival(
      state({ cacheWrittenAt: now - 30_000, cacheTtlMs: 60_000, cacheTtlObservedLocked: true }),
      now, OPTS,
    )
    expect(v.revive).toBe(false)
  })

  test('never throws on malformed input', () => {
    expect(() => assessRevival(null as any, now, OPTS)).not.toThrow()
    expect(assessRevival(null as any, now, OPTS).revive).toBe(false)
  })
})

describe('loadKaSnapshots / saveKaSnapshots', () => {
  function withDir<T>(fn: (dir: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'kasnap-'))
    try { return fn(dir) } finally { rmSync(dir, { recursive: true, force: true }) }
  }

  test('round-trips a session (incl. registry body) faithfully', () => {
    withDir((dir) => {
      const path = join(dir, 'ka.json')
      const sess: Record<string, PersistedSession> = {
        's1': { ...state(), sessionId: 's1', ownerPid: 4242, model: 'claude-opus-4-7' },
      }
      saveKaSnapshots(sess, path)
      const loaded = loadKaSnapshots(path)
      expect(loaded.version).toBe(KA_SNAPSHOT_SCHEMA_VERSION)
      expect(loaded.sessions.s1.ownerPid).toBe(4242)
      expect(loaded.sessions.s1.registry[0].lineageKey).toBe('lin-1')
      expect(loaded.sessions.s1.registry[0].body.model).toBe('claude-opus-4-7')
    })
  })

  test('missing file → empty, never throws', () => {
    expect(loadKaSnapshots('/no/such/ka.json').sessions).toEqual({})
  })

  test('corrupt JSON → empty', () => {
    withDir((dir) => {
      const path = join(dir, 'ka.json')
      writeFileSync(path, '{bad json')
      expect(loadKaSnapshots(path).sessions).toEqual({})
    })
  })

  test('wrong schema version → discarded', () => {
    withDir((dir) => {
      const path = join(dir, 'ka.json')
      writeFileSync(path, JSON.stringify({ version: 999, savedAt: 0, sessions: { s1: state() } }))
      expect(loadKaSnapshots(path).sessions).toEqual({})
    })
  })

  test('a half-written session entry is skipped, not fatal', () => {
    withDir((dir) => {
      const path = join(dir, 'ka.json')
      const good: PersistedSession = { ...state(), sessionId: 'g', ownerPid: 1, model: 'm' }
      writeFileSync(path, JSON.stringify({
        version: KA_SNAPSHOT_SCHEMA_VERSION, savedAt: Date.now(),
        sessions: { good, broken: { cacheWrittenAt: 'nope' } },
      }))
      const loaded = loadKaSnapshots(path)
      expect(Object.keys(loaded.sessions)).toEqual(['good'])
    })
  })
})
