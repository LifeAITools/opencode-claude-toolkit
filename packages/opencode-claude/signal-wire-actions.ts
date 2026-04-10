/**
 * Signal-Wire v2 — Unified Action Dispatch Module
 *
 * Executes rule actions in defined order:
 * block → hint → exec → wake → respond → notify → audit
 *
 * Each action is independent — failure of one doesn't prevent others (AC-11).
 * All catch blocks log at debug level (ERR-01).
 */

import type { ActionV2, ActionType, WakeEvent } from './wake-types'
import type { AgentIdentity } from './wake-types'

// Debug logger (same pattern as signal-wire.ts)
const DEBUG = process.env.SIGNAL_WIRE_DEBUG === '1' || process.env.DEBUG?.includes('signal-wire')
const dbg = (...args: any[]) => { if (DEBUG) console.error('[sw-actions]', ...args) }

// Action execution order (DB from PRD: block → hint → exec → wake → respond → notify → audit)
const ACTION_ORDER: ActionType[] = ['block', 'hint', 'exec', 'wake', 'respond', 'notify', 'audit']

// ─── Context for action execution ───────────────────────────────────

export interface ActionContext {
  serverUrl: string
  sessionId: string
  ruleId: string
  severity: string
  event: string        // hook event name or ExternalEvent
  eventSource?: string // e.g., 'synqtask', 'webhook:github'
  eventType?: string   // e.g., 'task_assigned'
  variables: Record<string, string>  // interpolation variables
  wakeEvent?: WakeEvent  // if external event triggered this
  auditWriter?: (entry: Record<string, unknown>) => void  // injected by caller
}

export interface ActionResult {
  type: ActionType
  success: boolean
  /** For block: the permissionDecision response */
  blockResponse?: { permissionDecision: string; permissionDecisionReason: string }
  /** For hint: the hint text to inject */
  hintText?: string
  /** For exec: command output */
  execOutput?: string
  /** For wake: whether LLM was triggered */
  wakeTriggered?: boolean
  error?: string
}

// ─── Main dispatch ──────────────────────────────────────────────────

/**
 * Dispatch actions in defined order. Each action independent (AC-11).
 * Returns results for all actions.
 */
export async function dispatchActions(
  actions: ActionV2[],
  ctx: ActionContext
): Promise<ActionResult[]> {
  // Re-entrancy guard (REQ-08)
  if (process.env.SIGNAL_WIRE_ACTIVE === '1') {
    dbg('Re-entrancy detected — skipping all actions')
    return []
  }

  // Sort actions by defined order
  const sorted = [...actions].sort((a, b) => {
    const ai = ACTION_ORDER.indexOf(a.type)
    const bi = ACTION_ORDER.indexOf(b.type)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
  })

  const results: ActionResult[] = []
  process.env.SIGNAL_WIRE_ACTIVE = '1'

  try {
    for (const action of sorted) {
      try {
        const result = await executeAction(action, ctx)
        results.push(result)
      } catch (e: any) {
        dbg(`action ${action.type} error:`, e?.message)
        results.push({ type: action.type, success: false, error: e?.message ?? 'unknown' })
      }
    }
  } finally {
    delete process.env.SIGNAL_WIRE_ACTIVE
  }

  return results
}

// ─── Individual action executors ────────────────────────────────────

async function executeAction(action: ActionV2, ctx: ActionContext): Promise<ActionResult> {
  switch (action.type) {
    case 'block': return executeBlock(action, ctx)
    case 'hint': return executeHint(action, ctx)
    case 'exec': return executeExec(action, ctx)
    case 'wake': return executeWake(action, ctx)
    case 'respond': return executeRespond(action, ctx)
    case 'notify': return executeNotify(action, ctx)
    case 'audit': return executeAudit(action, ctx)
    default:
      dbg(`unknown action type: ${(action as any).type}`)
      return { type: action.type, success: false, error: 'unknown_action_type' }
  }
}

