/**
 * Proactive Agent Wake System — Shared Type Contracts
 *
 * Used by:
 * - wake-listener.ts (L4 plugin listener)
 * - wake-router (L2 event router service)
 * - signal-wire.ts (wake event formatting)
 */

// ─── Constants ───────────────────────────────────────────────────────

import { homedir } from 'os'
import { join } from 'path'

/** Directory where plugin wake listeners write discovery files */
export const DISCOVERY_DIR = join(homedir(), '.opencode', 'wake')

/** Default token length (bytes of randomness, hex-encoded) */
export const DEFAULT_TOKEN_LENGTH = 32

/** TTL for warm channel tracking (agent recently active in channel) */
export const WARM_CHANNEL_TTL_MS = 5 * 60 * 1000

/** Typed event constants for wake events (DB-06: use these instead of string literals) */
export const WAKE_EVENT_TYPES = {
  TASK_ASSIGNED: 'task_assigned',
  CHANNEL_MESSAGE: 'channel_message',
  COMMENT_ADDED: 'comment_added',
  DELEGATION_RECEIVED: 'delegation_received',
  STATUS_CHANGED: 'status_changed',
  MENTION: 'mention',
  TASK_COMPLETED: 'task_completed',
  TASK_FAILED: 'task_failed',
  AGENT_STALE: 'agent_stale',
} as const

// ─── Enums ───────────────────────────────────────────────────────────

export type WakeEventPriority = 'urgent' | 'batch' | 'info'

export type WakeEventType =
  | 'task_assigned'
  | 'channel_message'
  | 'comment_added'
  | 'status_changed'
  | 'delegation_received'
  | 'webhook_event'
  | 'lifecycle_event'
  | 'timer_event'
  | 'mention'
  | 'task_completed'
  | 'task_failed'
  | 'agent_stale'

export type DispatchStatus = 'delivered' | 'queued' | 'rate_limited' | 'deduped' | 'failed' | 'agent_not_found'

export type AgentTransport = 'http' | 'vsock'

// ─── Core Event Schema (CR-06: Standard across all layers) ──────────

export interface WakeEvent {
  /** Schema version for compatibility checking (VER-01) */
  schemaVersion?: number  // default 1 if missing
  /** Unique event ID (UUID v4) */
  eventId: string
  /** Source adapter name (e.g., 'synqtask', 'webhook', 'telegram') */
  source: string
  /** Event type for classification */
  type: WakeEventType | string  // string allows custom types from webhooks
  /** Priority level — set by classifier, defaults to 'info' */
  priority: WakeEventPriority
  /** Target agent member ID in SynqTask */
  targetMemberId: string
  /** Opaque payload — only source and agent interpret this (REQ-17) */
  payload: Record<string, unknown>
  /** ISO 8601 timestamp of event origin */
  timestamp: string
  /** Optional: dedup fingerprint (set by rate limiter) */
  fingerprint?: string
}

// ─── Discovery File (DB-04: File-based agent discovery) ─────────────

export interface DiscoveryFile {
  /** Port the plugin wake listener is serving on */
  port: number
  /** Auth token for this session (CR-07) */
  token: string
  /** OpenCode session ID */
  sessionId: string
  /** SynqTask member ID (if available) */
  memberId?: string
  /** Process ID of the OpenCode process */
  pid: number
  /** ISO 8601 timestamp when listener started */
  startedAt: string
  /** Transport type for routing */
  transport: AgentTransport
  // Stage 2.1: Chain tracking (REQ-16a)
  /** Agent display name */
  memberName?: string
  /** Parent agent memberId (null = root agent) */
  parentMemberId?: string | null
  /** Parent agent sessionId */
  parentSessionId?: string | null
  /** Current spawn depth (0 = root) */
  spawnDepth?: number
  /** Max depth allowed from org role */
  maxSpawnDepth?: number
  /** Max subagents allowed from org role */
  maxSubagents?: number
  /** Event types this session subscribes to. ["*"] = all, [] = none. Absent = ["*"] (backward compat CR-05) */
  subscribe?: string[]
  /** Active preset name (human/agent/pm/quiet) — informational */
  subscribePreset?: string
  /** Member type: 'human' (OAuth), 'agent' (X-Agent-Id), 'unknown' */
  memberType?: 'human' | 'agent' | 'unknown'
}

// ─── SignalWire Engine (duck-typed to avoid circular imports) ────────

/** Duck-typed interface for SignalWire engine — matches evaluateExternal() signature */
export interface SignalWireEngine {
  evaluateExternal(event: WakeEvent): Promise<{
    matched: boolean
    actionsExecuted: { type: string; wakeTriggered?: boolean }[]
    wakeTriggered: boolean
  }>
}

// ─── Agent Identity (fetched from SynqTask at startup) ──────────────

export interface AgentIdentity {
  memberId: string
  name: string
  displayName?: string
  roleName: string | null
  rolePrompt: string | null
  teamName: string | null
  teammates: Array<{ name: string; roleName: string | null }>
  fetchedAt: number
  // Stage 2: budget limits (populated in Stage 2, null in Stage 1)
  budget?: {
    maxSpawnDepth: number
    maxSubagents: number
    tokenBudget?: number
  }
  // Stage 3: team playbook
  teamPlaybook?: string
}

// ─── Wake Listener Config ───────────────────────────────────────────

