/**
 * Storm watch — the proxy notices for itself when refusals start clustering,
 * and says so once, with the numbers that settle the argument about them.
 *
 * 🔴 WHY THIS LIVES IN THE SERVICE AND NOT IN AN AGENT'S SESSION.
 *
 * Twice now the plan for measuring a 529 storm was "an agent watches the log".
 * Measured 2026-08-19: the first watcher woke for a single 529 after six quiet
 * hours (too sensitive to be useful), the second was killed by its harness
 * without a word, and for the hours in between nothing at all was watching
 * while everyone believed something was. A guard whose life depends on a
 * session that can die quietly is the same defect this codebase spent two days
 * closing from other directions — a mechanism honest in the happy case and mute
 * in the one it exists for.
 *
 * The proxy is the only thing that sees every refusal, and it runs as a service.
 * So it announces the storm itself: once when it begins, once when it ends, and
 * the announcement carries what the next reader will actually want.
 *
 * 🔴 WHAT THE ANNOUNCEMENT CARRIES, AND WHY THAT SPLIT.
 *
 * There is an open, named disagreement about what these storms ARE: the fleet's
 * keepalive traffic all at once, or the fleet RESUMING all at once. Both sides
 * are recorded (in the quota rules of signal-wire-core) and neither has been
 * measured, because until 2026-08-19 a failed keepalive fire left no trace at
 * all — the log held 363 successful fires and not one record of a fire that did
 * not complete. Now both streams can fail visibly, so the storm event splits its
 * count by stream and by status. That split, computed at the moment the storm is
 * happening, is the whole answer; reconstructing it afterwards is what nobody
 * got round to twice.
 *
 * A storm is DECLARED, not guessed: STORM_MIN refusals inside STORM_WINDOW_MS.
 * A single refusal is a blip and stays one. It is declared OVER after
 * STORM_QUIET_MS with none, so a long storm is one pair of events and not a
 * stream of them.
 */

import { bus, emit } from './event-bus.js'

/** Refusals inside the window needed to call it a storm rather than a blip. */
const STORM_MIN = Number(process.env.PROXY_STORM_MIN ?? 8)
/** The window those refusals must fall inside. */
const STORM_WINDOW_MS = Number(process.env.PROXY_STORM_WINDOW_SEC ?? 600) * 1000
/** Silence after which a declared storm is called over. */
const STORM_QUIET_MS = Number(process.env.PROXY_STORM_QUIET_SEC ?? 600) * 1000

type Refusal = {
  ts: number
  /** 'real' = a request from a live session; 'ka' = a keepalive fire. */
  stream: 'real' | 'ka'
  status: number
}

let refusals: Refusal[] = []
let stormSince: number | null = null
let stormRefusals: Refusal[] = []
let quietTimer: ReturnType<typeof setTimeout> | null = null

function tally(rows: Refusal[]): Record<string, number> {
  const out: Record<string, number> = { real: 0, ka: 0 }
  for (const r of rows) {
    out[r.stream] = (out[r.stream] ?? 0) + 1
    const k = `${r.stream}_${r.status}`
    out[k] = (out[k] ?? 0) + 1
  }
  return out
}

function endStorm(): void {
  if (stormSince === null) return
  const began = stormSince
  const rows = stormRefusals
  stormSince = null
  stormRefusals = []
  if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
  emit({
    level: 'error',
    kind: 'UPSTREAM_STORM_ENDED',
    beganAt: new Date(began).toISOString(),
    durationSec: Math.round((Date.now() - began) / 1000),
    refusals: rows.length,
    // The split that answers "keepalive or resume" — see the header note.
    breakdown: tally(rows),
  } as never)
}

function armQuietTimer(): void {
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = setTimeout(endStorm, STORM_QUIET_MS)
  // Never hold the process open on account of an observer.
  ;(quietTimer as any).unref?.()
}

function record(stream: 'real' | 'ka', status: unknown): void {
  const st = Number(status)
  // 429 = quota, 529 = overloaded. Other failures (502, network) are real
  // faults but not the thing this watch is about, and mixing them in would
  // make the count mean two different things at once.
  if (st !== 429 && st !== 529) return

  const now = Date.now()
  const row: Refusal = { ts: now, stream, status: st }
  refusals.push(row)
  const cutoff = now - STORM_WINDOW_MS
  refusals = refusals.filter(r => r.ts >= cutoff)

  if (stormSince !== null) {
    stormRefusals.push(row)
    armQuietTimer()
    return
  }

  if (refusals.length >= STORM_MIN) {
    stormSince = refusals[0]!.ts
    stormRefusals = [...refusals]
    emit({
      level: 'error',
      kind: 'UPSTREAM_STORM_BEGAN',
      since: new Date(stormSince).toISOString(),
      refusals: refusals.length,
      windowSec: Math.round(STORM_WINDOW_MS / 1000),
      breakdown: tally(refusals),
    } as never)
    armQuietTimer()
  }
}

/**
 * Subscribe to the bus. Returns a stop function (tests and shutdown use it).
 */
export function startStormWatch(): () => void {
  const offReal = bus.onKind('REAL_REQUEST_ERROR', (e: any) => record('real', e?.status))
  const offKa = bus.onKind('KA_FIRE_ERROR', (e: any) => record('ka', e?.status))
  return () => {
    try { offReal?.() } catch { /* best-effort */ }
    try { offKa?.() } catch { /* best-effort */ }
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
    refusals = []
    stormSince = null
    stormRefusals = []
  }
}

/** Test seam — current state without reaching into module internals. */
export function _stormState(): { open: boolean; recent: number; sinceMs: number | null } {
  return { open: stormSince !== null, recent: refusals.length, sinceMs: stormSince }
}