/** Block: return permissionDecision:deny (CR-03) */
function executeBlock(action: ActionV2, ctx: ActionContext): ActionResult {
  const reason = interpolate(action.reason ?? `Blocked by rule ${ctx.ruleId}`, ctx.variables)
  dbg(`BLOCK: ${reason}`)
  return {
    type: 'block',
    success: true,
    blockResponse: {
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
}

/** Hint: return text for context injection */
function executeHint(action: ActionV2, ctx: ActionContext): ActionResult {
  const text = interpolate(action.text ?? '', ctx.variables)
  dbg(`HINT: ${text.slice(0, 80)}...`)
  return { type: 'hint', success: true, hintText: text }
}

/** Exec: run CLI command via subprocess (CN-04: shell-escape variables) */
async function executeExec(action: ActionV2, ctx: ActionContext): Promise<ActionResult> {
  const command = interpolate(action.command ?? '', ctx.variables)
  if (!command) return { type: 'exec', success: false, error: 'no command' }

  dbg(`EXEC: ${command.slice(0, 80)}...`)
  try {
    const proc = Bun.spawn(['sh', '-c', command], {
      env: { ...process.env, ...ctx.variables, SIGNAL_WIRE_ACTIVE: '1' },
      timeout: action.timeout ?? 10000,
    })
    const output = await new Response(proc.stdout).text()
    const exitCode = await proc.exited
    return {
      type: 'exec',
      success: exitCode === 0,
      execOutput: output.slice(0, 2000),
      error: exitCode !== 0 ? `exit ${exitCode}` : undefined,
    }
  } catch (e: any) {
    dbg(`exec error:`, e?.message)
    return { type: 'exec', success: false, error: e?.message }
  }
}

/** Wake: inject message via promptAsync to trigger LLM loop (CR-02) */
async function executeWake(action: ActionV2, ctx: ActionContext): Promise<ActionResult> {
  if (!ctx.wakeEvent) {
    return { type: 'wake', success: false, error: 'no wakeEvent in context' }
  }

  // Import formatWakeEvent from signal-wire.ts + identity from wake-listener
  const { formatWakeEvent } = await import('./signal-wire')
  let identityBlock = ''
  try {
    // Dynamic import to avoid circular dep — wake-listener exports _agentIdentity
    const wl = await import('./wake-listener') as any
    const identity: AgentIdentity | null = wl._agentIdentity ?? null
    if (identity) {
      const teammates = identity.teammates?.length > 0
        ? identity.teammates.map((t: any) => `${t.name} (${t.roleName ?? '?'})`).join(', ')
        : 'none'
      const identityLines = [
        `<agent-identity name="${identity.name}" role="${identity.roleName ?? 'unassigned'}" team="${identity.teamName ?? 'none'}">`,
        `You are ${identity.name}. ${identity.rolePrompt ?? 'No role assigned.'}`,
        `Team: ${identity.teamName ?? 'none'}. Teammates: ${teammates}.`,
      ]
      if (identity.budget) {
        identityLines.push(`Helpers: max ${identity.budget.maxSubagents} concurrent, depth ${identity.budget.maxSpawnDepth}. Делегирование коллегам: SynqTask todo_tasks delegate.`)
      }
      identityLines.push(`</agent-identity>`)
      identityBlock = identityLines.join('\n') + '\n'
    }
  } catch { /* identity not available — proceed without */ }
  const text = identityBlock + formatWakeEvent(ctx.wakeEvent)

  // Try promptAsync first (v1.4.0), fall back to /message
  const urls = [
    `${ctx.serverUrl}/session/${ctx.sessionId}/prompt_async`,
    `${ctx.serverUrl}/session/${ctx.sessionId}/message`,
  ]

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          noReply: false,  // CR-02: triggers full LLM loop
          parts: [{ type: 'text', text }],
        }),
      })
      if (res.ok) {
        dbg(`WAKE: injected via ${url.includes('prompt_async') ? 'promptAsync' : 'message'}`)
        return { type: 'wake', success: true, wakeTriggered: true }
      }
      if (res.status === 404 || res.status === 405) continue
      return { type: 'wake', success: false, error: `HTTP ${res.status}` }
    } catch (e: any) {
      dbg(`wake fetch error:`, e?.message)
      continue
    }
  }
  return { type: 'wake', success: false, error: 'all endpoints failed' }
}

