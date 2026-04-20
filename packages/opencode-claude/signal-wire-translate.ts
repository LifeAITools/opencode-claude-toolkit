/**
 * Legacy ↔ Canonical translation helpers for opencode-claude signal-wire.
 *
 * Isolated from the adapter class so adapter stays ≤200 LOC (ADR-0007).
 */

import type { Rule as CoreRule, SignalWireEvent } from '@kiberos/signal-wire-core'

export type HookEvent = 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse' | 'Stop'

export interface SignalWireContext {
  event: HookEvent
  lastUserText: string
  lastToolName: string
  lastToolInput: string
  lastToolOutput: string
}

/**
 * Claude/OpenCode hook-event → canonical signal-wire event type.
 *
 * Covers the full production vocabulary used in opencode-claude's
 * signal-wire-rules.json (21 rules as of 2026-04-20):
 *   - UserPromptSubmit: user sends new prompt
 *   - PreToolUse / PostToolUse: before/after tool invocation
 *   - Stop: session ended (user-initiated)
 *   - ExternalEvent: wake-router routed external event → handled separately
 */
const EVENT_MAP: Record<HookEvent | string, string> = {
  UserPromptSubmit: 'chat.message',
  PreToolUse: 'tool.before',
  PostToolUse: 'tool.after',
  Stop: 'session.idle',
  // ExternalEvent → evaluateExternal() path, not evaluate() — translated
  // inline there with wake.* prefix. Kept here as informational identity.
  ExternalEvent: 'wake.external',
}

export function translateEventType(hookEvent: string): string {
  return (EVENT_MAP as Record<string, string>)[hookEvent] ?? hookEvent
}

/** SignalWireContext → canonical SignalWireEvent. */
export function contextToEvent(ctx: SignalWireContext, sessionId: string): SignalWireEvent {
  return {
    source: 'hook',
    type: translateEventType(ctx.event),
    sessionId: sessionId || null,
    payload: {
      tool: ctx.lastToolName || '',
      args: { toolInput: ctx.lastToolInput },
      response: { output: ctx.lastToolOutput },
      message: ctx.event === 'UserPromptSubmit' ? { role: 'user' } : undefined,
      parts: ctx.event === 'UserPromptSubmit'
        ? [{ type: 'text', text: ctx.lastUserText }]
        : undefined,
      prompt: ctx.lastUserText,
    },
    timestamp: Date.now(),
  }
}

/**
 * Legacy Python-style rule set → canonical CoreRule[].
 *
 * Translates:
 *   - action: {hint, bash, exec} → actions: [{type, text/command}]
 *   - events: UserPromptSubmit → chat.message (etc)
 *   - cooldown_minutes → cooldown_seconds
 *   - platforms filter applied
 */
export function translateLegacyRules(legacyRules: unknown[], platform: string): CoreRule[] {
  const out: CoreRule[] = []
  for (const raw of legacyRules) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.id !== 'string') continue

    // Platform filter
    if (Array.isArray(r.platforms) && r.platforms.length > 0 && !r.platforms.includes(platform)) continue

    const events: string[] = []
    if (Array.isArray(r.events)) {
      for (const e of r.events) {
        if (typeof e === 'string') events.push(translateEventType(e))
      }
    }
    if (events.length === 0) continue

    const actions = translateActions(r.action, r.actions)
    if (actions.length === 0) continue

    out.push({
      id: r.id,
      enabled: r.enabled !== false,
      events,
      actions,
      match: (r.match as CoreRule['match']) ?? {},
      cooldown_seconds: typeof r.cooldown_minutes === 'number' ? r.cooldown_minutes * 60 : undefined,
      cooldown_tokens: typeof r.cooldown_tokens === 'number' ? r.cooldown_tokens : undefined,
    })
  }
  return out
}

function translateActions(legacy1: unknown, legacy2: unknown): any[] {
  // v2 shape already — actions: [...]
  if (Array.isArray(legacy2)) {
    return legacy2.filter(a => a && typeof a === 'object' && 'type' in (a as any))
  }
  // v1 shape — action: {hint?, bash?, exec?}
  if (legacy1 && typeof legacy1 === 'object') {
    const a = legacy1 as { hint?: string; bash?: string; exec?: string }
    const out: any[] = []
    if (typeof a.hint === 'string') out.push({ type: 'hint', text: a.hint })
    if (typeof a.bash === 'string') out.push({ type: 'exec', command: a.bash })
    if (typeof a.exec === 'string') out.push({ type: 'exec', command: a.exec })
    return out
  }
  return []
}
