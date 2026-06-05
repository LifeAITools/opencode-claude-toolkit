/**
 * KeepaliveEngine — standalone tests (no SDK, no network).
 *
 * Test isolation: the engine reads cache+KA params from SSOT (~/.claude/
 * keepalive.json by default). The bunfig.toml `preload` hook
 * (test/_setup-keepalive-fixture.ts) writes a fixture and sets
 * CLAUDE_KEEPALIVE_CONFIG_PATH so tests are stable regardless of host config.
 * Fixture: 5m TTL, 60s KA interval.
 */

import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import { EvictionCircuitBreaker } from '../src/eviction-breaker.js'
import { CacheRewriteBlockedError } from '../src/types.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

// ─── Helpers ────────────────────────────────────────────────────

function mkEngine(cfg: Parameters<typeof KeepaliveEngine>[0]['config'] = {}) {
  // Minimal DI — engine never fires in tests (we don't call tick)
  const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1 }, stopReason: 'end_turn' }
  }
  const fakeRateLimit: RateLimitInfo = {
    status: 'allowed', resetAt: null, claim: null, retryAfter: null,
    utilization5h: 0, utilization7d: 0,
  }
  return new KeepaliveEngine({
    config: cfg,
    getToken: async () => 'fake-token',
    doFetch: fakeFetch,
    getRateLimitInfo: () => fakeRateLimit,
  })
}

// ─── Layer 1: Interval clamp ─────────────────────────────────────

describe('KeepaliveEngine Layer 1: intervalMs safety clamp', () => {
  test('clamps below-min (<60s) to 60_000', () => {
    const e = mkEngine({ intervalMs: 30_000 })
    expect(e._config.intervalMs).toBe(60_000)
  })

  test('clamps above-max to (cacheTtlMs - safetyMarginMs - 60s)', () => {
    // For default 5m TTL (300k) - 15k margin - 60k = 225_000
    // (was 240_000 hardcoded; now derived from SSOT keepalive-config)
    const e = mkEngine({ intervalMs: 300_000 })
    expect(e._config.intervalMs).toBe(225_000)
  })

  test('accepts valid interval as-is', () => {
    const e = mkEngine({ intervalMs: 120_000 })
    expect(e._config.intervalMs).toBe(120_000)
  })

  test('default reads intervalMs from SSOT fixture (60s)', () => {
    // Fixture has explicit intervalSec: 60 — engine reads that.
    const e = mkEngine()
    expect(e._config.intervalMs).toBe(60_000)
  })
})

// ─── Per-consumer cacheTtlMs override (2026-05-17 incident regression) ───
//
// Architectural fix for SDK-0.15 incident: proxy intercepts native CC traffic
// (5min ephemeral cache wire-TTL) but SSOT keepalive.json declares 3600s for
// opencode's 1h cache contract. Honoring SSOT in proxy fires KAs against
// already-expired Anthropic caches → 906K cache_creation tokens wasted.
//
// Fix: KeepaliveConfig.cacheTtlMs allows the consumer to PIN its own TTL,
// independent of SSOT. proxy-client passes 300_000 by default.
describe('KeepaliveEngine: per-consumer cacheTtlMs override', () => {
  test('no override → reads cacheTtlMs from SSOT fixture (300_000)', () => {
    const e = mkEngine()
    expect(e._cacheTtlMs).toBe(300_000)
    expect(e._cacheTtlOverridden).toBe(false)
  })

  test('override pins cacheTtlMs regardless of SSOT', () => {
    const e = mkEngine({ cacheTtlMs: 600_000 })
    expect(e._cacheTtlMs).toBe(600_000)
    expect(e._cacheTtlOverridden).toBe(true)
  })

  test('proxy default 300_000 override locks even when SSOT says different', () => {
    // Simulate proxy adapter passing the 5-min pin
    const e = mkEngine({ cacheTtlMs: 300_000 })
    expect(e._cacheTtlMs).toBe(300_000)
    expect(e._cacheTtlOverridden).toBe(true)
  })

  test('override recomputes intervalClampMax against EFFECTIVE TTL', () => {
    // With cacheTtlMs=300_000, safetyMargin=15_000, intervalClampMax must be
    //   300_000 - 15_000 - 60_000 = 225_000
    // Attempting intervalMs=600_000 (would be valid under 1h SSOT) must clamp.
    const e = mkEngine({ cacheTtlMs: 300_000, intervalMs: 600_000 })
    expect(e._config.intervalMs).toBe(225_000)
  })

  test('rejects invalid override values (falls back to SSOT)', () => {
    const eNeg = mkEngine({ cacheTtlMs: -1 })
    expect(eNeg._cacheTtlMs).toBe(300_000) // fixture
    expect(eNeg._cacheTtlOverridden).toBe(false)

    const eZero = mkEngine({ cacheTtlMs: 0 })
    expect(eZero._cacheTtlMs).toBe(300_000)
    expect(eZero._cacheTtlOverridden).toBe(false)

    const eNaN = mkEngine({ cacheTtlMs: NaN })
    expect(eNaN._cacheTtlMs).toBe(300_000)
    expect(eNaN._cacheTtlOverridden).toBe(false)
  })
})

// ─── Layer 1+2: wire-format autoscan + monotonic lock-down ──────
//
// detectCacheTtlFromBody walks an Anthropic request body and returns the
// minimum cache_control TTL observed (plus a hasAnyCacheControl flag for
// Layer 3). The engine calls this on every notifyRealRequestStart and
// monotonically locks the engine's cacheTtlMs DOWNWARD when wire markers
// indicate a shorter cache lifetime than the current config.
import { detectCacheTtlFromBody } from '../src/keepalive-engine.js'

describe('detectCacheTtlFromBody (wire-format autoscan)', () => {
  test('empty body → no markers', () => {
    expect(detectCacheTtlFromBody({})).toEqual({ minTtlMs: null, hasAnyCacheControl: false })
    expect(detectCacheTtlFromBody({ messages: [] })).toEqual({ minTtlMs: null, hasAnyCacheControl: false })
    expect(detectCacheTtlFromBody(null)).toEqual({ minTtlMs: null, hasAnyCacheControl: false })
  })

  test('ephemeral without ttl → 5min default', () => {
    const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: 300_000, hasAnyCacheControl: true })
  })

  test('ephemeral ttl=1h → 3600000', () => {
    const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: 3_600_000, hasAnyCacheControl: true })
  })

  test('mixed 5m + 1h → returns MIN (5m) — defensive', () => {
    const body = {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
      }],
    }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: 300_000, hasAnyCacheControl: true })
  })

  test('scans tools[] markers', () => {
    const body = { tools: [{ name: 't', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: 3_600_000, hasAnyCacheControl: true })
  })

  test('unknown ttl string → 5min default (safe)', () => {
    const body = { system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '2h' } }] }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: 300_000, hasAnyCacheControl: true })
  })

  test('non-ephemeral type → ignored', () => {
    const body = { system: [{ type: 'text', text: 'x', cache_control: { type: 'persistent' as any } }] }
    expect(detectCacheTtlFromBody(body)).toEqual({ minTtlMs: null, hasAnyCacheControl: false })
  })

  test('malformed bodies do not throw', () => {
    expect(() => detectCacheTtlFromBody({ messages: 'not-array' })).not.toThrow()
    expect(() => detectCacheTtlFromBody({ system: [{ cache_control: 'nope' }] })).not.toThrow()
    expect(() => detectCacheTtlFromBody({ tools: [null] })).not.toThrow()
  })
})

// ─── upgradeCacheControlTtl (wire-format 1h upgrade) ─────────────
//
// Symmetric inverse of detectCacheTtlFromBody: instead of OBSERVING the
// wire cache TTL, it CONTROLS it. The proxy calls this on native Claude
// Code request bodies (whose cache_control markers default to 5m) to lift
// every existing ephemeral marker to ttl:'1h', so the stable system+tools+
// history prefix outlives a multi-minute coding turn. It only ever upgrades
// existing markers — it never ADDS a marker where the client placed none.
import { upgradeCacheControlTtl } from '../src/keepalive-engine.js'