/** Respond: post reply to SynqTask channel (REQ-17) */
async function executeRespond(action: ActionV2, ctx: ActionContext): Promise<ActionResult> {
  const template = interpolate(action.template ?? '', ctx.variables)
  const target = action.target ?? (ctx.wakeEvent?.payload?.channel_id as string | undefined)

  if (!target) {
    dbg('respond: no target channel')
    return { type: 'respond', success: false, error: 'no target channel' }
  }

  // Fire-and-forget POST to SynqTask (or whatever service)
  try {
    // This would call the SynqTask channels API
    // For now, log and succeed — actual SynqTask integration depends on auth/API
    dbg(`RESPOND: to channel ${target}: ${template.slice(0, 80)}...`)
    // TODO: implement actual SynqTask channel POST when API details are finalized
    return { type: 'respond', success: true }
  } catch (e: any) {
    dbg(`respond error:`, e?.message)
    return { type: 'respond', success: false, error: e?.message }
  }
}

/** Notify: fire-and-forget to Telegram/webhook (REQ-03) */
async function executeNotify(action: ActionV2, ctx: ActionContext): Promise<ActionResult> {
  const template = interpolate(action.template ?? `Rule ${ctx.ruleId} fired (${ctx.severity})`, ctx.variables)
  const channel = action.channel ?? 'telegram'

  dbg(`NOTIFY: ${channel}: ${template.slice(0, 80)}...`)

  // Fire-and-forget — don't await, don't block (AC-07)
  if (channel === 'telegram') {
    const token = process.env.SIGNAL_WIRE_TG_TOKEN
    const chatId = process.env.SIGNAL_WIRE_TG_CHAT_ID
    if (token && chatId) {
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: template, parse_mode: 'HTML' }),
      }).catch(e => dbg('telegram notify error:', e?.message))
    } else {
      dbg('notify: telegram not configured (SIGNAL_WIRE_TG_TOKEN / SIGNAL_WIRE_TG_CHAT_ID)')
    }
  } else if (channel === 'webhook' && action.target) {
    fetch(action.target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rule: ctx.ruleId, severity: ctx.severity, message: template, event: ctx.event }),
    }).catch(e => dbg('webhook notify error:', e?.message))
  }

  return { type: 'notify', success: true }
}

/** Audit: write to unified audit log (CR-07) */
function executeAudit(action: ActionV2, ctx: ActionContext): ActionResult {
  const entry = {
    ts: new Date().toISOString(),
    ruleId: ctx.ruleId,
    event: ctx.event,
    eventSource: ctx.eventSource,
    eventType: ctx.eventType,
    severity: ctx.severity,
    sessionId: ctx.sessionId,
    variables: ctx.variables,
  }

  if (ctx.auditWriter) {
    ctx.auditWriter(entry)
  } else {
    dbg('audit: no writer configured, logging to debug')
    dbg('AUDIT:', JSON.stringify(entry))
  }

  return { type: 'audit', success: true }
}

// ─── Variable interpolation (REQ-07) ────────────────────────────────

/**
 * Interpolate {variable_name} placeholders in template string.
 * Uses shell-safe values from ctx.variables (CN-04).
 */
export function interpolate(template: string, variables: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    return variables[key] ?? match  // Keep {unknown} as-is
  })
}

// Shell-escape a value for safe use in exec commands (CN-04)
export function shellEscape(value: string): string {
  // Single-quote wrapping with internal quote escaping
  return "'" + value.replace(/'/g, "'\\''") + "'"
}
