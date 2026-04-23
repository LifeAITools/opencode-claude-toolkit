/**
 * Wake Preferences — Preset definitions, load/save, merge logic.
 *
 * State Ownership (from Architect Review A1):
 * - Preferences file = SSOT (persistent intent)
 * - Discovery file = derived projection (written by wake-listener)
 * - api.kv = session-ephemeral rule toggles (separate concern)
 *
 * Paths:
 * - Global: ~/.opencode/wake-preferences.json
 * - Per-project: .opencode/wake-preferences.json (overrides global)
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { WAKE_EVENT_TYPES } from './wake-types'

// ─── Presets (DB-04: client-side, not server-defined) ─────────────

export const WAKE_PRESETS: Record<string, string[]> = {
  human: ['task_assigned', 'delegation_received', 'mention'],
  agent: ['*'],
  pm: ['task_completed', 'task_failed', 'agent_stale', 'delegation_received'],
  quiet: [],
}

export const PRESET_NAMES = Object.keys(WAKE_PRESETS) as string[]

// ─── Preference Schema ──────────────────────────────────────────────

export interface WakePreferences {
  /** Active preset name (or null if custom) */
  preset?: string | null
  /** Event types to subscribe to */
  subscribe: string[]
  /** Signal-wire rule overrides: ruleId → enabled */
  ruleOverrides?: Record<string, boolean>
  /** Timestamp of last save */
  savedAt?: string
}

// ─── Paths ──────────────────────────────────────────────────────────

const GLOBAL_PREFS_PATH = join(homedir(), '.opencode', 'wake-preferences.json')

function projectPrefsPath(cwd: string): string {
  return join(cwd, '.opencode', 'wake-preferences.json')
}

// ─── Load ───────────────────────────────────────────────────────────

/** Load preferences with per-project override. Returns merged prefs or null. */
export function loadPreferences(cwd?: string): WakePreferences | null {
  let global: WakePreferences | null = null
  let project: WakePreferences | null = null

  // Load global
  try {
    if (existsSync(GLOBAL_PREFS_PATH)) {
      global = JSON.parse(readFileSync(GLOBAL_PREFS_PATH, 'utf-8'))
    }
  } catch { /* corrupted file — ignore */ }

  // Load per-project (overrides global — AC-27)
  if (cwd) {
    try {
      const pp = projectPrefsPath(cwd)
      if (existsSync(pp)) {
        project = JSON.parse(readFileSync(pp, 'utf-8'))
      }
    } catch { /* corrupted file — ignore */ }
  }

  // Per-project takes full precedence (not merged — AC-18)
  return project ?? global
}

// ─── Save ───────────────────────────────────────────────────────────

/** Save preferences. Atomic tmp→rename. Writes to project path if cwd given, else global. */
export function savePreferences(prefs: WakePreferences, cwd?: string): void {
  const path = cwd ? projectPrefsPath(cwd) : GLOBAL_PREFS_PATH
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...prefs, savedAt: new Date().toISOString() }, null, 2))
  renameSync(tmp, path)
}

// ─── Compute ────────────────────────────────────────────────────────

/** Get default preset name for a member type */
export function defaultPresetFor(memberType: 'human' | 'agent' | 'unknown'): string {
  switch (memberType) {
    case 'human': return 'human'
    case 'agent': return 'agent'
    default: return 'agent'  // backward compat: unknown → all events
  }
}

/** Compute subscribe array from preferences or defaults */
export function computeSubscribe(
  prefs: WakePreferences | null,
  memberType: 'human' | 'agent' | 'unknown',
): { subscribe: string[]; preset: string | null } {
  if (prefs) {
    return { subscribe: prefs.subscribe, preset: prefs.preset ?? null }
  }
  const preset = defaultPresetFor(memberType)
  return { subscribe: WAKE_PRESETS[preset], preset }
}

/** Apply a preset — returns new preferences (AC-18: presets override entirely) */
export function applyPreset(presetName: string): WakePreferences | null {
  const sub = WAKE_PRESETS[presetName]
  if (!sub) return null
  return { preset: presetName, subscribe: [...sub] }
}

/** Add an event type to current preferences */
export function addSubscription(prefs: WakePreferences, eventType: string): WakePreferences {
  if (prefs.subscribe.includes('*') || prefs.subscribe.includes(eventType)) return prefs
  return { ...prefs, preset: null, subscribe: [...prefs.subscribe, eventType] }
}

/** Remove an event type from current preferences */
export function removeSubscription(prefs: WakePreferences, eventType: string): WakePreferences {
  // If wildcard, expand to all known types minus the removed one
  if (prefs.subscribe.includes('*')) {
    const all = Object.values(WAKE_EVENT_TYPES) as string[]
    return { ...prefs, preset: null, subscribe: all.filter(t => t !== eventType) }
  }
  return { ...prefs, preset: null, subscribe: prefs.subscribe.filter(t => t !== eventType) }
}