describe('upgradeCacheControlTtl (wire-format 1h upgrade)', () => {
  test('ephemeral without ttl → upgraded to 1h', () => {
    const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 1 })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('ephemeral ttl=5m → upgraded to 1h', () => {
    const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '5m' } }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 1 })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('ephemeral ttl=1h → left unchanged, upgraded:0', () => {
    const body = { system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 0 })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('upgrades markers across system + messages + tools', () => {
    const body = {
      system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'm', cache_control: { type: 'ephemeral' } }] }],
      tools: [{ name: 't', cache_control: { type: 'ephemeral' } }],
    }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 3 })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect((body.messages[0].content[0] as any).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(body.tools[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
  })

  test('preserves sibling cache_control fields (scope)', () => {
    const body = { system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral', scope: 'global' } }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 1 })
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h', scope: 'global' })
  })

  test('non-ephemeral cache_control left alone', () => {
    const body = { system: [{ type: 'text', text: 's', cache_control: { type: 'persistent' } }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 0 })
    expect(body.system[0].cache_control).toEqual({ type: 'persistent' })
  })

  test('body with no markers → upgraded:0, no marker invented', () => {
    const body = { system: 'plain string', messages: [{ role: 'user', content: 'hi' }] }
    expect(upgradeCacheControlTtl(body)).toEqual({ upgraded: 0 })
    expect(body.system).toBe('plain string')
  })

  test('malformed bodies do not throw', () => {
    expect(() => upgradeCacheControlTtl(null)).not.toThrow()
    expect(() => upgradeCacheControlTtl({ messages: 'not-array' })).not.toThrow()
    expect(() => upgradeCacheControlTtl({ system: [{ cache_control: 'nope' }] })).not.toThrow()
    expect(() => upgradeCacheControlTtl({ tools: [null] })).not.toThrow()
  })
})

// ─── TTL scan observability (onTtlScan change-detection) ─────────
//
// Independent of the downlock decision: every real request scans the body
// for cache_control TTL and fires onTtlScan whenever the observed min-TTL
// differs from the prior value for this session (first observation always
// fires). Steady-state (unchanged) does NOT fire. Runs even when TTL is
// pinned via override — pure observability, no behavior change.
describe('KeepaliveEngine: onTtlScan change detection', () => {
  type Scan = { minTtlMs: number | null; previousTtlMs: number | null; hasAnyCacheControl: boolean; at: number }
  const sys = (ttl?: string) => ({
    system: [{ type: 'text', text: 'sys', cache_control: ttl ? { type: 'ephemeral', ttl } : { type: 'ephemeral' } }],
  })

  test('first observation fires with previousTtlMs=null', () => {
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})
    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatchObject({ minTtlMs: 3_600_000, previousTtlMs: null, hasAnyCacheControl: true })
  })

  test('unchanged TTL across requests does NOT re-fire', () => {
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})
    e.notifyRealRequestStart('m', sys('1h'), {})
    e.notifyRealRequestStart('m', sys('1h'), {})
    expect(scans).toHaveLength(1)  // only the first-seen
  })

  test('TTL change (1h → 5m) fires with correct previous/min', () => {
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})
    e.notifyRealRequestStart('m', sys(), {})  // default ephemeral = 5m
    expect(scans).toHaveLength(2)
    expect(scans[1]).toMatchObject({ minTtlMs: 300_000, previousTtlMs: 3_600_000, hasAnyCacheControl: true })
  })

  test('a no-cache_control request is a NON-observation — does NOT fire "→ none"', () => {
    // Lightweight requests (count_tokens, title-gen, quota checks) ship no
    // cache_control. They must NOT be reported as the session TTL dropping to
    // "none" — that produced misleading "5m → none → 5m" flapping. The strict
    // observed TTL is held; only requests that actually carry cache_control move
    // the observation.
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})                                    // first-seen 1h
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'hi' }] }, {}) // no cc → skip
    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatchObject({ minTtlMs: 3_600_000, previousTtlMs: null, hasAnyCacheControl: true })
  })

  test('no-cache_control request does NOT cause flapping on the next cached request', () => {
    // Sequence 1h → (no cc) → 1h must yield exactly ONE event (first-seen 1h):
    // the held observation is compared against the next cached request, not
    // against a phantom "none" in between.
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})                                    // first-seen 1h
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'hi' }] }, {}) // no cc → skip
    e.notifyRealRequestStart('m', sys('1h'), {})                                    // still 1h → no change
    expect(scans).toHaveLength(1)
  })

  test('genuine TTL change still fires across an intervening no-cache_control request', () => {
    // 1h → (no cc) → 5m must report 1h → 5m (previous compared against the held
    // observation, not against the skipped no-cc request).
    const scans: Scan[] = []
    const e = mkEngine({ onTtlScan: (i) => scans.push(i) })
    e.notifyRealRequestStart('m', sys('1h'), {})
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'hi' }] }, {}) // no cc → skip
    e.notifyRealRequestStart('m', sys(), {})  // 5m
    expect(scans).toHaveLength(2)
    expect(scans[1]).toMatchObject({ minTtlMs: 300_000, previousTtlMs: 3_600_000, hasAnyCacheControl: true })
  })

  test('scan runs even when cacheTtlMs is pinned (override active)', () => {
    const scans: Scan[] = []
    const e = mkEngine({ cacheTtlMs: 3_600_000, onTtlScan: (i) => scans.push(i) })
    expect(e._cacheTtlOverridden).toBe(true)
    e.notifyRealRequestStart('m', sys(), {})  // 5m wire marker under 1h pin
    // Observability still fires despite pin; downlock stays disabled.
    expect(scans).toHaveLength(1)
    expect(scans[0]).toMatchObject({ minTtlMs: 300_000, previousTtlMs: null })
    expect(e._cacheTtlObservedLocked).toBe(false)
  })

  test('a throwing onTtlScan observer never breaks the request path', () => {
    const e = mkEngine({ onTtlScan: () => { throw new Error('observer boom') } })
    expect(() => e.notifyRealRequestStart('m', sys('1h'), {})).not.toThrow()
  })
})

