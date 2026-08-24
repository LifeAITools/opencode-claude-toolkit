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
 * A storm is DECLARED, not guessed: STORM_MIN refusals inside STORM_WINDOW_MS,
 * spread over at least STORM_MIN_SESSIONS DIFFERENT sessions. A single refusal
 * is a blip and stays one. It is declared OVER after STORM_QUIET_MS with none,
 * so a long storm is one pair of events and not a stream of them.
 *
 * 🔴 WHY BREADTH AND NOT JUST A COUNT — measured 2026-08-19, four hours after
 * this file shipped, by the very first thing it declared. Eight refusals inside
 * ten minutes, and the declaration was true to its own rule — but all eight sat
 * on ONE session, every one of them a 429, while keepalive fired fourteen times
 * beside them without a single failure and 465 ordinary requests went through.
 * That is not the upstream in trouble; that is one session out of budget, which
 * is an ordinary and correct thing that happens to somebody every day.
 *
 * Declaring it a storm would teach the reader to distrust the word by the second
 * week. The rule this follows was written the same morning by
 * packages-lat-context-owner, out of a check of his own that punished a user for
 * doing the RIGHT thing: a guard is proven by two runs, not one — red on the
 * violation AND silent on the correct move — and the second run is the one
 * people skip, though it costs more, because a guard that gets in the way is
 * removed together with the check it stood for.
 */

import { bus, emit } from './event-bus.js'

/** Refusals inside the window needed to call it a storm rather than a blip. */
const STORM_MIN = Number(process.env.PROXY_STORM_MIN ?? 8)
/** Distinct sessions the refusals must touch — one session out of budget is not
 *  a storm, however many times it is refused. See the note above. */
const STORM_MIN_SESSIONS = Number(process.env.PROXY_STORM_MIN_SESSIONS ?? 3)
/** The window those refusals must fall inside. */
const STORM_WINDOW_MS = Number(process.env.PROXY_STORM_WINDOW_SEC ?? 600) * 1000
/** Silence after which a declared storm is called over. */
const STORM_QUIET_MS = Number(process.env.PROXY_STORM_QUIET_SEC ?? 600) * 1000

/**
 * 🔴 THE GAP THE BREADTH RULE LEAVES, AND WHY IT NEEDED ITS OWN ALARM.
 *
 * Measured 2026-08-24, from the founder asking why two agents "keep falling
 * over": the upstream shed every request over 2 MB between 05:04 and 05:56Z
 * (152 of 153 refused), and for the first FORTY MINUTES the only victim was one
 * session — foody7, carrying 810k tokens. The breadth rule is right that one
 * refused session is not a fleet storm, so the watch stayed silent by design
 * and only declared at 05:50, on the 47th minute. The founder noticed before
 * the instrument did.
 *
 * But "not a fleet storm" is not the same as "nothing to say". A session whose
 * every request has failed for minutes is an agent standing dead — it will
 * retry the same doomed turn until someone tells it otherwise. That is worth
 * one line the moment it is true, whoever else is fine.
 *
 * So this alarm is deliberately NARROW, to keep the word trustworthy:
 *  · CONSECUTIVE failures only — any success resets the run, so a session that
 *    is merely unlucky never trips it;
 *  · a SPAN, not just a count — three refusals in four seconds is a blip, three
 *    spread over three minutes is a stuck agent;
 *  · one announcement per session per cooldown, so a long outage is a heartbeat
 *    and not a stream;
 *  · SILENT while a fleet storm is open — the storm event already says the
 *    upstream is in trouble, and this exists for what it cannot see.
 * Simulated over the 8 days of log that were on disk: 0–1 per quiet day, and on
 * 2026-08-24 it would have named foody7 at 05:09 — 41 minutes earlier.
 *
 * The three thresholds are read at CALL time, not at import: a guard whose
 * limits freeze when the module loads cannot be exercised by a test at all, and
 * this one has to be proven twice — loud on a stuck session AND silent on an
 * unlucky one.
 */
const stuckMin = () => Number(process.env.PROXY_STUCK_MIN ?? 3)
/** How long the unbroken run of failures must span before it means anything. */
const stuckSpanMs = () => Number(process.env.PROXY_STUCK_SPAN_SEC ?? 180) * 1000
/** Re-announce the same session no more often than this. */
const stuckCooldownMs = () => Number(process.env.PROXY_STUCK_COOLDOWN_SEC ?? 600) * 1000

type Refusal = {
  ts: number
  /** 'real' = a request from a live session; 'ka' = a keepalive fire. */
  stream: 'real' | 'ka'
  status: number
  sessionId: string
}

let refusals: Refusal[] = []
let stormSince: number | null = null
let stormRefusals: Refusal[] = []
let quietTimer: ReturnType<typeof setTimeout> | null = null

