/**
 * Signal-Wire v2 — Unified Audit Log (CR-07)
 *
 * Single JSONL audit log for ALL rule firings — reactive and proactive.
 * Location: ~/.opencode/hooks/logs/signal-wire-audit.jsonl
 * Rotation: at 50MB, rename to .1
 * Fail-open: never throws (NFR-02, ERR-01)
 */

import { appendFileSync, statSync, renameSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DEBUG = process.env.SIGNAL_WIRE_DEBUG === '1' || process.env.DEBUG?.includes('signal-wire')
const dbg = (...args: any[]) => { if (DEBUG) console.error('[sw-audit]', ...args) }

const AUDIT_DIR = join(homedir(), '.opencode', 'hooks', 'logs')
const AUDIT_FILE = join(AUDIT_DIR, 'signal-wire-audit.jsonl')
const MAX_SIZE_BYTES = 50 * 1024 * 1024  // 50MB

export interface UnifiedAuditEntry {
  /** ISO 8601 timestamp */
  ts: string
  /** Rule that fired */
  ruleId: string
  /** Event that triggered: PreToolUse, ExternalEvent, etc. */
  event: string
  /** For external: source adapter (synqtask, webhook, timer) */
  eventSource?: string
  /** For external: event type (task_assigned, channel_message) */
  eventType?: string
  /** Rule severity */
  severity: string
  /** OpenCode session ID */
  sessionId: string
  /** Agent ID (if subagent) */
  agentId?: string
  /** Actions that were dispatched */
  actionsTaken: string[]
  /** Overall outcome */
  outcome: 'success' | 'partial' | 'failed'
  /** For reactive: tool name that triggered */
  toolName?: string
  /** For wake: whether LLM was triggered */
  wakeTriggered?: boolean
  /** Error if any action failed */
  error?: string
}

let initialized = false

function ensureDir(): void {
  if (initialized) return
  try {
    if (!existsSync(AUDIT_DIR)) {
      mkdirSync(AUDIT_DIR, { recursive: true })
    }
    initialized = true
  } catch (e: any) {
    dbg('ensureDir error:', e?.message)
  }
}

/**
 * Write a single audit entry to the JSONL log.
 * Fail-open: never throws.
 */
export function writeAuditEntry(entry: UnifiedAuditEntry): void {
  try {
    ensureDir()
    rotateIfNeeded()
    appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n')
  } catch (e: any) {
    dbg('writeAuditEntry error:', e?.message)
  }
}

/**
 * Create an audit writer function (for injection into ActionContext).
 * This is the bridge between signal-wire-actions.ts and this module.
 */
export function createAuditWriter(sessionId: string): (entry: Record<string, unknown>) => void {
  return (entry: Record<string, unknown>) => {
    writeAuditEntry({
      ts: new Date().toISOString(),
      sessionId,
      outcome: 'success',
      actionsTaken: ['audit'],
      severity: 'info',
      ruleId: 'unknown',
      event: 'unknown',
      ...entry,
    } as UnifiedAuditEntry)
  }
}

/** Rotate audit log if over 50MB */
function rotateIfNeeded(): void {
  try {
    const stats = statSync(AUDIT_FILE)
    if (stats.size > MAX_SIZE_BYTES) {
      const rotated = AUDIT_FILE + '.1'
      renameSync(AUDIT_FILE, rotated)
      dbg(`rotated audit log (${Math.round(stats.size / 1024 / 1024)}MB)`)
    }
  } catch {
    // File doesn't exist yet or stat failed — OK
  }
}

/** Get audit log file path (for external readers) */
export function getAuditLogPath(): string {
  return AUDIT_FILE
}