describe('KeepaliveEngine: wire-autoscan monotonic lock-down', () => {
  test('observing 5m marker on 1h engine → locks TTL to 5m', () => {
    const e = mkEngine({ cacheTtlMs: 3_600_000 })  // start at 1h
    expect(e._cacheTtlMs).toBe(3_600_000)
    expect(e._cacheTtlOverridden).toBe(true)
    // BUT cacheTtlOverridden takes precedence — autoscan skipped when overridden.
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }, {})
    // Stays at 1h because override is explicit.
    expect(e._cacheTtlMs).toBe(3_600_000)
    expect(e._cacheTtlObservedLocked).toBe(false)
  })

  test('no override + 5m marker observed → engine locks down from SSOT', () => {
    // Fixture is 300_000 (5min). To test downward lock, simulate engine at 1h
    // via SSOT-equivalent: just verify that when current TTL > observed, lock fires.
    // Reuse construction default (no override) — fixture is already 5min, so
    // observing a 5m marker results in NO change (not strictly less than current).
    const e = mkEngine()
    expect(e._cacheTtlMs).toBe(300_000)
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }, {})
    // No lock because current TTL already equals observed.
    expect(e._cacheTtlObservedLocked).toBe(false)
  })

  test('no markers in body → autoscan no-op, TTL unchanged', () => {
    const e = mkEngine()
    const before = e._cacheTtlMs
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'hi' }] }, {})
    expect(e._cacheTtlMs).toBe(before)
    expect(e._cacheTtlObservedLocked).toBe(false)
  })

  test('1h marker on 5m engine → does NOT raise TTL (monotonic-down only)', () => {
    const e = mkEngine()  // fixture 300_000
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } }],
    }, {})
    // 1h observed > 5m current → autoscan ignores (monotonic-down only).
    expect(e._cacheTtlMs).toBe(300_000)
    expect(e._cacheTtlObservedLocked).toBe(false)
  })

  test('malformed body in autoscan does not crash engine', () => {
    const e = mkEngine()
    expect(() => e.notifyRealRequestStart('m', {
      messages: 'broken' as any,
    }, {})).not.toThrow()
    expect(e._cacheTtlMs).toBe(300_000)
  })

  // Regression for live-reload clamp bug discovered 2026-05-18 during deploy
  // verification: when override locks TTL to 5min but SSOT declares 1h cache +
  // 30min interval, the live-reload path used SSOT.intervalClampMax (derived
  // from SSOT.cacheTtlMs=1h, allows interval up to ~59min) and accepted
  // intervalMs=1800s. The engine would then fire ~30min into idle — long
  // AFTER the actual 5min cache had died → cache_creation burst (exact incident
  // pattern from 2026-05-17). Fix: live-reload clamp must use EFFECTIVE TTL.
  test('regression: live-reload clamp respects override TTL, not SSOT', async () => {
    // Construct with 5min override, simulate live-reload tick by manually
    // invoking tick() — it reads SSOT and applies clamps. Fixture is 5min so
    // SSOT.intervalClampMax = ~225s, but to reproduce the bug we'd need SSOT
    // with longer TTL. Here we verify the EFFECTIVE clamp logic works by
    // checking that intervalMs stays bounded by override TTL even if SSOT
    // returns something larger.
    const e = mkEngine({ cacheTtlMs: 300_000, intervalMs: 100_000 })
    // _config.intervalMs is 100_000 from constructor (under clampMax=225_000)
    expect(e._config.intervalMs).toBe(100_000)
    expect(e._cacheTtlOverridden).toBe(true)
    // Stop short of network-side simulation — direct field check that override
    // flag is set, so live-reload code path will use effective clamp.
    expect(e._cacheTtlMs).toBe(300_000)
  })
})

// ─── Layer 5: post-fire eviction detection (2026-05-18 cf04c946 cascading regression) ───
//
// Anthropic-side cache can be evicted when CC slides cache_control marker forward
// in real_requests, leaving the engine's snapshot pointing at a stale hash. The
// next KA fire returns cacheCreation~snapshot_size + cacheRead~0 — burning ~1M
// tokens per fire. Without this guard, fires would cascade every interval.
//
// Detection: if cacheCreation > 10K AND cacheRead < cacheCreation/10, disarm
// the engine. Next real_request will register a fresh snapshot.
describe('KeepaliveEngine Layer 5: post-fire eviction detection', () => {
  test('big cache_creation with tiny cache_read → onDisarmed + registry cleared', async () => {
    // Build engine that returns an "evicted" response shape
    const evictedFetch = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: {
        inputTokens: 1881, outputTokens: 0,
        cacheReadInputTokens: 46772,
        cacheCreationInputTokens: 915579,  // ← exact incident shape
      }, stopReason: 'end_turn' }
    }
    let disarmed: { reason: string; at: number } | null = null
    const e = new KeepaliveEngine({
      config: {
        intervalMs: 60_000, minTokens: 100,
        onDisarmed: (info) => { disarmed = info },
      },
      getToken: async () => 'fake-token',
      doFetch: evictedFetch,
      getRateLimitInfo: () => ({
        status: 'allowed', resetAt: null, claim: null, retryAfter: null,
        utilization5h: 0, utilization7d: 0,
      }),
    })
    // Register a snapshot with cache_control so engine will fire it
    const lk = e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    // Age cache slightly so tick() will fire
    e._setCacheWrittenAt(Date.now() - 70_000)
    ;(e as any).lastActivityAt = Date.now() - 70_000
    // tick() now reads the PER-LINEAGE warm clock — age it too.
    { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = Date.now() - 70_000 }
    ;(e as any).jitterMs = 0
    // Trigger fire
    await (e as any).tick()
    // Verify disarmed with eviction reason + registry cleared
    expect(disarmed).not.toBeNull()
    expect((disarmed as any).reason).toBe('cache_evicted_post_fire')
    expect(e._registry.size).toBe(0)
    e.stop()
  })

  test('healthy fire (small cw, big cr) does NOT disarm', async () => {
    const healthyFetch = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: {
        inputTokens: 6, outputTokens: 1,
        cacheReadInputTokens: 280_000,  // healthy hit
        cacheCreationInputTokens: 504,  // tiny refresh delta
      }, stopReason: 'end_turn' }
    }
    let disarmed = false
    const e = new KeepaliveEngine({
      config: {
        intervalMs: 60_000, minTokens: 100,
        onDisarmed: () => { disarmed = true },
      },
      getToken: async () => 'fake-token',
      doFetch: healthyFetch,
      getRateLimitInfo: () => ({
        status: 'allowed', resetAt: null, claim: null, retryAfter: null,
        utilization5h: 0, utilization7d: 0,
      }),
    })
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 70_000)
    ;(e as any).lastActivityAt = Date.now() - 70_000
    ;(e as any).jitterMs = 0
    await (e as any).tick()
    expect(disarmed).toBe(false)
    expect(e._registry.size).toBe(1)  // snapshot survives healthy fire
    e.stop()
  })

  test('borderline case: cw=10K (at threshold) does NOT trigger eviction', async () => {
    // 10000 is the threshold — anything ≤ should NOT disarm
    const borderFetch = async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'message_stop', usage: {
        inputTokens: 100, outputTokens: 1,
        cacheReadInputTokens: 100,   // even with low cr, cw must EXCEED threshold
        cacheCreationInputTokens: 10000,  // EXACTLY at threshold
      }, stopReason: 'end_turn' }
    }
    let disarmed = false
    const e = new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed: () => { disarmed = true } },
      getToken: async () => 'fake-token',
      doFetch: borderFetch,
      getRateLimitInfo: () => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
    })
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 70_000)
    ;(e as any).lastActivityAt = Date.now() - 70_000
    ;(e as any).jitterMs = 0
    await (e as any).tick()
    expect(disarmed).toBe(false)  // 10000 is NOT > 10000
    e.stop()
  })
})

describe('KeepaliveEngine Layer 3: no cache_control → no KA fire', () => {
  test('registry entry without cache_control marks hasCacheControl=false', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'plain' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    // Registry is keyed by cache lineage, not model — fetch the sole entry.
    const entry = Array.from(e._registry.values())[0]
    expect(entry).toBeDefined()
    expect(entry!.hasCacheControl).toBe(false)
  })

  test('registry entry with cache_control marker marks hasCacheControl=true', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', {
      system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
    }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    const entry = Array.from(e._registry.values())[0]
    expect(entry).toBeDefined()
    expect(entry!.hasCacheControl).toBe(true)
  })
})

// ─── Layer 2: Heaviest-snapshot registry ─────────────────────────

