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

const refuse = (kind: 'REAL_REQUEST_ERROR' | 'KA_FIRE_ERROR', status: number) =>
  emit({ level: 'error', kind, sessionId: 's', status, msg: 'x' } as never)

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
