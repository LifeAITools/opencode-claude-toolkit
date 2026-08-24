/**
 * The proxy declares a storm itself, and the declaration carries the split that
 * settles what the storm was made of.
 *
 * Two failures these tests are here to catch, both lived through on 2026-08-19:
 * a watch so sensitive that a single refusal after six quiet hours counts as a
 * storm, and a watch that announces nothing at all while everyone believes it
 * is standing.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { bus, emit } from '../src/event-bus.js'
import { startStormWatch, _stormState } from '../src/storm-watch.js'

let stop: (() => void) | null = null
let seen: any[] = []
let offBegan: (() => void) | null = null
let offEnded: (() => void) | null = null

function arm() {
  seen = []
  offBegan = bus.onKind('UPSTREAM_STORM_BEGAN' as never, (e: any) => seen.push(e))
  offEnded = bus.onKind('UPSTREAM_STORM_ENDED' as never, (e: any) => seen.push(e))
  stop = startStormWatch()
}

afterEach(() => {
  try { stop?.() } catch { /* already stopped */ }
  try { offBegan?.() } catch { /* already off */ }
  try { offEnded?.() } catch { /* already off */ }
  stop = null; offBegan = null; offEnded = null
})

/** Default spreads across sessions — a storm is many sessions, and most tests
 *  are about the count, not the breadth. Pass a fixed id to test breadth. */
let seq = 0
const refuse = (kind: 'REAL_REQUEST_ERROR' | 'KA_FIRE_ERROR', status: number, sessionId?: string) =>
  emit({ level: 'error', kind, sessionId: sessionId ?? `s${seq++}`, status, msg: 'x' } as never)

describe('storm watch', () => {
  test('a single refusal is a blip and is NOT announced', () => {
    arm()
    refuse('REAL_REQUEST_ERROR', 529)
    expect(seen.length).toBe(0)
    expect(_stormState().open).toBe(false)
  })

  test('seven refusals still are not a storm — the threshold is eight', () => {
    arm()
    for (let i = 0; i < 7; i++) refuse('REAL_REQUEST_ERROR', 529)
    expect(seen.length).toBe(0)
  })

  test('eight refusals inside the window ARE announced, exactly once', () => {
    arm()
    for (let i = 0; i < 8; i++) refuse('REAL_REQUEST_ERROR', 529)
    expect(seen.length).toBe(1)
    expect(seen[0].kind).toBe('UPSTREAM_STORM_BEGAN')
    expect(seen[0].refusals).toBe(8)

    // A storm that keeps going stays ONE announcement — otherwise the signal
    // becomes the noise it exists to cut through.
    for (let i = 0; i < 20; i++) refuse('REAL_REQUEST_ERROR', 529)
    expect(seen.filter(e => e.kind === 'UPSTREAM_STORM_BEGAN').length).toBe(1)
  })

  test('the announcement splits keepalive from resume — the disputed question', () => {
    arm()
    for (let i = 0; i < 5; i++) refuse('REAL_REQUEST_ERROR', 529)
    for (let i = 0; i < 3; i++) refuse('KA_FIRE_ERROR', 429)

    expect(seen.length).toBe(1)
    const b = seen[0].breakdown
    expect(b.real).toBe(5)
    expect(b.ka).toBe(3)
    // Per-status too: a quota refusal and an overload refusal are different
    // events and a single total would hide which one the storm was made of.
    expect(b.real_529).toBe(5)
    expect(b.ka_429).toBe(3)
  })

  test('ONE session out of budget is not a storm, however many times it is refused', () => {
    // 🔴 MEASURED LIVE 2026-08-19, four hours after this file shipped, by the
    // first thing it ever declared: eight refusals in ten minutes, all of them
    // 429, ALL ON ONE SESSION — while keepalive fired fourteen times beside them
    // without one failure and 465 ordinary requests went through. That is not
    // the upstream in trouble, it is one session out of budget, which happens to
    // somebody every day and is entirely correct behaviour.
    //
    // This is the run that proves a guard, and the one people skip: not "does it
    // fire on the violation" but "does it stay quiet on the correct move".
    arm()
    for (let i = 0; i < 20; i++) refuse('REAL_REQUEST_ERROR', 429, 'the-one-session')
    expect(seen.length).toBe(0)
    expect(_stormState().sessions).toBe(1)
  })

  test('two sessions are still not enough — breadth is three', () => {
    arm()
    for (let i = 0; i < 10; i++) refuse('REAL_REQUEST_ERROR', 529, 'sess-a')
    for (let i = 0; i < 10; i++) refuse('REAL_REQUEST_ERROR', 529, 'sess-b')
    expect(seen.length).toBe(0)
  })

  test('the announcement says how many sessions were hit', () => {
    arm()
    for (let i = 0; i < 8; i++) refuse('REAL_REQUEST_ERROR', 529)
    expect(seen.length).toBe(1)
    expect(seen[0].sessions).toBe(8)
    expect(seen[0].breakdown.sessions).toBe(8)
  })

  test('failures that are NOT quota or overload do not inflate the count', () => {
    arm()
    for (let i = 0; i < 20; i++) refuse('REAL_REQUEST_ERROR', 502)
    expect(seen.length).toBe(0)
    expect(_stormState().recent).toBe(0)
  })

  test('a keepalive-only storm is announced too', () => {
    // The case that could not exist before 2026-08-19: a failed keepalive fire
    // emitted nothing, so a storm made entirely of them was invisible.
    arm()
    for (let i = 0; i < 8; i++) refuse('KA_FIRE_ERROR', 529)
    expect(seen.length).toBe(1)
    expect(seen[0].breakdown.ka).toBe(8)
    expect(seen[0].breakdown.real).toBe(0)
  })
})