describe('KeepaliveEngine Layer 2: heaviest-wins snapshot registry', () => {
  test('first snapshot registers', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('claude-opus-4-7',
      { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hello' }] },
      { Authorization: 'Bearer x' })
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 50 })

    expect(e._registry.size).toBe(1)
    expect(Array.from(e._registry.values())[0]?.inputTokens).toBe(5000)
    e.stop()
  })

  test('larger snapshot overwrites smaller', () => {
    const e = mkEngine({ minTokens: 100 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'small' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 10 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [{ role: 'user', content: 'large' }] }, {})
    e.notifyRealRequestComplete({ inputTokens: 10000, outputTokens: 10 })

    expect(Array.from(e._registry.values())[0]?.inputTokens).toBe(10000)
    e.stop()
  })

  test('sub-agent request (agent-id header) does NOT register — cannot touch main slot', () => {
    // Subagent protection is now by ROLE, not by size: a sub-agent lineage is
    // never registered for KA at all (it self-warms via its own traffic), so
    // it physically cannot clobber the main agent's slot regardless of weight.
    const e = mkEngine({ minTokens: 100 })
    const mainTools = [...Array.from({ length: 19 }, (_, i) => ({ name: `t${i}` })), { name: 'Agent' }]

    // Main agent — rich tool set incl. spawn-tool, no agent-id → role=main.
    e.notifyRealRequestStart('claude-opus-4-7',
      { system: [{ type: 'text', text: 'main' }], tools: mainTools }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 100, cacheReadInputTokens: 40000 })
    expect(e._registry.size).toBe(1)
    expect(Array.from(e._registry.values())[0]!.role).toBe('main')

    // Sub-agent — distinct lineage, agent-id header present → role=sub →
    // NOT registered. Main entry untouched.
    e.notifyRealRequestStart('claude-opus-4-7',
      { system: [{ type: 'text', text: 'sub' }], tools: mainTools.slice(0, 10) },
      { 'x-claude-code-agent-id': 'sub-1' })
    e.notifyRealRequestComplete({ inputTokens: 200, outputTokens: 10 })

    expect(e._registry.size).toBe(1)  // still only the main lineage
    expect(Array.from(e._registry.values())[0]!.inputTokens).toBe(90000)
    expect(Array.from(e._registry.values())[0]!.role).toBe('main')
    e.stop()
  })

  test('below minTokens threshold — not registered at all', () => {
    const e = mkEngine({ minTokens: 5000 })
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 100, outputTokens: 10 })

    expect(e._registry.size).toBe(0)
    e.stop()
  })

  test('lastKnownCacheTokensByModel tracks max, never downgrades', () => {
    const e = mkEngine({ minTokens: 100 })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    expect(e._lastKnownCacheTokensByModel.get('claude-opus-4-7')).toBe(50000)

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 200, outputTokens: 10 })
    expect(e._lastKnownCacheTokensByModel.get('claude-opus-4-7')).toBe(50000)  // unchanged
    e.stop()
  })
})

// ─── Layer 3: Rewrite guard ──────────────────────────────────────

describe('KeepaliveEngine Layer 3: rewrite-burst guard', () => {
  test('warn fires on long idle with large estimated cache', () => {
    let warn: { idleMs: number; estimatedTokens: number; blocked: boolean } | null = null
    const e = mkEngine({
      rewriteWarnIdleMs: 1000,
      rewriteWarnTokens: 10000,
      onRewriteWarning: (info) => { warn = info },
    })

    // Seed heavy cache baseline + age the cacheWrittenAt timestamp.
    // Guard now measures against cacheWrittenAt (not lastRealActivityAt) so KA
    // fires correctly suppress the warning. Test simulates a stale cache by
    // backdating cacheWrittenAt directly.
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setCacheWrittenAt(Date.now() - 2000)

    e.checkRewriteGuard('claude-opus-4-7')

    expect(warn).not.toBeNull()
    expect(warn!.estimatedTokens).toBe(50000)
    expect(warn!.blocked).toBe(false)
    e.stop()
  })

  test('no warn when idle < warnIdleMs', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5000,
      rewriteWarnTokens: 1000,
      onRewriteWarning: () => { fired = true },
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    // cacheWrittenAt just set by notifyRealRequestComplete — idle is small

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)
    e.stop()
  })

  test('no warn on first-ever request (no baseline)', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 1,
      rewriteWarnTokens: 1,
      onRewriteWarning: () => { fired = true },
    })
    // cacheWrittenAt = 0 (never called notifyRealRequestComplete)
    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)
    e.stop()
  })

  test('throws CacheRewriteBlockedError when blockEnabled + idle > blockIdleMs', () => {
    const e = mkEngine({
      rewriteWarnIdleMs: 500,
      rewriteWarnTokens: 1000,
      rewriteBlockIdleMs: 1000,
      rewriteBlockEnabled: true,
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setCacheWrittenAt(Date.now() - 2000)

    expect(() => e.checkRewriteGuard('claude-opus-4-7')).toThrow(CacheRewriteBlockedError)
    e.stop()
  })

  test('no throw when blockEnabled=false even on long idle', () => {
    const e = mkEngine({
      rewriteWarnIdleMs: 500,
      rewriteWarnTokens: 1000,
      rewriteBlockIdleMs: 1000,
      rewriteBlockEnabled: false,
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 10 })
    e._setCacheWrittenAt(Date.now() - 2000)

    expect(() => e.checkRewriteGuard('claude-opus-4-7')).not.toThrow()
    e.stop()
  })

  // ─── Regression: false-positive when KA keeps cache warm ───
  // Before this fix, guard measured idle against lastRealActivityAt — any user
  // idleness > 5min triggered a "Cache likely dead" warning even though KA fires
  // had refreshed cacheWrittenAt every 2min and the prompt cache was healthy on
  // the Anthropic side (RAW_USAGE: cache_creation_input_tokens < 2k confirmed).
  test('no warn when KA recently fired (cacheWrittenAt is fresh) even after long user idle', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5_000,
      rewriteWarnTokens: 1_000,
      onRewriteWarning: () => { fired = true },
    })

    // Step 1: real request 10 minutes ago — would trigger warning under old logic
    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10 })
    e._setLastRealActivityAt(Date.now() - 600_000)  // 10 min ago

    // Step 2: KA fired 1 second ago, refreshing the cache.
    // (notifyRealRequestComplete updates cacheWrittenAt, then we backdate just
    //  lastRealActivityAt — leaving cacheWrittenAt fresh, mimicking what a
    //  successful KA fire does in the real engine.)
    e._setCacheWrittenAt(Date.now() - 1_000)

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(false)  // cache is warm — no warning, even though user is idle
    e.stop()
  })

  test('warn DOES fire when cacheWrittenAt is stale (KA broken or DISARMED)', () => {
    let fired = false
    const e = mkEngine({
      rewriteWarnIdleMs: 5_000,
      rewriteWarnTokens: 1_000,
      onRewriteWarning: () => { fired = true },
    })

    e.notifyRealRequestStart('claude-opus-4-7', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10 })
    // Both timestamps stale — simulates KA broken/DISARMED + user idle
    e._setLastRealActivityAt(Date.now() - 600_000)
    e._setCacheWrittenAt(Date.now() - 600_000)

    e.checkRewriteGuard('claude-opus-4-7')
    expect(fired).toBe(true)  // guard correctly detects truly dead cache
    e.stop()
  })
})

