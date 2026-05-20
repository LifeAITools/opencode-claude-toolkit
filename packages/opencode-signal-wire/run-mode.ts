/**
 * run-mode — multi-signal detection: is this opencode process being driven by
 * a human (TUI/tmux interactive) or an autonomous agent process?
 *
 * Used for `task` tool fail-mode (REQ-36):
 *   - human → router unreachable = fail-open + signal-wire warning hint
 *   - agent → router unreachable = fail-closed with explicit block reason
 *   - unknown → fail-closed + recovery hint
 *
 * Signal weighting (positive = human, negative = agent):
 *   +3 process.stdout.isTTY (interactive terminal)
 *   +5 OAuth present (existing memberType detection)
 *   -3 OPENCODE_AGENT_INSTANCE_ID env set
 *   -5 SPAWN_PARENT_MEMBER_ID env set (spawned by another agent)
 *   -3 OPENCODE_AGENT_ROLE env set (pre-assigned role)
 *   -2 parent process is `bun` or `opencode` (programmatic spawn)
 *   ±0 TMUX env (both humans and agents use tmux)
 *
 * Explicit override:
 *   SYNQTASK_MEMBER_TYPE=human|agent always wins.
 *
 * Threshold:
 *   score > +2 → human
 *   score < -2 → agent
 *   otherwise → unknown
 *
 * Conformance: REQ-30, US-12, AC-33..AC-38.
 */

import { readFileSync } from 'fs'

export type RunMode = 'human' | 'agent' | 'unknown'

export interface SignalLog {
  [signal: string]: string
}

export interface RunModeResult {
  mode: RunMode
  score: number
  signals: SignalLog
  /** Whether SYNQTASK_MEMBER_TYPE override was honored. */
  fromOverride: boolean
}

/**
 * Detect run mode. Cached per-process — result is stable for process lifetime
 * (env can't really change usefully mid-run).
 */
let _cached: RunModeResult | null = null

export function detectRunMode(opts: { force?: boolean; hasOAuth?: () => boolean } = {}): RunModeResult {
  if (_cached && !opts.force) return _cached

  const signals: SignalLog = {}
  let score = 0

  // Explicit override wins
  const explicit = process.env.SYNQTASK_MEMBER_TYPE
  if (explicit === 'human') {
    _cached = { mode: 'human', score: 999, signals: { explicit: 'human' }, fromOverride: true }
    return _cached
  }
  if (explicit === 'agent') {
    _cached = { mode: 'agent', score: -999, signals: { explicit: 'agent' }, fromOverride: true }
    return _cached
  }

  // Signal: interactive terminal
  if (process.stdout.isTTY) {
    score += 3
    signals.tty = '+3'
  } else {
    signals.tty = '0 (no TTY)'
  }

  // Signal: OAuth available (real human user)
  try {
    if (opts.hasOAuth?.()) {
      score += 5
      signals.oauth = '+5'
    }
  } catch {
    // OAuth probe failed — skip
  }

  // Signal: agent-style env markers
  if (process.env.OPENCODE_AGENT_INSTANCE_ID) {
    // Note: this var is set by plugin itself for ITS OWN process AFTER bootstrap.
    // So presence at boot-time of detection (very early) means it was set by
    // a parent process — strong agent indicator.
    score -= 3
    signals.opencodeAgentId = '-3'
  }
  if (process.env.SPAWN_PARENT_MEMBER_ID) {
    score -= 5
    signals.spawnedBy = '-5'
  }
  if (process.env.OPENCODE_AGENT_ROLE) {
    score -= 3
    signals.preassignedRole = '-3'
  }

  // Signal: parent process name (Linux-specific)
  try {
    const ppid = process.ppid
    const comm = readFileSync(`/proc/${ppid}/comm`, 'utf-8').trim()
    if (comm === 'bun' || comm.startsWith('opencode')) {
      score -= 2
      signals.parentProc = `-2 (${comm})`
    } else {
      signals.parentProc = `0 (${comm})`
    }
  } catch {
    signals.parentProc = '0 (unknown)'
  }

  // TMUX is neutral
  if (process.env.TMUX) {
    signals.tmux = '0 (neutral)'
  }

  // Decision
  const mode: RunMode = score > 2 ? 'human' : score < -2 ? 'agent' : 'unknown'

  _cached = { mode, score, signals, fromOverride: false }
  return _cached
}

/** Get cached run mode (assumes detectRunMode was called at least once). */
export function getRunMode(): RunMode {
  return _cached?.mode ?? 'unknown'
}

/** Reset cache (for tests). */
export function resetRunModeCache(): void {
  _cached = null
}