/**
 * The alarm for the gap the breadth rule leaves — one session dead alone.
 *
 * The case it exists for, measured 2026-08-24: the upstream shed every large
 * request for 52 minutes, and for the first forty of them the only victim was
 * one session. The storm watch was right to stay quiet (one session is not a
 * fleet) and therefore said nothing at all while an agent ground uselessly.
 *
 * Both runs are here on purpose: LOUD on a session whose every request has
 * failed for minutes, SILENT on a session that is merely unlucky between
 * successes. The second is the one that decides whether anyone keeps the alarm.
 */
describe('session stuck', () => {
  let offStuck: (() => void) | null = null
  let stuck: any[] = []

  const armStuck = (spanSec = 0) => {
    process.env.PROXY_STUCK_SPAN_SEC = String(spanSec)
    stuck = []
    offStuck = bus.onKind('SESSION_STUCK' as never, (e: any) => stuck.push(e))
    stop = startStormWatch()
  }
  const complete = (sessionId: string) =>
    emit({ level: 'info', kind: 'REAL_REQUEST_COMPLETE', sessionId } as never)

  afterEach(() => {
    try { offStuck?.() } catch { /* already off */ }
    offStuck = null
    delete process.env.PROXY_STUCK_SPAN_SEC
  })

  test('three failures in a row on ONE session are announced, with the status mix', () => {
    armStuck()
    for (let i = 0; i < 3; i++) refuse('REAL_REQUEST_ERROR', 529, 'stuck-1')
    expect(stuck.length).toBe(1)
    expect(stuck[0].sessionId).toBe('stuck-1')
    expect(stuck[0].consecutiveFailures).toBe(3)
    expect(stuck[0].byStatus['529']).toBe(3)
  })

  test('a success in between resets the run — an unlucky session stays silent', () => {
    armStuck()
    refuse('REAL_REQUEST_ERROR', 529, 'lucky')
    refuse('REAL_REQUEST_ERROR', 529, 'lucky')
    complete('lucky')
    refuse('REAL_REQUEST_ERROR', 529, 'lucky')
    refuse('REAL_REQUEST_ERROR', 529, 'lucky')
    expect(stuck.length).toBe(0)
  })

  test('a run shorter than the span is a blip, not a stuck agent', () => {
    armStuck(3600) // an hour: nothing that happens in this test can span it
    for (let i = 0; i < 10; i++) refuse('REAL_REQUEST_ERROR', 529, 'blip')
    expect(stuck.length).toBe(0)
  })

  test('the same session is announced once, not once per failure', () => {
    armStuck()
    for (let i = 0; i < 12; i++) refuse('REAL_REQUEST_ERROR', 529, 'noisy')
    expect(stuck.length).toBe(1)
  })

  test('statuses the storm watch ignores still count as stuck — 503 is just as dead', () => {
    armStuck()
    for (let i = 0; i < 3; i++) refuse('REAL_REQUEST_ERROR', 503, 'infra')
    expect(stuck.length).toBe(1)
    expect(stuck[0].byStatus['503']).toBe(3)
    expect(_stormState().recent).toBe(0) // and it did NOT inflate the storm count
  })

  test('while a fleet storm is open the per-session alarm keeps quiet', () => {
    armStuck()
    for (let i = 0; i < 8; i++) refuse('REAL_REQUEST_ERROR', 529) // declares a storm
    stuck = []
    for (let i = 0; i < 5; i++) refuse('REAL_REQUEST_ERROR', 529, 'during-storm')
    expect(stuck.length).toBe(0)
  })
})