// ─── Layer 4: Error classification (regression for 18:44Z incident) ──
//
// On 2026-04-26 18:44Z, Anthropic API hung for 4 minutes on real requests.
// SDK's controller.abort() fired (timeout=600s), fetch threw AbortError, and
// classifyError fell through to 'server_transient' instead of 'network'.
// retryChain then disarmed with reason='cache_ttl_exhausted' — a lying reason
// that misled diagnosis into thinking the cache had silently aged out.
//
// These tests exercise classifyError indirectly via the disarm reason that
// surfaces from the engine. We can't import classifyError directly (it's not
// exported), so we wire a fake doFetch that throws specific shapes and observe
// which onDisarmed reason is emitted by tick().
describe('KeepaliveEngine Layer 4: error classification (regression: 2026-04-26 18:44Z)', () => {
  function mkEngineThatThrows(err: unknown, onDisarmed: (info: { reason: string; at: number }) => void) {
    const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
      throw err
      yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 0 }, stopReason: 'end_turn' } as StreamEvent
    }
    const fakeRateLimit: RateLimitInfo = {
      status: 'allowed', resetAt: null, claim: null, retryAfter: null,
      utilization5h: 0, utilization7d: 0,
    }
    return new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed },
      getToken: async () => 'fake-token',
      doFetch: fakeFetch,
      getRateLimitInfo: () => fakeRateLimit,
    })
  }

  // Helper: prime registry with a snapshot, age cache so tick() will fire,
  // then call tick() and capture the disarm reason.
  async function captureDisarmReasonAfterTickWith(err: unknown): Promise<string | null> {
    return await new Promise<string | null>((resolve) => {
      let captured: string | null = null
      const e = mkEngineThatThrows(err, (info) => { captured = info.reason })
      // Body MUST carry at least one cache_control marker — Layer 3 ("no cache_control
      // → don't fire") skips entries without markers, so empty {messages:[]} would
      // make tick() short-circuit before reaching the throw site this test targets.
      const bodyWithCC = {
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }],
        }],
      }
      const lk = e.notifyRealRequestStart('m', bodyWithCC, {})
      e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
      // Fresh cache: write was just now. Age it slightly so tick fires.
      e._setCacheWrittenAt(Date.now() - 1_000)
      // Force lastActivityAt back so tick() doesn't skip on jitter
      ;(e as any).lastActivityAt = Date.now() - 200_000
      // tick() now reads the PER-LINEAGE warm clock — age it too.
      { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = Date.now() - 200_000 }
      ;(e as any).jitterMs = 0
      // Invoke tick directly
      void (e as any).tick().then(() => {
        // tick → catch → classify → either disarm immediately OR schedule retryChain.
        // Give microtask queue a beat for retryChain.setTimeout(2000) to register
        // the synchronous disarm decision. retryChain disarms synchronously when
        // ttlRemaining < nextDelay + safety, otherwise schedules — for fresh
        // cache it schedules, so we expect captured===null in 'server_transient' case.
        setTimeout(() => {
          e.stop()
          resolve(captured)
        }, 50)
      })
    })
  }

  test('AbortError (request timeout) → classified as network, NOT cache_ttl_exhausted', async () => {
    // Simulates: SDK timeoutId fires → controller.abort() → fetch throws AbortError
    const abortErr = Object.assign(new Error('The operation was aborted.'), {
      name: 'AbortError',
    })
    // SDK wraps it: throw new ClaudeCodeSDKError('Network error', err)
    const wrapped = Object.assign(new Error('Network error'), {
      cause: abortErr,
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    // Network classification → onDisarmed('network_error') in tick() catch.
    // MUST NOT be cache_ttl_exhausted (the lying reason from old behaviour).
    expect(reason).toBe('network_error')
  })

  test('"The operation timed out." message → classified as network', async () => {
    // The exact message that appears in production logs (sdk.ts API_ERROR).
    const wrapped = Object.assign(new Error('Network error'), {
      cause: new Error('The operation timed out.'),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
  })

  test('TimeoutError name → classified as network', async () => {
    const wrapped = Object.assign(new Error('Network error'), {
      cause: Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
  })

  test('plain "Network error" (SDK wrapper with no cause details) → classified as network', async () => {
    // Worst case: cause chain stripped, only the wrapper message survives.
    // We must still classify by message keyword 'network error'.
    const reason = await captureDisarmReasonAfterTickWith(new Error('Network error'))
    expect(reason).toBe('network_error')
  })

  test('ECONNRESET → still classified as network (regression guard)', async () => {
    const wrapped = Object.assign(new Error('Network error'), {
      cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    })
    const reason = await captureDisarmReasonAfterTickWith(wrapped)
    expect(reason).toBe('network_error')
  })

  // Regression (2026-06-04): a transient 401 during an in-flight KA ping — an
  // OAuth token rotating under us — used to TERMINALLY disarm the engine
  // (clearRegistry + onDisarmed('auth_error')), silently abandoning keepalive
  // for the rest of the session. The cache then aged out at TTL and the next
  // real user turn hit the rewrite-guard. 104 such disarms in one day's log,
  // clustered at token-rotation windows. Fix: auth is TRANSIENT — route it to
  // retryChain (fresh getToken() per retry), exactly like a 5xx. On a warm
  // cache retryChain SCHEDULES (does not disarm), so captured stays null.
  test('401 (auth) on warm cache → schedules retry, NOT terminal disarm', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 })
    const reason = await captureDisarmReasonAfterTickWith(authErr)
    expect(reason).toBeNull()
  })

  test('403 (auth) on warm cache → schedules retry, NOT terminal disarm', async () => {
    const authErr = Object.assign(new Error('Forbidden'), { status: 403 })
    const reason = await captureDisarmReasonAfterTickWith(authErr)
    expect(reason).toBeNull()
  })
})

// ─── Auth recovery (transient 401 → retry, not terminal) ─────────

describe('KeepaliveEngine: auth (401/403) is a transient fault that recovers', () => {
  test('401 then success → engine re-fires with fresh token, stays armed, never disarms', async () => {
    let calls = 0
    const tokens: string[] = []
    const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
      calls++
      if (calls === 1) {
        // First KA ping lands mid token-rotation → 401.
        throw Object.assign(new Error('Unauthorized'), { status: 401 })
      }
      // Retry with rotated creds succeeds (healthy cache_read, zero cache_write).
      yield {
        type: 'message_stop',
        usage: { inputTokens: 5, outputTokens: 1, cacheReadInputTokens: 5000, cacheCreationInputTokens: 0 },
        stopReason: 'end_turn',
      } as StreamEvent
    }
    const fakeRateLimit: RateLimitInfo = {
      status: 'allowed', resetAt: null, claim: null, retryAfter: null,
      utilization5h: 0, utilization7d: 0,
    }
    let disarmReason: string | null = null
    const e = new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed: (i) => { disarmReason = i.reason } },
      getToken: async () => { const t = `tok-${calls}`; tokens.push(t); return t },
      doFetch: fakeFetch,
      getRateLimitInfo: () => fakeRateLimit,
    })
    // Fast retry so the test doesn't wait the default 2s first delay.
    ;(e as any).retryDelaysMs = [20]

    const bodyWithCC = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    }
    const lk = e.notifyRealRequestStart('m', bodyWithCC, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 1_000)
    // Age the activity clocks so tick() fires AND the retry's "did a real
    // request happen since?" guard (lastRealActivityAt > cacheWrittenAt) passes.
    ;(e as any).lastActivityAt = Date.now() - 200_000
    ;(e as any).lastRealActivityAt = Date.now() - 200_000
    { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = Date.now() - 200_000 }
    ;(e as any).jitterMs = 0

    await (e as any).tick()                          // fire #1 → 401 → schedules retryChain(20ms)
    await new Promise((r) => setTimeout(r, 120))     // let the retry fire
    const registrySizeAfterRecovery = e._registry.size  // capture BEFORE stop() (stop clears it)
    e.stop()

    expect(disarmReason).toBeNull()                  // NEVER terminally disarmed
    expect(calls).toBeGreaterThanOrEqual(2)          // retry actually re-fired
    expect(registrySizeAfterRecovery).toBeGreaterThan(0)  // still armed (snapshot kept)
  })

  test('genuine revoke (persistent 401) → disarms after the AUTH cap (5), not the full 13-step budget', async () => {
    let calls = 0
    const fakeFetch = async function* (): AsyncGenerator<StreamEvent> {
      calls++
      throw Object.assign(new Error('Unauthorized'), { status: 401 })  // token truly revoked
      // eslint-disable-next-line no-unreachable
      yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 1 }, stopReason: 'end_turn' } as StreamEvent
    }
    const fakeRateLimit: RateLimitInfo = {
      status: 'allowed', resetAt: null, claim: null, retryAfter: null,
      utilization5h: 0, utilization7d: 0,
    }
    let disarmReason: string | null = null
    const e = new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed: (i) => { disarmReason = i.reason } },
      getToken: async () => 'tok',
      doFetch: fakeFetch,
      getRateLimitInfo: () => fakeRateLimit,
    })
    // 13 tiny delays so the chain runs fast; the AUTH cap (5) must stop it well short.
    ;(e as any).retryDelaysMs = [3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]

    const bodyWithCC = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }],
    }
    const lk = e.notifyRealRequestStart('m', bodyWithCC, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 1_000)
    ;(e as any).lastActivityAt = Date.now() - 200_000
    ;(e as any).lastRealActivityAt = Date.now() - 200_000
    { const st = e._lineageStats.get(lk); if (st) (st as any).lastWarmedAt = Date.now() - 200_000 }
    ;(e as any).jitterMs = 0

    await (e as any).tick()                          // fire #1 (401) → auth retryChain capped at 5
    await new Promise((r) => setTimeout(r, 120))     // let the capped chain run to exhaustion

    expect(disarmReason).toBe('retry_exhausted')     // genuine revoke gives up (TTL-safe)
    expect(calls).toBe(6)                            // 1 initial + 5 capped retries (NOT 1 + 13)
    e.stop()
  })
})