/** Per session: the unbroken run of terminal failures since its last success. */
const failRun = new Map<string, { statuses: number[]; firstTs: number }>()
/** Per session: when we last announced it stuck, so a long outage is a heartbeat. */
const stuckAnnouncedAt = new Map<string, number>()

function tally(rows: Refusal[]): Record<string, number> {
  const out: Record<string, number> = { real: 0, ka: 0 }
  for (const r of rows) {
    out[r.stream] = (out[r.stream] ?? 0) + 1
    const k = `${r.stream}_${r.status}`
    out[k] = (out[k] ?? 0) + 1
  }
  // How many DIFFERENT sessions were hit — the number that separates "the
  // upstream is in trouble" from "one session is out of budget".
  out.sessions = new Set(rows.map(r => r.sessionId)).size
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

function record(stream: 'real' | 'ka', status: unknown, sessionId: unknown): void {
  const st = Number(status)
  // 429 = quota, 529 = overloaded. Other failures (502, network) are real
  // faults but not the thing this watch is about, and mixing them in would
  // make the count mean two different things at once.
  if (st !== 429 && st !== 529) return

  const now = Date.now()
  const row: Refusal = { ts: now, stream, status: st, sessionId: String(sessionId ?? 'unknown') }
  refusals.push(row)
  const cutoff = now - STORM_WINDOW_MS
  refusals = refusals.filter(r => r.ts >= cutoff)

  if (stormSince !== null) {
    stormRefusals.push(row)
    armQuietTimer()
    return
  }

  const distinctSessions = new Set(refusals.map(r => r.sessionId)).size
  if (refusals.length >= STORM_MIN && distinctSessions >= STORM_MIN_SESSIONS) {
    stormSince = refusals[0]!.ts
    stormRefusals = [...refusals]
    emit({
      level: 'error',
      kind: 'UPSTREAM_STORM_BEGAN',
      since: new Date(stormSince).toISOString(),
      refusals: refusals.length,
      windowSec: Math.round(STORM_WINDOW_MS / 1000),
      sessions: distinctSessions,
      breakdown: tally(refusals),
    } as never)
    armQuietTimer()
  }
}

/**
 * One session's unbroken run of failures — the alarm the breadth rule cannot
 * raise. Counts EVERY terminal status, not just 429/529: a session stuck on 403
 * or 503 is just as dead, and the event names the mix so the reader knows which
 * kind of stuck it is.
 */
function recordSessionOutcome(sessionId: unknown, status: unknown, ok: boolean): void {
  const sid = String(sessionId ?? 'unknown')
  if (ok) { failRun.delete(sid); stuckAnnouncedAt.delete(sid); return }

  const now = Date.now()
  const run = failRun.get(sid) ?? { statuses: [], firstTs: now }
  run.statuses.push(Number(status) || 0)
  failRun.set(sid, run)

  // A declared fleet storm already told the reader the upstream is in trouble.
  if (stormSince !== null) return
  if (run.statuses.length < stuckMin()) return
  if (now - run.firstTs < stuckSpanMs()) return
  const announced = stuckAnnouncedAt.get(sid)
  if (announced !== undefined && now - announced < stuckCooldownMs()) return

  stuckAnnouncedAt.set(sid, now)
  const byStatus: Record<string, number> = {}
  for (const st of run.statuses) byStatus[String(st)] = (byStatus[String(st)] ?? 0) + 1
  emit({
    level: 'error',
    kind: 'SESSION_STUCK',
    sessionId: sid,
    consecutiveFailures: run.statuses.length,
    stuckForSec: Math.round((now - run.firstTs) / 1000),
    lastStatus: run.statuses[run.statuses.length - 1],
    byStatus,
  } as never)
}

/**
 * Subscribe to the bus. Returns a stop function (tests and shutdown use it).
 */
export function startStormWatch(): () => void {
  const offReal = bus.onKind('REAL_REQUEST_ERROR', (e: any) => {
    record('real', e?.status, e?.sessionId)
    recordSessionOutcome(e?.sessionId, e?.status, false)
  })
  const offOk = bus.onKind('REAL_REQUEST_COMPLETE', (e: any) => recordSessionOutcome(e?.sessionId, 200, true))
  const offKa = bus.onKind('KA_FIRE_ERROR', (e: any) => record('ka', e?.status, e?.sessionId))
  return () => {
    try { offReal?.() } catch { /* best-effort */ }
    try { offOk?.() } catch { /* best-effort */ }
    try { offKa?.() } catch { /* best-effort */ }
    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null }
    refusals = []
    stormSince = null
    stormRefusals = []
    failRun.clear()
    stuckAnnouncedAt.clear()
  }
}

/** Test seam — current state without reaching into module internals. */
export function _stormState(): { open: boolean; recent: number; sessions: number; sinceMs: number | null } {
  return {
    open: stormSince !== null,
    recent: refusals.length,
    sessions: new Set(refusals.map(r => r.sessionId)).size,
    sinceMs: stormSince,
  }
}