export interface WakeListenerConfig {
  /** OpenCode internal server URL (from input.serverUrl) */
  serverUrl: string
  /** Current session ID */
  sessionId: string
  /** SynqTask member ID (from env SYNQTASK_MEMBER_ID) */
  memberId?: string
  /** Optional: SignalWire engine instance — if provided, route through engine */
  signalWire?: SignalWireEngine | null
  /** Lazy resolver — called at request time when instance isn't ready at startup */
  signalWireResolver?: () => SignalWireEngine | null
  /** OpenCode SDK client — used for in-process injection when HTTP server unavailable (TUI mode) */
  sdkClient?: any
  /** Override listener port (0 = random, default) */
  port?: number
  /** Override token length */
  tokenLength?: number
  /** SynqTask API URL (CN-04: from env, not hardcoded) */
  synqtaskUrl?: string
  /** Timeout for identity fetch at startup (ms) */
  identityFetchTimeoutMs?: number
  /** Max events in local queue */
  maxQueueSize?: number
  /** Seconds to wait before retrying busy agent injection */
  busyRetryInterval?: number
  /** Max injection retries when agent is busy */
  busyMaxRetries?: number
  /** Initial subscription list (from preferences). Absent → default preset for memberType */
  subscribe?: string[]
  /** Preset name to apply at startup */
  subscribePreset?: string
  /** Member type hint (agent/human/unknown) — determines default preset */
  memberType?: 'human' | 'agent' | 'unknown'
}

// ─── Wake Response ──────────────────────────────────────────────────

export interface WakeResponse {
  /** Whether the event was accepted for processing */
  accepted: boolean
  /** Whether the event was queued (agent busy) vs injected immediately */
  queued?: boolean
  /** Position in queue (if queued) */
  queuePosition?: number
  /** Error message (if not accepted) */
  error?: string
}

// ─── Router Config ──────────────────────────────────────────────────

export interface RouterConfig {
  /** Port for the Event Router HTTP server */
  port: number
  /** Path to discovery directory */
  discoveryDir: string
  /** TTL for stale discovery files (seconds) */
  discoveryTtl: number
  /** Health check interval (seconds) */
  healthCheckInterval: number
  /** Rate limiting */
  rateLimit: {
    /** Max wake events per minute per agent */
    maxPerMinute: number
    /** Urgent events bypass rate limit */
    urgentBypass: boolean
  }
  /** Deduplication window (seconds) */
  dedupWindow: number
  /** Batch aggregation window (seconds) */
  batchWindow: number
  /** Event source configs */
  sources: Record<string, { enabled: boolean; [key: string]: unknown }>
}

// ─── Audit Log Entry ────────────────────────────────────────────────

export interface AuditEntry {
  /** ISO 8601 timestamp */
  ts: string
  /** Event ID for correlation */
  eventId: string
  /** Source adapter */
  source: string
  /** Target agent member ID */
  targetMember: string
  /** Event classification */
  classification: WakeEventPriority
  /** Dispatch outcome */
  dispatchStatus: DispatchStatus
  /** Transport used */
  transport: AgentTransport | 'none'
  /** End-to-end latency in ms */
  latencyMs: number
  /** Error message if failed */
  error?: string
  /** Agent listener port (if dispatched) */
  agentPort?: number
}

// ─── v2 Unified Engine Types ────────────────────────────────────────

// Canonical event type constants — SSOT (CN-07, SSOT-01)
// ALL code must import these instead of using string literals
export const EVENT_TYPES = {
  // Internal (OpenCode hooks)
  PRE_TOOL_USE: 'PreToolUse',
  POST_TOOL_USE: 'PostToolUse',
  USER_PROMPT_SUBMIT: 'UserPromptSubmit',
  STOP: 'Stop',
  SUBAGENT_START: 'SubagentStart',
  SUBAGENT_STOP: 'SubagentStop',
  SESSION_START: 'SessionStart',
  SESSION_END: 'SessionEnd',
  PERMISSION_REQUEST: 'PermissionRequest',
  // External (proactive wake)
  EXTERNAL_EVENT: 'ExternalEvent',
  WEBHOOK_EVENT: 'WebhookEvent',
  TIMER_EVENT: 'TimerEvent',
} as const

export type HookEvent = typeof EVENT_TYPES[keyof typeof EVENT_TYPES]

// ─── v2 Action Types ────────────────────────────────────────────────

export type ActionType = 'hint' | 'block' | 'exec' | 'notify' | 'audit' | 'wake' | 'respond'

export interface ActionV2 {
  type: ActionType
  /** For hint: the hint text template */
  text?: string
  /** For block: denial reason */
  reason?: string
  /** For exec: CLI command */
  command?: string
  /** For notify: channel (telegram, webhook) */
  channel?: string
  /** For notify/respond: message template */
  template?: string
  /** For wake: wake message template name */
  wakeTemplate?: string
  /** For respond: target channel/task ID */
  target?: string
  /** Timeout for async actions (ms) */
  timeout?: number
}

// ─── v2 Severity & Trust ────────────────────────────────────────────

export type Severity = 'info' | 'warn' | 'danger' | 'critical'
export type TrustLevel = 'any' | 'plugin_only' | 'explicit'

// ─── v2 Rule Interface ──────────────────────────────────────────────

export interface RuleV2 {
  id: string
  enabled?: boolean
  description?: string
  events: HookEvent[]
  match?: {
    tool?: string
    input_regex?: string
    response_regex?: string
    keywords?: string[]
  }
  /** v2: match external event source + type */
  event_source_match?: {
    source?: string  // e.g., 'synqtask', 'webhook:github'
    type?: string    // e.g., 'task_assigned'
  }
  /** v1 backward compat */
  action?: { hint?: string; bash?: string }
  /** v2: multiple actions per rule */
  actions?: ActionV2[]
  severity?: Severity
  trust_level?: TrustLevel
  cooldown_tokens?: number
  cooldown_minutes?: number
  cooldown_namespace?: string
  platforms?: string[]
}