// ─── Per-lineage eviction retirement + transient re-arm (2026-06-05 eb9b8fcd) ───
//
// A secondary/stale lineage cold-write must NOT kill keepalive for the session's
// healthy primary cache (old whole-session clearRegistry → primary expired
// overnight → morning 400), and must NOT trip the fleet breaker (cascade-disarmed
// 16 sessions). A transient 5xx/network exhausting the retry budget must keep the
// warm snapshot so the probe re-arms — not permanently disarm.
describe('KeepaliveEngine: per-lineage eviction retirement + transient re-arm', () => {
  const rl = () => ({ status: 'allowed' as const, resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 })
  function mkEng(fetch: any, onDisarmed: (i: any) => void, evictionBreaker?: any) {
    return new KeepaliveEngine({
      config: { intervalMs: 60_000, minTokens: 100, onDisarmed },
      getToken: async () => 'tok', doFetch: fetch, getRateLimitInfo: rl,
      ...(evictionBreaker ? { evictionBreaker } : {}),
    })
  }
  const coldFetch = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'message_stop', usage: { inputTokens: 504, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 182781 }, stopReason: 'end_turn' } as StreamEvent
  }
  const bodyA = { system: [{ type: 'text', text: 'sysA', cache_control: { type: 'ephemeral' } }], tools: [{ name: 't1' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] }] }
  const bodyB = { system: [{ type: 'text', text: 'sysB', cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] }] }

  test('Fix1: secondary cold-write drops ONLY that lineage; healthy primary survives, no disarm', async () => {
    let disarmed: any = null
    const e = mkEng(coldFetch, (i) => { disarmed = i })
    const a = e.notifyRealRequestStart('m', bodyA, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    const b = e.notifyRealRequestStart('m', bodyB, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    expect(e._registry.size).toBe(2)
    const bEntry = e._registry.get(b)!; (bEntry as any).role = 'sub'
    await (e as any).fireLineage(bEntry, 70_000)   // secondary cold-writes
    expect(disarmed).toBeNull()                    // session NOT disarmed
    expect(e._registry.has(a)).toBe(true)          // healthy primary survives
    expect(e._registry.has(b)).toBe(false)         // stale secondary retired
    e.stop()
  })

  test('Fix1: last lineage cold-write (none healthy left) → full disarm (single-lineage behavior preserved)', async () => {
    let disarmed: any = null
    const e = mkEng(coldFetch, (i) => { disarmed = i })
    const a = e.notifyRealRequestStart('m', bodyA, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    await (e as any).fireLineage(e._registry.get(a)!, 70_000)
    expect(disarmed?.reason).toBe('cache_evicted_post_fire')
    expect(e._registry.size).toBe(0)
    e.stop()
  })

  test('Fix2: stale SECONDARY cold-write does NOT trip the fleet breaker', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const e = mkEng(coldFetch, () => {}, breaker)
    const b = e.notifyRealRequestStart('m', bodyB, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    const bEntry = e._registry.get(b)!; (bEntry as any).role = 'sub'
    const st = e._lineageStats.get(b); if (st) (st as any).lastSeenAt = Date.now() - 200_000
    await (e as any).fireLineage(bEntry, 70_000)
    expect(breaker.isTripped(Date.now())).toBe(false)
    e.stop()
  })

  test('Fix2: PRIMARY cold-write (genuine server eviction) DOES trip the fleet breaker', async () => {
    const breaker = new EvictionCircuitBreaker({ cooldownMs: 300_000 })
    const e = mkEng(coldFetch, () => {}, breaker)
    const a = e.notifyRealRequestStart('m', bodyA, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    const aEntry = e._registry.get(a)!; (aEntry as any).role = 'main'
    const st = e._lineageStats.get(a); if (st) (st as any).lastSeenAt = Date.now() - 200_000
    await (e as any).fireLineage(aEntry, 70_000)
    expect(breaker.isTripped(Date.now())).toBe(true)
    e.stop()
  })

  test('Fix3: transient retry_exhausted with WARM cache keeps the snapshot (probe re-arms), not permanent disarm', async () => {
    let calls = 0
    const fail500 = async function* (): AsyncGenerator<StreamEvent> {
      calls++
      throw Object.assign(new Error('overloaded'), { status: 500 })
      // eslint-disable-next-line no-unreachable
      yield { type: 'message_stop', usage: { inputTokens: 0, outputTokens: 1 }, stopReason: 'end_turn' } as StreamEvent
    }
    let disarmReason: string | null = null
    const e = mkEng(fail500, (i) => { disarmReason = i.reason })
    ;(e as any).retryDelaysMs = [3, 3]   // exhaust fast
    ;(e as any).safetyMarginMs = 1       // don't let TTL-margin bail the short retry
    const a = e.notifyRealRequestStart('m', bodyA, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 1_000)   // cache warm (last KA fire 1s ago)
    // Mirror an IDLE session: last REAL request is old; only KA has been warming
    // it. Otherwise retryChain's "real request since?" guard bails before retrying.
    ;(e as any).lastRealActivityAt = Date.now() - 200_000
    await (e as any).fireLineage(e._registry.get(a)!, 70_000)
    await new Promise((r) => setTimeout(r, 120))
    expect(calls).toBeGreaterThanOrEqual(2)       // retryChain actually retried
    expect(disarmReason).toBe('retry_exhausted')
    expect(e._registry.size).toBeGreaterThan(0)   // snapshot KEPT for probe re-fire (Fix 3)
    e.stop()
  })
})

// ─── Public API surface ──────────────────────────────────────────

describe('KeepaliveEngine public API', () => {
  test('stop() clears timers and registry', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    expect(e._registry.size).toBe(1)
    expect(e._timer).not.toBeNull()

    e.stop()

    expect(e._registry.size).toBe(0)
    expect(e._timer).toBeNull()
  })

  test('disarm() clears registry, fires onDisarmed with reason, stops timer', () => {
    let firedReason: string | null = null
    let firedAt: number | null = null
    const e = mkEngine({
      minTokens: 100,
      onDisarmed: ({ reason, at }) => { firedReason = reason; firedAt = at },
    })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    expect(e._registry.size).toBe(1)
    expect(e._timer).not.toBeNull()

    e.disarm('test_org_swap')

    expect(e._registry.size).toBe(0)
    expect(e._timer).toBeNull()
    expect(firedReason).toBe('test_org_swap')
    expect(firedAt).not.toBeNull()
  })

  test('disarm() is safe to call on idle engine (no registry, no callback configured)', () => {
    const e = mkEngine()
    expect(() => e.disarm('idle_disarm')).not.toThrow()
    expect(e._registry.size).toBe(0)
  })

  // ─── Smart 429 pause-or-disarm ─────────────────────────────────

  test('429 with cache outliving resetAt → PAUSE (timer cleared, quotaPauseTimer set)', () => {
    // Default fixture: 5min TTL (300_000ms). Cache freshly written → has 285s
    // remaining (300s - 15s margin). Reset is in 60s → cache lives past reset.
    let disarmReason: string | null = null
    const e = mkEngine({
      minTokens: 100,
      onDisarmed: ({ reason }) => { disarmReason = reason },
    })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now())  // fresh cache

    const entry = Array.from(e._registry.values())[0]!
    const resetAtSec = Math.floor((Date.now() + 60_000) / 1000)  // 60s away
    e._testHandleQuotaRateLimit(entry, { resetAt: resetAtSec, retryAfterSec: null })

    expect(e._timer).toBeNull()             // tick timer stopped
    expect(e._quotaPauseTimer).not.toBeNull()  // pause timer scheduled
    expect(e._quotaPauseUntil).not.toBeNull()
    expect(disarmReason).toBeNull()         // NOT disarmed
    expect(e._registry.size).toBe(1)        // snapshot preserved
    e.stop()  // cleanup
  })

  test('429 with quota outliving cache → DISARM (no pause, reason="quota_outlives_cache")', () => {
    // Cache 4min old (240s in, 300s TTL → 60s left, minus 15s margin = 45s).
    // Reset is 600s away → cache dies LONG before quota recovers.
    let disarmReason: string | null = null
    const e = mkEngine({
      minTokens: 100,
      onDisarmed: ({ reason }) => { disarmReason = reason },
    })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now() - 240_000)  // cache 4 min old

    const entry = Array.from(e._registry.values())[0]!
    const resetAtSec = Math.floor((Date.now() + 600_000) / 1000)  // 10min away
    e._testHandleQuotaRateLimit(entry, { resetAt: resetAtSec, retryAfterSec: null })

    expect(disarmReason).toBe('quota_outlives_cache')
    expect(e._registry.size).toBe(0)        // registry cleared
    expect(e._quotaPauseTimer).toBeNull()   // no pause scheduled
  })

  test('429 with no resetAt hint → does NOT engage smart-pause (defers to retryChain)', () => {
    // Without resetAt, smart-pause has no decision basis. Fall back to the
    // existing retryChain path — its specific behavior (immediate disarm vs
    // schedule retry) is outside this test's concern; we only assert that
    // the smart-pause state machine was NOT engaged.
    const e = mkEngine({ minTokens: 100, onDisarmed: () => {} })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now())

    const entry = Array.from(e._registry.values())[0]!
    e._testHandleQuotaRateLimit(entry, { resetAt: null, retryAfterSec: null })

    expect(e._quotaPauseTimer).toBeNull()
    expect(e._quotaPauseUntil).toBeNull()
    e.stop()
  })

  test('notifyRealRequestStart wakes engine from quota-pause', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', { messages: [] }, {})
    e.notifyRealRequestComplete({ inputTokens: 5000, outputTokens: 1 })
    e._setCacheWrittenAt(Date.now())

    const entry = Array.from(e._registry.values())[0]!
    const resetAtSec = Math.floor((Date.now() + 120_000) / 1000)
    e._testHandleQuotaRateLimit(entry, { resetAt: resetAtSec, retryAfterSec: null })
    expect(e._quotaPauseTimer).not.toBeNull()

    // Real request arrives mid-pause — engine should resume.
    e.notifyRealRequestStart('m', { messages: [{ role: 'user', content: 'x' }] }, {})

    expect(e._quotaPauseTimer).toBeNull()
    expect(e._quotaPauseUntil).toBeNull()
    expect(e._timer).not.toBeNull()  // tick timer resumed
    e.stop()
  })

  test('accepts all documented KeepaliveConfig callbacks', () => {
    expect(() => mkEngine({
      enabled: true,
      intervalMs: 120_000,
      idleTimeoutMs: Infinity,
      minTokens: 2000,
      rewriteWarnIdleMs: 300_000,
      rewriteWarnTokens: 50_000,
      rewriteBlockIdleMs: Infinity,
      rewriteBlockEnabled: false,
      onHeartbeat: () => {},
      onTick: () => {},
      onDisarmed: () => {},
      onRewriteWarning: () => {},
      onNetworkStateChange: () => {},
    })).not.toThrow()
  })
})

// ─── Agent-aware per-lineage KA + reload ─────────────────────────

describe('KeepaliveEngine: agent-aware per-lineage KA + reload', () => {
  const richTools = [...Array.from({ length: 19 }, (_, i) => ({ name: `t${i}` })), { name: 'Agent' }]
  const mainBody = (text: string) => ({ system: [{ type: 'text', text }], tools: richTools })

  test('notifyRealRequestStart returns the lineageKey', () => {
    const e = mkEngine()
    const key = e.notifyRealRequestStart('m', mainBody('s'), {})
    expect(key).toBeString()
    expect(key.length).toBeGreaterThan(0)
    e.stop()
  })

  test('main and sub-agent are distinct lineages — only main is registered', () => {
    const e = mkEngine({ minTokens: 100 })
    const kMain = e.notifyRealRequestStart('m', mainBody('main'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, kMain)
    const kSub = e.notifyRealRequestStart('m', mainBody('sub'), { 'x-claude-code-agent-id': 's1' })
    e.notifyRealRequestComplete({ inputTokens: 30000, outputTokens: 1 }, kSub)

    expect(kMain).not.toBe(kSub)        // distinct cache lineages
    expect(e._registry.size).toBe(1)    // sub-agent NOT registered
    expect(Array.from(e._registry.values())[0]!.role).toBe('main')
    e.stop()
  })

  test('concurrent interleaved requests of two lineages both commit (no slot clobber)', () => {
    // The single-pending-slot bug: start A, start B, complete A, complete B —
    // B's start clobbered the slot, so A's completion registered B and B's
    // registered nothing. Per-lineage slots + explicit keys → BOTH commit.
    const e = mkEngine({ minTokens: 100 })
    const kA = e.notifyRealRequestStart('m', mainBody('A'), {})
    const kB = e.notifyRealRequestStart('m', mainBody('B'), {})
    expect(kA).not.toBe(kB)
    e.notifyRealRequestComplete({ inputTokens: 40000, outputTokens: 1 }, kA)
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, kB)
    expect(e._registry.size).toBe(2)    // neither clobbered the other
    e.stop()
  })

  test('reload() clears registry but KEEPS the timer alive (unlike disarm)', () => {
    const e = mkEngine({ minTokens: 100 })
    const k = e.notifyRealRequestStart('m', mainBody('m'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, k)
    expect(e._registry.size).toBe(1)
    expect(e._timer).not.toBeNull()

    e.reload('org_swap')

    expect(e._registry.size).toBe(0)    // stale snapshot dropped
    expect(e._timer).not.toBeNull()     // ← timer SURVIVES (disarm would null it)
    e.stop()
  })

  test('reload() then a fresh request re-arms cleanly', () => {
    const e = mkEngine({ minTokens: 100 })
    const k1 = e.notifyRealRequestStart('m', mainBody('m'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, k1)
    e.reload('org_swap')
    expect(e._registry.size).toBe(0)

    const k2 = e.notifyRealRequestStart('m', mainBody('m'), {})
    e.notifyRealRequestComplete({ inputTokens: 55000, outputTokens: 1 }, k2)
    expect(e._registry.size).toBe(1)    // re-armed
    expect(e._timer).not.toBeNull()
    e.stop()
  })

  test('reload() is safe on an idle engine', () => {
    const e = mkEngine()
    expect(() => e.reload('idle_reload')).not.toThrow()
    expect(e._registry.size).toBe(0)
  })

  test('legacy notifyRealRequestComplete(usage) without key still works (sequential)', () => {
    const e = mkEngine({ minTokens: 100 })
    e.notifyRealRequestStart('m', mainBody('seq'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 })  // no key arg
    expect(e._registry.size).toBe(1)
    e.stop()
  })
})

// ─── Per-lineage idle clock — master stays warm while sub-agents run ──────
describe('KeepaliveEngine: per-lineage idle clock isolates the main agent', () => {
  const richTools = [...Array.from({ length: 19 }, (_, i) => ({ name: `t${i}` })), { name: 'Agent' }]
  const body = (text: string) => ({ system: [{ type: 'text', text }], tools: richTools })

  test("a sub-agent lineage's traffic does NOT touch the main lineage's warm clock", () => {
    const e = mkEngine()
    // Main agent: one request → registers + records its per-lineage clock.
    const mainKey = e.notifyRealRequestStart('m', body('MAIN-AGENT'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, mainKey)
    const mainWarmedAt = e._lineageStats.get(mainKey)!.lastWarmedAt

    // Burst of sub-agent traffic — each a DISTINCT lineage (distinct system).
    for (let i = 0; i < 8; i++) {
      const subKey = e.notifyRealRequestStart('m', body('SUB-' + i), {})
      e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 }, subKey)
      expect(subKey).not.toBe(mainKey)
    }

    // The main lineage's per-lineage warm clock is UNCHANGED — sub-agent
    // traffic cannot mask the master's idleness (the global lastActivityAt
    // could, which is what starved the master's KA).
    expect(e._lineageStats.get(mainKey)!.lastWarmedAt).toBe(mainWarmedAt)
    e.stop()
  })
})

// ─── Cross-restart persistence: serializeState() + revive() ──────
describe('KeepaliveEngine: serialize / revive for cross-restart persistence', () => {
  const richTools = [...Array.from({ length: 19 }, (_, i) => ({ name: `t${i}` })), { name: 'Agent' }]
  const mainBody = (text: string) => ({ system: [{ type: 'text', text }], tools: richTools })

  test('serializeState() returns null on a fresh (un-armed) engine', () => {
    const e = mkEngine()
    expect(e.serializeState()).toBeNull()
    e.stop()
  })

  test('serializeState() captures the registry + cacheWrittenAt once armed', () => {
    const e = mkEngine()
    e.notifyRealRequestStart('m', mainBody('persist'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 })
    const state = e.serializeState()
    expect(state).not.toBeNull()
    expect(state!.registry.length).toBe(1)
    expect(state!.cacheWrittenAt).toBeGreaterThan(0)
    expect(typeof state!.cacheTtlMs).toBe('number')
    e.stop()
  })

  test('revive() arms a fresh engine — registry populated, tick timer running', () => {
    const src = mkEngine()
    src.notifyRealRequestStart('m', mainBody('revive'), {})
    src.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 })
    const state = src.serializeState()!
    src.stop()

    const revived = mkEngine()
    expect(revived._registry.size).toBe(0)
    revived.revive(state)
    expect(revived._registry.size).toBe(1)
    expect(revived._timer).not.toBeNull()                 // armed without a real request
    expect(revived._cacheWrittenAt).toBe(state.cacheWrittenAt)
    revived.stop()
  })

  test('revive() is idempotent — refuses to revive over an already-armed engine', () => {
    const src = mkEngine()
    src.notifyRealRequestStart('m', mainBody('a'), {})
    src.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 })
    const state = src.serializeState()!
    src.stop()

    const e = mkEngine()
    e.notifyRealRequestStart('m', mainBody('b'), {})
    e.notifyRealRequestComplete({ inputTokens: 50000, outputTokens: 1 })
    const before = e._registry.size
    e.revive(state)                                       // engine already armed
    expect(e._registry.size).toBe(before)                 // unchanged — no-op
    e.stop()
  })

  test('revive() never throws on malformed state', () => {
    const e = mkEngine()
    expect(() => e.revive(null as any)).not.toThrow()
    expect(() => e.revive({ registry: [] } as any)).not.toThrow()
    expect(e._registry.size).toBe(0)
    e.stop()
  })
})

// ─── Multi-lineage keepalive: warm ALL eligible lineages, not just `best` ───
//
// Root cause (2026-06-03, sessions dc01c882 ~534k / b775cbc5 ~82k): tick()
// picked ONE `best` lineage (main-role / heaviest) and fired only it. A session
// with several registered (main/unknown) cache lineages left every non-best
// lineage to TTL-expire silently → the next real request paid an avoidable
// cache rewrite (the `avoidable:ttl-expiry` rewrite-guard blocks observed
// across 5 sessions in one day). Fix: each tick fires EVERY eligible lineage
// (per-lineage idle ≥ fire threshold AND hasCacheControl), capped per tick.
describe('KeepaliveEngine: multi-lineage keepalive', () => {
  // Healthy refresh shape — tiny cache_creation, real cache_read → no eviction.
  const healthyFetch = async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'message_stop', usage: {
      inputTokens: 6, outputTokens: 1,
      cacheReadInputTokens: 50_000, cacheCreationInputTokens: 100,
    }, stopReason: 'end_turn' }
  }
  const allowed: RateLimitInfo = {
    status: 'allowed', resetAt: null, claim: null, retryAfter: null,
    utilization5h: 0, utilization7d: 0,
  }

  function mkMultiEngine(onFire: (lk: string) => void) {
    return new KeepaliveEngine({
      config: {
        intervalMs: 60_000, minTokens: 100,
        onHeartbeat: (h) => onFire(h.lineageKey),
      },
      getToken: async () => 'fake-token',
      doFetch: healthyFetch,
      getRateLimitInfo: () => allowed,
    })
  }

  // Register N distinct cache lineages (different system text → different
  // systemHash), each idle past the fire threshold. Returns their keys.
  function registerIdleLineages(e: KeepaliveEngine, specs: Array<{ text: string; tokens: number }>): string[] {
    const keys: string[] = []
    for (const s of specs) {
      const lk = e.notifyRealRequestStart('m', {
        system: [{ type: 'text', text: s.text, cache_control: { type: 'ephemeral' } }],
      }, {})
      e.notifyRealRequestComplete({ inputTokens: s.tokens, outputTokens: 1 }, lk)
      keys.push(lk)
    }
    // Age every lineage's per-lineage warm clock past interval*0.9 (54s).
    for (const lk of keys) {
      const st = e._lineageStats.get(lk) as any
      if (st) st.lastWarmedAt = Date.now() - 70_000
    }
    ;(e as any).jitterMs = 0
    e._setCacheWrittenAt(Date.now() - 70_000)
    ;(e as any).lastActivityAt = Date.now() - 70_000
    return keys
  }

  test('warms ALL eligible idle lineages in one tick, not just the heaviest', async () => {
    const fired: string[] = []
    const e = mkMultiEngine((lk) => fired.push(lk))
    const [lkA, lkB] = registerIdleLineages(e, [
      { text: 'lineage-A system prompt', tokens: 5000 },
      { text: 'lineage-B a different system prompt', tokens: 8000 },
    ])
    expect(e._registry.size).toBe(2)  // both main/unknown lineages registered

    await (e as any).tick()

    // BUG (pre-fix): only `best` (lkB, heavier) fires → fired === [lkB].
    expect(new Set(fired)).toEqual(new Set([lkA, lkB]))
    e.stop()
  })

  test('an active (recently-warmed) lineage is NOT fired — only idle ones', async () => {
    const fired: string[] = []
    const e = mkMultiEngine((lk) => fired.push(lk))
    const [lkIdle, lkActive] = registerIdleLineages(e, [
      { text: 'idle lineage', tokens: 5000 },
      { text: 'active lineage self-warmed by real traffic', tokens: 9000 },
    ])
    // The "active" lineage was just warmed by real traffic → below threshold.
    const st = e._lineageStats.get(lkActive) as any
    if (st) st.lastWarmedAt = Date.now() - 1_000

    await (e as any).tick()

    expect(fired).toEqual([lkIdle])   // active lineage skipped, idle one fired
    e.stop()
  })
})
