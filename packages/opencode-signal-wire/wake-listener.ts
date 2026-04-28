/**
 * Wake Listener: L4 Plugin Wake Listener for Proactive Agent Wake System
 *
 * Runs inside every OpenCode process. Starts an HTTP server on a random port,
 * accepts authenticated wake events from the Event Router (L2), queues them
 * if the agent is busy, and injects them via promptAsync to trigger the LLM.
 *
 * Discovery: writes a JSON file to ~/.opencode/wake/ so the router can find us.
 * Auth: per-session random token validated on every request (CR-07).
 * Injection: promptAsync with noReply:false for full LLM loop (CR-02, DB-05).
 *
 * STANDALONE — does not import from provider.ts, signal-wire.ts, or external packages.
 * Uses only Bun built-ins (serve, fetch, crypto) and Node fs/path/os.
 * Engine routing: optional SignalWireEngine via config (duck-typed, no direct import).
 */

import { mkdirSync, writeFileSync, readFileSync, unlinkSync, appendFileSync, renameSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

import type {
  AgentIdentity,
  WakeEvent,
  WakeListenerConfig,
  WakeResponse,
  DiscoveryFile,
} from './wake-types'
import { DISCOVERY_DIR, discoveryDir, WAKE_EVENT_TYPES, WARM_CHANNEL_TTL_MS } from './wake-types'

// ─── Constants ────────────────────────────────────────────

const DEBUG = process.env.WAKE_LISTENER_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'wake-listener-debug.log')
const MAX_QUEUE_DEFAULT = 50
const BUSY_RETRY_INTERVAL_DEFAULT = 5 // seconds
const STARTUP_TS = Date.now()
const FALLBACK_REPLAY_LIMIT = 20
const FALLBACK_REPLAY_TIMEOUT_MS = 3000
const DEDUP_CACHE_LIMIT = 500

// ─── Logging (standalone — mirrors signal-wire.ts dbg() pattern) ─

function dbg(...args: any[]) {
  if (!DEBUG) return
  try {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [wake-listener] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    )
  } catch {}
}

// ─── Handle ─────────────────────────────────────────────────────────

export interface WakeListenerHandle {
  port: number
  token: string
  server: ReturnType<typeof Bun.serve>
  stop: () => void
}

// ─── Warm Channel Tracking ──────────────────────────────────────────
// Tracks channels where this agent recently participated.
// Warm = agent replied in last WARM_CHANNEL_TTL_MS → compact notification (reference only)
// Cold = first contact or stale → full message with instructions

// CR-05: TTL imported from wake-types (SSOT). See WARM_CHANNEL_TTL_MS.
const warmChannels = new Map<string, { lastReply: number; messageCount: number }>()

/** Mark a channel as warm (agent just interacted). Called after injection. */
function markChannelWarm(channelId: string) {
  const existing = warmChannels.get(channelId)
  warmChannels.set(channelId, {
    lastReply: Date.now(),
    messageCount: (existing?.messageCount ?? 0) + 1,
  })
}

/** Check if a channel is warm (agent active in it recently). */
function isChannelWarm(channelId: string): boolean {
  const entry = warmChannels.get(channelId)
  if (!entry) return false
  if (Date.now() - entry.lastReply > WARM_CHANNEL_TTL_MS) {
    warmChannels.delete(channelId)
    return false
  }
  return true
}

// ─── Agent Identity (CR-02: from SynqTask, DB-03: AGENTS.md fallback) ───

/** Module-level identity cache — populated once at startup, reused for all wake messages.
 *  Exported for signal-wire-actions.ts to prepend identity block on engine-routed wakes. */
export let _agentIdentity: AgentIdentity | null = null

/**
 * OpenCode SDK client for in-process session API calls.
 * Typed as `any` (intentional tech debt — ARCH-02).
 * Assumed response shapes (from @opencode-ai/sdk types.gen.d.ts):
 *   session.list()        → { data: Array<{id, directory, parentID, time}> }
 *   session.get({path})   → { data: {id, parentID, parent_id, ...} }
 *   session.status()      → { data: {sessions: [{status: 'streaming'|'idle'|...}]} }
 *   session.prompt({...}) → { data: {...}, error?: ... }
 *   session.promptAsync() → { data: {...}, error?: ... }
 * When usage grows beyond current 9 call sites, consider importing
 * OpencodeClient type from @opencode-ai/sdk for compile-time checking.
 */
let _sdkClient: any = null

type SynqtaskMcpCallOptions = {
  synqtaskUrl?: string
  timeoutMs?: number
}

type LifecycleAction = 'starting' | 'online' | 'busy' | 'injecting' | 'resting' | 'offline'

type TaskSyncAction = 'start_accepted' | 'start_injected' | 'start_comment' | 'result_recorded' | 'completed' | 'failed'

type LifecycleSyncInput = {
  action: LifecycleAction
  currentTaskId?: string | null
  event?: WakeEvent
  reason?: string
  force?: boolean
}

const LIFECYCLE_SYNC_MIN_INTERVAL_MS = 30_000
let _lifecycleLastSyncAt = 0
let _lifecycleLastKey = ''
let _lifecycleConfig: WakeListenerConfig | null = null
let _lifecycleMemberId: string | null = null
let _lastActivityCursor: string | null = null
const _seenWakeEventIds = new Set<string>()
const _seenWakeFingerprints = new Set<string>()
const _taskSyncKeys = new Set<string>()

function extractWakeTaskId(event?: WakeEvent): string | null {
  const payload = event?.payload as Record<string, any> | undefined
  if (!payload) return null
  const taskId = payload.task_id ?? payload.taskId ?? payload.entityId
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : null
}

function wakeFingerprint(event?: WakeEvent): string | null {
  const payload = event?.payload as Record<string, any> | undefined
  const fingerprint = event?.fingerprint ?? payload?.fingerprint
  return typeof fingerprint === 'string' && fingerprint.length > 0 ? fingerprint : null
}

function extractWakeTaskTitle(event: WakeEvent, taskId: string): string {
  const payload = event.payload as Record<string, any>
  const title = payload.title ?? payload.taskTitle ?? payload.task_title ?? payload.name
  return typeof title === 'string' && title.trim().length > 0 ? title.trim() : `task ${taskId}`
}

function taskSyncMetadataValue(event: WakeEvent, taskId: string, action: TaskSyncAction): string {
  return JSON.stringify({
    action,
    taskId,
    syncedAt: new Date().toISOString(),
    sessionId: _lifecycleConfig?.sessionId ?? null,
    agentInstanceId: _lifecycleConfig?.agentInstanceId ?? null,
    memberId: _lifecycleMemberId ?? _agentIdentity?.memberId ?? null,
    eventId: event.eventId,
    eventType: event.type,
    source: event.source,
    fingerprint: wakeFingerprint(event),
  })
}

function rememberTaskSync(action: TaskSyncAction, taskId: string, event: WakeEvent): boolean {
  const key = [
    action,
    taskId,
    event.eventId,
    wakeFingerprint(event) ?? '',
    _lifecycleConfig?.sessionId ?? '',
    _lifecycleConfig?.agentInstanceId ?? '',
  ].join(':')
  if (_taskSyncKeys.has(key)) return false
  _taskSyncKeys.add(key)
  const oldest = _taskSyncKeys.values().next().value
  if (_taskSyncKeys.size > DEDUP_CACHE_LIMIT && oldest) _taskSyncKeys.delete(oldest)
  return true
}

async function syncTaskStart(event: WakeEvent, action: Extract<TaskSyncAction, 'start_accepted' | 'start_injected'>): Promise<void> {
  const config = _lifecycleConfig
  const taskId = extractWakeTaskId(event)
  if (isExplicitCompletion(event) || isExplicitFailure(event) || explicitResultText(event)) return
  if (!config || !taskId || !rememberTaskSync(action, taskId, event)) return

  const status = action === 'start_accepted' ? 'started' : 'in_progress'
  try {
    await callSynqtaskMcp(
      'todo_tasks',
      { action: 'set_status', task_id: taskId, status },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
    dbg(`task sync: ${action} task=${taskId} status=${status} event=${event.eventId} fp=${wakeFingerprint(event) ?? '-'}`)
  } catch (e: any) {
    dbg(`task sync start failed (non-fatal): action=${action} task=${taskId} event=${event.eventId} error=${e?.message}`)
  }

  if (rememberTaskSync('start_comment', taskId, event)) {
    try {
      await callSynqtaskMcp(
        'todo_comments',
        { action: 'add', task_id: taskId, text: `Starting work on: ${extractWakeTaskTitle(event, taskId)}` },
        { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
      )
      dbg(`task sync: start_comment task=${taskId} event=${event.eventId} fp=${wakeFingerprint(event) ?? '-'}`)
    } catch (e: any) {
      dbg(`task start comment sync failed (non-fatal): task=${taskId} event=${event.eventId} error=${e?.message}`)
    }
  }

  const memberId = _lifecycleMemberId ?? _agentIdentity?.memberId
  if (!memberId || memberId === 'unknown') return
  try {
    await callSynqtaskMcp(
      'todo_members',
      { action: 'set_metadata', member_id: memberId, key: 'wakeTaskSync', value: taskSyncMetadataValue(event, taskId, action) },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
  } catch (e: any) {
    dbg(`task sync metadata failed (non-fatal): action=${action} task=${taskId} event=${event.eventId} error=${e?.message}`)
  }
}

function explicitResultText(event: WakeEvent): string | null {
  const payload = event.payload as Record<string, any>
  const result = payload.resultText ?? payload.result_text ?? payload.taskResult ?? payload.task_result ?? payload.completionResult ?? payload.completion_result
  return typeof result === 'string' && result.trim().length > 0 ? result : null
}

function isExplicitCompletion(event: WakeEvent): boolean {
  const payload = event.payload as Record<string, any>
  const status = String(payload.status ?? payload.taskStatus ?? payload.task_status ?? '').toLowerCase()
  return event.type === WAKE_EVENT_TYPES.TASK_COMPLETED
    || payload.completed === true
    || payload.complete === true
    || status === 'done'
    || status === 'completed'
}

function isExplicitFailure(event: WakeEvent): boolean {
  const payload = event.payload as Record<string, any>
  const status = String(payload.status ?? payload.taskStatus ?? payload.task_status ?? payload.resultStatus ?? payload.result_status ?? '').toLowerCase()
  return event.type === WAKE_EVENT_TYPES.TASK_FAILED
    || payload.failed === true
    || payload.failure === true
    || status === 'failed'
    || status === 'failure'
    || status === 'error'
}

async function syncExplicitTaskResultOrCompletion(event: WakeEvent): Promise<void> {
  const config = _lifecycleConfig
  const taskId = extractWakeTaskId(event)
  if (!config || !taskId) return

  const resultText = explicitResultText(event)
  if (resultText && rememberTaskSync('result_recorded', taskId, event)) {
    try {
      await callSynqtaskMcp(
        'todo_comments',
        { action: 'add_result', task_id: taskId, text: resultText },
        { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
      )
      dbg(`task sync: result_recorded task=${taskId} event=${event.eventId}`)
    } catch (e: any) {
      dbg(`task result sync failed (non-fatal): task=${taskId} event=${event.eventId} error=${e?.message}`)
    }
  }

  if (isExplicitCompletion(event) && rememberTaskSync('completed', taskId, event)) {
    try {
      await callSynqtaskMcp(
        'todo_tasks',
        { action: 'set_status', task_id: taskId, status: 'done' },
        { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
      )
      dbg(`task sync: completed task=${taskId} event=${event.eventId}`)
    } catch (e: any) {
      dbg(`task completion sync failed (non-fatal): task=${taskId} event=${event.eventId} error=${e?.message}`)
    }
  }

  if (isExplicitFailure(event) && rememberTaskSync('failed', taskId, event)) {
    try {
      await callSynqtaskMcp(
        'todo_tasks',
        { action: 'set_status', task_id: taskId, status: 'failed' },
        { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
      )
      dbg(`task sync: failed task=${taskId} event=${event.eventId}`)
    } catch (e: any) {
      dbg(`task failure sync failed (non-fatal): task=${taskId} event=${event.eventId} error=${e?.message}`)
    }
  }
}

function lifecycleMetadataValue(input: LifecycleSyncInput, config: WakeListenerConfig): string {
  const now = new Date().toISOString()
  const event = input.event
  const payload = event?.payload as Record<string, any> | undefined
  const spaceId = config.agentRegistration?.spaceId ?? process.env.SYNQTASK_SPACE_ID
  return JSON.stringify({
    action: input.action,
    currentTaskId: input.currentTaskId ?? extractWakeTaskId(event) ?? null,
    lastActive: now,
    memberType: _currentMemberType,
    sessionId: config.sessionId,
    agentInstanceId: config.agentInstanceId ?? null,
    spaceId: spaceId ?? null,
    eventId: event?.eventId ?? null,
    eventType: event?.type ?? null,
    source: event?.source ?? null,
    fingerprint: event?.fingerprint ?? payload?.fingerprint ?? null,
    reason: input.reason ?? null,
  })
}

function lifecycleRuntimeState(action: LifecycleAction): 'starting' | 'online' | 'busy' | 'resting' {
  if (action === 'starting') return 'starting'
  if (action === 'online') return 'online'
  if (action === 'busy' || action === 'injecting') return 'busy'
  return 'resting'
}

async function syncLifecycle(input: LifecycleSyncInput): Promise<void> {
  const config = _lifecycleConfig
  const memberId = _lifecycleMemberId ?? _agentIdentity?.memberId
  if (!config || !memberId || memberId === 'unknown') return

  const currentTaskId = input.currentTaskId ?? extractWakeTaskId(input.event) ?? null
  const key = `${input.action}:${currentTaskId ?? ''}:${input.event?.eventId ?? ''}:${input.reason ?? ''}`
  const now = Date.now()
  if (!input.force && key === _lifecycleLastKey && now - _lifecycleLastSyncAt < LIFECYCLE_SYNC_MIN_INTERVAL_MS) return

  _lifecycleLastKey = key
  _lifecycleLastSyncAt = now

  const metadata = lifecycleMetadataValue({ ...input, currentTaskId }, config)
  try {
    await callSynqtaskMcp(
      'todo_members',
      {
        action: 'batch_update_active',
        updates: [{
          member_id: memberId,
          last_active_at: new Date().toISOString(),
          runtime_state: lifecycleRuntimeState(input.action),
        }],
      },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
  } catch (e: any) {
    dbg(`lifecycle lastActive update failed (non-fatal): action=${input.action} event=${input.event?.eventId ?? '-'} error=${e?.message}`)
  }

  try {
    await callSynqtaskMcp(
      'todo_members',
      { action: 'set_metadata', member_id: memberId, key: 'wakeLifecycle', value: metadata },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
    await callSynqtaskMcp(
      'todo_members',
      { action: 'set_metadata', member_id: memberId, key: 'currentTaskId', value: currentTaskId ?? '' },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
    dbg(`lifecycle sync: action=${input.action} member=${memberId} task=${currentTaskId ?? '-'} event=${input.event?.eventId ?? '-'}`)
  } catch (e: any) {
    dbg(`lifecycle metadata update failed (non-fatal): action=${input.action} event=${input.event?.eventId ?? '-'} error=${e?.message}`)
  }
}

// ─── Subscription State (written to discovery file) ─────────────────
let _currentSubscribe: string[] | null = null
let _currentSubscribePreset: string | null = null
let _currentMemberType: 'human' | 'agent' | 'unknown' = 'unknown'

function readSynqtaskBearerToken(): string {
  let bearerToken = process.env.SYNQTASK_BEARER_TOKEN ?? ''
  if (bearerToken) return bearerToken
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'mcp-auth.json')
    const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
    bearerToken = authData?.synqtask?.tokens?.accessToken ?? ''
  } catch { /* no mcp-auth.json, proceed without auth */ }
  return bearerToken
}

async function callSynqtaskMcp<T = any>(
  toolName: string,
  operations: unknown,
  options: SynqtaskMcpCallOptions = {},
): Promise<T | null> {
  const url = options.synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? 'http://localhost:3747'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  }
  const bearerToken = readSynqtaskBearerToken()
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`

  const res = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: { operations } },
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const text = await res.text()
  const dataLine = text.split('\n').find(l => l.startsWith('data: '))
  if (!dataLine) throw new Error('no data line in response')

  const rpcResult = JSON.parse(dataLine.substring(6))
  const content = rpcResult?.result?.content?.[0]?.text
  if (!content) throw new Error('empty content')

  const parsed = JSON.parse(content)
  const result = parsed?.results?.[0]?.result ?? parsed
  return result as T
}

function synqtaskRestHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Accept': 'application/json' }
  const bearerToken = readSynqtaskBearerToken()
  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`
  return headers
}

function rememberWakeEvent(event: WakeEvent): void {
  const addLimited = (set: Set<string>, value?: string | null) => {
    if (!value) return
    set.add(value)
    const oldest = set.values().next().value
    if (set.size > DEDUP_CACHE_LIMIT && oldest) set.delete(oldest)
  }
  addLimited(_seenWakeEventIds, event.eventId)
  addLimited(_seenWakeFingerprints, event.fingerprint ?? (event.payload as any)?.fingerprint)
}

function hasSeenWakeEvent(event: WakeEvent): boolean {
  const fingerprint = event.fingerprint ?? (event.payload as any)?.fingerprint
  return _seenWakeEventIds.has(event.eventId) || (!!fingerprint && _seenWakeFingerprints.has(fingerprint))
}

function stableHash(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function stableStringify(value: any): string {
  try {
    return JSON.stringify(value, Object.keys(value ?? {}).sort())
  } catch {
    return String(value)
  }
}

function activityCursorValue(value: any): string | null {
  const cursor = value?.cursor ?? value?.activityCursor ?? value?.id ?? value?.lastId
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : null
}

function activityEntries(value: any): any[] {
  const entries = value?.entries ?? value?.items ?? value?.activities ?? value?.results ?? value
  return Array.isArray(entries) ? entries : []
}

function inferWakeType(entry: any, payload: Record<string, any>): string {
  const raw = String(entry?.type ?? entry?.eventType ?? entry?.action ?? '').toLowerCase()
  const entityType = String(entry?.entityType ?? payload.entityType ?? '').toLowerCase()
  if (raw.includes('message') || entityType === 'channel' || entityType === 'message') return WAKE_EVENT_TYPES.CHANNEL_MESSAGE
  if (raw.includes('comment') || entityType === 'comment') return WAKE_EVENT_TYPES.COMMENT_ADDED
  if (raw.includes('delegat')) return WAKE_EVENT_TYPES.DELEGATION_RECEIVED
  if (raw.includes('assign')) return WAKE_EVENT_TYPES.TASK_ASSIGNED
  if (raw.includes('status') || raw.includes('update') || raw.includes('change')) return WAKE_EVENT_TYPES.STATUS_CHANGED
  return raw || 'webhook_event'
}

function activityTargetMemberId(payload: Record<string, any>, fallbackMemberId: string | null): string {
  const target = payload.targetMemberId ?? payload.target_member_id ?? payload.assigneeId ?? payload.assignee_id
    ?? payload.memberId ?? payload.member_id ?? payload.toMemberId ?? payload.to_member_id
  return typeof target === 'string' && target.length > 0 ? target : (fallbackMemberId ?? '')
}

function activityToWakeEvent(entry: any, config: WakeListenerConfig): WakeEvent | null {
  const payloadSource = (entry?.payload ?? entry?.data ?? entry?.details ?? {}) as Record<string, any>
  const payload: Record<string, any> = {
    ...payloadSource,
    activityId: entry?.id ?? entry?.activityId ?? null,
    activityType: entry?.type ?? entry?.eventType ?? entry?.action ?? null,
    entityType: entry?.entityType ?? payloadSource.entityType ?? null,
    entityId: entry?.entityId ?? payloadSource.entityId ?? payloadSource.taskId ?? payloadSource.task_id ?? null,
    replayedFromActivity: true,
  }
  const eventType = inferWakeType(entry, payload)
  const targetMemberId = activityTargetMemberId(payload, _lifecycleMemberId ?? _agentIdentity?.memberId ?? config.memberId ?? null)
  if (!targetMemberId) return null

  const sourceId = entry?.eventId ?? entry?.id ?? entry?.activityId ?? stableHash(stableStringify(entry))
  const timestamp = entry?.timestamp ?? entry?.createdAt ?? entry?.ts ?? new Date().toISOString()
  const fingerprint = `replay:${entry?.fingerprint ?? stableHash(`${eventType}:${targetMemberId}:${sourceId}:${stableStringify(payload)}`)}`
  return {
    schemaVersion: 1,
    eventId: `replay:${sourceId}:${targetMemberId}:${stableHash(eventType)}`,
    source: 'synqtask.activity',
    type: eventType,
    priority: 'info',
    targetMemberId,
    payload: { ...payload, fingerprint, replaySourceEventId: sourceId },
    timestamp,
    fingerprint,
  }
}

function isWakeEventSubscribed(event: WakeEvent): boolean {
  const subscribe = _currentSubscribe
  if (!subscribe) return true
  if (subscribe.length === 0) return false
  return subscribe.includes('*') || subscribe.includes(event.type) || subscribe.includes(`${event.source}:${event.type}`)
}

function isWakeEventRelevant(event: WakeEvent): boolean {
  const memberId = _lifecycleMemberId ?? _agentIdentity?.memberId ?? null
  if (!memberId || memberId === 'unknown') return true
  if (event.targetMemberId === memberId) return true
  const payload = event.payload as Record<string, any>
  const mentioned = payload.mentions ?? payload.memberIds ?? payload.channelMemberIds
  return Array.isArray(mentioned) && mentioned.includes(memberId)
}

async function fetchActivityCursor(config: WakeListenerConfig): Promise<string | null> {
  try {
    const result = await callSynqtaskMcp<any>(
      'todo_io',
      { action: 'activity_cursor' },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs ?? FALLBACK_REPLAY_TIMEOUT_MS },
    )
    const cursor = activityCursorValue(result)
    if (cursor) return cursor
  } catch (e: any) {
    dbg(`activity cursor MCP fallback failed-open: ${e?.message}`)
  }

  const url = config.synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? 'http://localhost:3747'
  const res = await fetch(`${url}/api/activity/cursor`, {
    headers: synqtaskRestHeaders(),
    signal: AbortSignal.timeout(config.identityFetchTimeoutMs ?? FALLBACK_REPLAY_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`cursor HTTP ${res.status}`)
  return activityCursorValue(await res.json())
}

async function pollActivity(config: WakeListenerConfig, cursor: string | null): Promise<{ entries: any[]; cursor: string | null }> {
  const url = config.synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? 'http://localhost:3747'
  const qs = new URLSearchParams({ limit: String(FALLBACK_REPLAY_LIMIT), save: '0' })
  if (cursor) qs.set('cursor', cursor)
  const res = await fetch(`${url}/api/activity/poll?${qs.toString()}`, {
    headers: synqtaskRestHeaders(),
    signal: AbortSignal.timeout(config.identityFetchTimeoutMs ?? FALLBACK_REPLAY_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`poll HTTP ${res.status}`)
  const body = await res.json()
  return { entries: activityEntries(body), cursor: activityCursorValue(body) }
}

// ─── Spawn Budget Tracking (Stage 2 + 2.1) ──────────────────────────
let _spawnTotal = 0        // total helpers spawned (lifetime, informational)
let _spawnActive = 0       // currently active helpers (for concurrent limit)
let _currentDepth: number | null = null  // cached, resolved lazily

// Stage 2.1: Read inherited spawn depth from parent (REQ-16c)
// Parent sets __SPAWN_DEPTH before spawning child → child reads at startup
const _inheritedDepth = parseInt(process.env.__SPAWN_DEPTH ?? '', 10)
if (!isNaN(_inheritedDepth) && _inheritedDepth >= 0) {
  _currentDepth = _inheritedDepth  // O(1) depth, no parent_id walking needed
  dbg(`spawn depth inherited from parent: ${_inheritedDepth}`)
}

// Stage 2.1: Parent identity for chain tracking (REQ-16b)
export const _parentMemberId = process.env.__PARENT_MEMBER_ID ?? null
export const _parentSessionId = process.env.__PARENT_SESSION_ID ?? null

/** Get total helpers spawned (lifetime) */
export function getSpawnTotal(): number { return _spawnTotal }

/** Get currently active helpers (estimated via timeout decay) */
export function getSpawnActive(): number {
  const now = Date.now()
  // Expire helpers older than HELPER_TIMEOUT_MS (they're done or stuck)
  while (_activeHelperTimestamps.length > 0 && now - _activeHelperTimestamps[0] > HELPER_TIMEOUT_MS) {
    _activeHelperTimestamps.shift()
  }
  return _activeHelperTimestamps.length
}

const HELPER_TIMEOUT_MS = 60_000  // 60s — generous timeout for explore/plan helpers
const _activeHelperTimestamps: number[] = []

/** Helper started — track timestamp for concurrent counting */
export function helperStarted(): void {
  _spawnTotal++
  _activeHelperTimestamps.push(Date.now())
}

/** Helper finished — remove oldest timestamp */
export function helperFinished(): void {
  _activeHelperTimestamps.shift()
}

/** Get agent identity (for provider.ts budget checks) */
export function getAgentIdentity(): AgentIdentity | null { return _agentIdentity }

/** Get current depth (may be inherited from parent or resolved lazily) */
export function getCurrentDepth(): number | null { return _currentDepth }

/**
 * Resolve current session depth.
 * Priority: inherited from env (O(1)) → walk parent_id chain (O(depth)) → 0.
 * Cached after first resolution.
 */
export async function resolveCurrentDepth(sessionId: string): Promise<number> {
  if (_currentDepth !== null) return _currentDepth

  let depth = 0
  let currentId = sessionId

  try {
    for (let i = 0; i < 10; i++) {  // safety limit
      if (!_sdkClient) { dbg('resolveCurrentDepth: no sdkClient'); break }
      const { data: session } = await _sdkClient.session.get({ path: { id: currentId } })
      if (!session) break
      if (!session.parent_id && !session.parentId) break
      depth++
      currentId = session.parent_id ?? session.parentId
    }
  } catch {
    // CN-07: fail-open — if can't resolve, assume depth 0
    dbg('resolveCurrentDepth: failed, assuming 0')
  }

  _currentDepth = depth
  dbg(`resolveCurrentDepth: depth=${depth}`)
  return depth
}

/**
 * Check if spawn is allowed given current budget.
 * Returns { allowed, reason } for clear error messaging (CR-09).
 */
export function checkSpawnAllowed(
  identity: AgentIdentity,
  currentDepth: number,
  activeHelpers: number,
): { allowed: boolean; reason?: string; depth: number; maxDepth: number; active: number; maxConcurrent: number } {
  const budget = identity.budget ?? { maxSpawnDepth: 2, maxSubagents: 5 }
  // Read concurrent limit from metadata (maxConcurrentHelpers), fallback to maxSubagents
  const maxConcurrent = (identity as any)._maxConcurrent ?? budget.maxSubagents

  if (activeHelpers >= maxConcurrent) {
    return {
      allowed: false,
      reason: [
        `⚠️ Лимит одновременных хелперов: ${activeHelpers}/${maxConcurrent} активны.`,
        `Дождись завершения текущих хелперов, потом вызывай новых.`,
        `Для делегирования работы коллегам используй SynqTask:`,
        `  todo_tasks({action:"delegate", task_id:"...", to_member_id:"..."})`,
      ].join('\n'),
      depth: currentDepth, maxDepth: budget.maxSpawnDepth,
      active: activeHelpers, maxConcurrent,
    }
  }

  return {
    allowed: true,
    depth: currentDepth, maxDepth: budget.maxSpawnDepth,
    active: activeHelpers, maxConcurrent,
  }
}

/**
 * Fetch agent identity from SynqTask via MCP `get_role_prompt`.
 * Falls back to parseAgentsMd() on any failure (CN-01: never blocks startup).
 * URL resolution: param → env SYNQTASK_API_URL → localhost default (CN-04).
 */
async function fetchIdentity(
  memberId: string,
  synqtaskUrl?: string,
  timeoutMs?: number,
): Promise<AgentIdentity | null> {
  const url = synqtaskUrl ?? process.env.SYNQTASK_API_URL ?? 'http://localhost:3747'
  try {
    const result = await callSynqtaskMcp<any>(
      'todo_members',
      { action: 'get_role_prompt', member_id: memberId },
      { synqtaskUrl, timeoutMs },
    )
    if (!result) return parseAgentsMd()

    // Map to AgentIdentity
    const identity: AgentIdentity = {
      memberId,
      name: result.displayName ?? result.memberName ?? memberId,
      displayName: result.displayName,
      roleName: result.role?.name ?? null,
      rolePrompt: result.role?.systemPrompt ?? null,
      teamName: result.team?.name ?? null,
      teamPlaybook: result.team?.purpose ?? null,
      teammates: [], // will populate below
      fetchedAt: Date.now(),
    }

    // Fetch teammates if team exists
    if (result.team?.id) {
      try {
        const teamRes = await fetch(`${url}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream',
            ...(readSynqtaskBearerToken() ? { Authorization: `Bearer ${readSynqtaskBearerToken()}` } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 2,
            method: 'tools/call',
            params: { name: 'todo_teams', arguments: { operations: { action: 'members', team_id: result.team.id } } },
          }),
          signal: AbortSignal.timeout(timeoutMs ?? 3000),
        })
        if (teamRes.ok) {
          const teamText = await teamRes.text()
          const teamDataLine = teamText.split('\n').find(l => l.startsWith('data: '))
          if (teamDataLine) {
            const teamRpc = JSON.parse(teamDataLine.substring(6))
            const teamContent = teamRpc?.result?.content?.[0]?.text
            if (teamContent) {
              const teamParsed = JSON.parse(teamContent)
              const members = teamParsed?.results?.[0]?.result ?? []
              // Team members API returns {memberId, role} — need to resolve names
              // Batch fetch member details for each teammate
              const teammateIds = members
                .map((m: any) => m.memberId ?? m.id)
                .filter((id: string) => id && id !== memberId)
              for (const tid of teammateIds) {
                try {
                  const mRes = await fetch(`${url}/mcp`, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Accept': 'application/json, text/event-stream',
                      ...(readSynqtaskBearerToken() ? { Authorization: `Bearer ${readSynqtaskBearerToken()}` } : {}),
                    },
                    body: JSON.stringify({
                      jsonrpc: '2.0', id: 3,
                      method: 'tools/call',
                      params: { name: 'todo_members', arguments: { operations: { action: 'get_role_prompt', member_id: tid } } },
                    }),
                    signal: AbortSignal.timeout(timeoutMs ?? 3000),
                  })
                  if (mRes.ok) {
                    const mText = await mRes.text()
                    const mLine = mText.split('\n').find(l => l.startsWith('data: '))
                    if (mLine) {
                      const mRpc = JSON.parse(mLine.substring(6))
                      const mContent = mRpc?.result?.content?.[0]?.text
                      if (mContent) {
                        const mData = JSON.parse(mContent)
                        const member = mData?.results?.[0]?.result ?? mData
                        identity.teammates.push({
                          name: member.displayName ?? member.name ?? tid.slice(0, 8),
                          roleName: member.role?.name ?? null,
                        })
                      }
                    }
                  }
                } catch { /* skip failed teammate lookup */ }
              }
            }
          }
        }
      } catch (e: any) { dbg(`fetchIdentity: team fetch failed: ${e?.message}`) }
    }

    // Extract helper budget from role metadata (Stage 2 + 2.1)
    // maxHelperDepth = max nesting depth for helpers (explore→plan)
    // maxConcurrentHelpers = max simultaneous helpers
    if (result.role?.metadata) {
      const md = result.role.metadata as Record<string, string>
      const maxConcurrent = parseInt(md.maxConcurrentHelpers ?? md.maxHelpers ?? md.maxSubagents ?? '5', 10) || 5
      identity.budget = {
        maxSpawnDepth: parseInt(md.maxHelperDepth ?? md.maxSpawnDepth ?? '2', 10) || 2,
        maxSubagents: maxConcurrent,
      }
      // Store concurrent limit separately for checkSpawnAllowed
      ;(identity as any)._maxConcurrent = maxConcurrent
    }

    dbg(`fetchIdentity: OK name=${identity.name} role=${identity.roleName} team=${identity.teamName} teammates=${identity.teammates.length} budget=${identity.budget ? `depth=${identity.budget.maxSpawnDepth},subs=${identity.budget.maxSubagents}` : 'none'} playbook=${identity.teamPlaybook ? 'yes' : 'no'}`)
    return identity
  } catch (e: any) {
    dbg(`fetchIdentity: failed: ${e?.message}`)
    return parseAgentsMd()
  }
}

function firstMemberId(value: any): string | null {
  const item = Array.isArray(value) ? value[0]
    : Array.isArray(value?.members) ? value.members[0]
    : Array.isArray(value?.results) ? value.results[0]
    : value
  return item?.id ?? item?.memberId ?? item?.member?.id ?? item?.result?.id ?? item?.result?.memberId ?? null
}

async function setMemberMetadata(
  memberId: string,
  key: string,
  value: string | undefined,
  config: WakeListenerConfig,
): Promise<void> {
  if (!value) return
  try {
    await callSynqtaskMcp(
      'todo_members',
      { action: 'set_metadata', member_id: memberId, key, value },
      { synqtaskUrl: config.synqtaskUrl, timeoutMs: config.identityFetchTimeoutMs },
    )
  } catch (e: any) {
    dbg(`agent registration metadata ${key} failed (non-fatal): ${e?.message}`)
  }
}

async function resolveOrRegisterAgentIdentity(config: WakeListenerConfig): Promise<{
  memberId?: string
  memberName?: string
  memberType: 'human' | 'agent' | 'unknown'
}> {
  if (config.memberId) {
    try {
      _agentIdentity = await fetchIdentity(
        config.memberId,
        config.synqtaskUrl,
        config.identityFetchTimeoutMs,
      )
      dbg(`identity: ${_agentIdentity?.name ?? 'null'} role=${_agentIdentity?.roleName ?? 'none'} team=${_agentIdentity?.teamName ?? 'none'} teammates=${_agentIdentity?.teammates?.length ?? 0}`)
    } catch (e: any) {
      // CN-01: never crash on identity fetch failure
      dbg(`identity fetch failed (non-fatal): ${e?.message}`)
    }
    return {
      memberId: config.memberId,
      memberName: _agentIdentity?.name ?? config.memberId,
      memberType: config.memberType ?? 'unknown',
    }
  }

  const envEnabled = process.env.SYNQTASK_AGENT_REGISTRATION === '1' || process.env.SYNQTASK_REGISTER_AGENT === '1'
  const registration = config.agentRegistration
  const enabled = registration?.enabled ?? envEnabled
  if (!enabled) {
    dbg('agent registration skipped: no memberId and registration not enabled')
    return { memberType: config.memberType ?? 'unknown' }
  }

  const timeoutMs = config.identityFetchTimeoutMs
  const synqtaskUrl = config.synqtaskUrl
  const name = registration?.name
    ?? process.env.SYNQTASK_AGENT_NAME
    ?? `opencode-agent-${process.pid}`
  const displayName = registration?.displayName ?? name
  const description = registration?.description
    ?? `OpenCode agent session ${config.sessionId} (${config.agentInstanceId ?? 'no-instance-id'})`

  try {
    let memberId: string | null = null
    if (config.agentInstanceId) {
      const existing = await callSynqtaskMcp(
        'todo_members',
        { action: 'search_by_metadata', key: 'agentInstanceId', value: config.agentInstanceId },
        { synqtaskUrl, timeoutMs },
      )
      memberId = firstMemberId(existing)
      if (memberId) dbg(`agent registration reconciled by agentInstanceId: ${memberId}`)
    }

    if (!memberId) {
      const added = await callSynqtaskMcp(
        'todo_members',
        {
          action: 'add',
          name,
          display_name: displayName,
          description,
          member_type: 'agent',
        },
        { synqtaskUrl, timeoutMs },
      )
      memberId = firstMemberId(added)
      if (!memberId) throw new Error('todo_members.add returned no member id')
      dbg(`agent registration created member: ${memberId}`)
    }

    await setMemberMetadata(memberId, 'sessionId', config.sessionId, config)
    await setMemberMetadata(memberId, 'agentInstanceId', config.agentInstanceId, config)
    await setMemberMetadata(memberId, 'spaceId', registration?.spaceId ?? process.env.SYNQTASK_SPACE_ID, config)

    const fetched = await fetchIdentity(memberId, synqtaskUrl, timeoutMs)
    _agentIdentity = fetched?.memberId && fetched.memberId !== 'unknown'
      ? fetched
      : {
        memberId,
        name: displayName,
        displayName,
        roleName: null,
        rolePrompt: null,
        teamName: null,
        teammates: [],
        fetchedAt: Date.now(),
      }

    return { memberId, memberName: _agentIdentity.name, memberType: 'agent' }
  } catch (e: any) {
    dbg(`agent registration degraded (non-fatal): ${e?.message}`)
    return { memberName: displayName, memberType: config.memberType ?? 'unknown' }
  }
}

/**
 * Parse AGENTS.md from cwd as fallback identity source (DB-03, AMD-04).
 * Returns null if file missing or unparseable — never throws (CN-01).
 */
function parseAgentsMd(): AgentIdentity | null {
  try {
    const agentsMdPath = join(process.cwd(), 'AGENTS.md')
    const content = readFileSync(agentsMdPath, 'utf-8')

    // Step 1: Extract name from first heading
    const nameMatch = content.match(/^#\s+(?:Agent\s+)?(.+)/im)
    const name = nameMatch?.[1]?.trim() ?? null

    // Step 2: Extract role from ## Роль or ## Role section
    const roleMatch = content.match(/##\s+(?:Роль|Role)[^\n]*\n([\s\S]*?)(?=\n##|\n$)/i)
    const rolePrompt = roleMatch?.[1]?.trim() ?? null

    // Step 3: Extract memberId (UUID pattern)
    const idMatch = content.match(/Member ID.*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)
    const memberId = idMatch?.[1] ?? null

    if (!name) {
      dbg('parseAgentsMd: no name found')
      return null
    }

    dbg(`parseAgentsMd: fallback OK name=${name}`)
    return {
      memberId: memberId ?? 'unknown',
      name,
      roleName: null,
      rolePrompt,
      teamName: null,
      teammates: [],
      fetchedAt: Date.now(),
    }
  } catch {
    dbg('parseAgentsMd: file not found or parse error')
    return null
  }
}

// ─── Format Wake Message ────────────────────────────────────────────

/** Format wake event with actionable instructions per event type.
 *  Standalone — no imports from signal-wire.ts (avoids circular deps).
 *
 *  WARM channels: compact reference (~40 tokens) — agent already has context
 *  COLD channels: full message with instructions (~100-150 tokens)
 */
export function formatWakeMessage(event: WakeEvent, identity?: AgentIdentity | null): string {
  const p = event.payload as Record<string, any>
  const esc = (s: string) => s.replace(/"/g, '&quot;')
  const tag = `<system-reminder type="wake" source="${esc(event.source)}" priority="${event.priority}" event-id="${esc(event.eventId)}">`
  const end = `</system-reminder>`

  // ── CR-01, DB-05: Prepend <agent-identity> block if identity is available ──
  // CN-02: identity block target ≤60 words (≈80 tokens). rolePrompt is the variable part.
  let identityBlock = ''
  if (identity) {
    const teammatesList = identity.teammates.length > 0
      ? identity.teammates.map(t => `${t.name} (${t.roleName ?? '?'})`).join(', ')
      : 'none'
    const identityLines = [
      `<agent-identity name="${identity.name}" role="${identity.roleName ?? 'unassigned'}" team="${identity.teamName ?? 'none'}">`,
      `You are ${identity.name}. ${identity.rolePrompt ?? 'No role assigned.'}`,
      `Team: ${identity.teamName ?? 'none'}. Teammates: ${teammatesList}.`,
    ]
    if (identity.budget) {
      // Budget line only shown when budget fields exist (Stage 2)
      identityLines.push(`Helpers: max ${identity.budget.maxSubagents} concurrent, depth ${identity.budget.maxSpawnDepth}. Делегирование коллегам: SynqTask todo_tasks delegate.`)
    }
    identityLines.push(`</agent-identity>`)
    identityBlock = identityLines.join('\n')
  }

  let body: string

  switch (event.type) {
    case WAKE_EVENT_TYPES.CHANNEL_MESSAGE: {
      const chId = p.channel_id ?? p.channelId ?? ''
      // Canonical SynqTask wake payload uses authorName/authorId. Older keys
      // (sender_name/senderName/senderId) kept for backward compat with any
      // non-SynqTask wake source.
      const sendName = p.authorName ?? p.author_name ?? p.sender_name ?? p.senderName ?? p.authorId ?? p.senderId ?? 'unknown'
      const text = p.text ?? '(no text)'
      const warm = isChannelWarm(chId)

      if (warm) {
        // ── WARM: compact reference. Agent knows the channel and tools. ──
        const preview = text.length > 120 ? text.slice(0, 120) + '…' : text
        body = `**${sendName}** in channel \`${chId}\`:\n> ${preview}\nReply: \`todo_channels({action:"send", channel_id:"${chId}", text:"..."})\``
      } else {
        // ── COLD: full message + instructions (first contact) ──
        body = [
          `## Channel Message from ${sendName}`,
          `> ${text}`,
          `**Channel:** \`${chId}\``,
          `Reply: \`todo_channels({action:"send", channel_id:"${chId}", text:"YOUR REPLY"})\``,
          `Read history: \`todo_channels({action:"read", channel_id:"${chId}", limit:5})\``,
        ].join('\n')
      }
      // Mark warm after formatting (next message will be compact)
      markChannelWarm(chId)
      break
    }

    case WAKE_EVENT_TYPES.TASK_ASSIGNED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? ''
      body = [
        `## Task Assigned: ${p.title ?? 'Unknown'}`,
        taskId ? `Task: \`${taskId}\`` : '',
        p.description ? `> ${p.description}` : '',
        `Accept: \`todo_tasks({action:"set_status", task_id:"${taskId}", status:"started"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``,
      ].filter(Boolean).join('\n')
      break
    }

    case WAKE_EVENT_TYPES.COMMENT_ADDED: {
      const entityId = p.entity_id ?? p.entityId ?? ''
      body = [
        `## Comment on ${p.title ?? entityId}`,
        `From: ${p.actor_name ?? p.actorId ?? 'unknown'}`,
        `Read: \`todo_comments({action:"list", task_id:"${entityId}"})\``,
      ].join('\n')
      break
    }

    case WAKE_EVENT_TYPES.DELEGATION_RECEIVED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? ''
      body = [
        `## Delegation: ${p.title ?? 'Unknown'}`,
        `From: ${p.delegator ?? p.delegated_by ?? p.fromId ?? 'unknown'}`,
        `Accept: \`todo_tasks({action:"accept_delegation", task_id:"${taskId}"})\``,
        `Details: \`todo_tasks({action:"show", task_id:"${taskId}"})\``,
      ].join('\n')
      break
    }

    case WAKE_EVENT_TYPES.STATUS_CHANGED: {
      const taskId = p.task_id ?? p.taskId ?? p.entityId ?? ''
      const status = p.status ?? (p.changes as any)?.status?.to ?? '?'
      const title = p.title ?? taskId
      body = [
        `## Task Status: ${title} → ${status}`,
        `View: \`todo_tasks({action:"show", task_id:"${taskId}"})\``,
      ].join('\n')
      break
    }

    default:
      body = `Event: ${event.type}\n${JSON.stringify(p, null, 2)}`
  }

  return identityBlock ? `${identityBlock}\n${tag}\n${body}\n${end}` : `${tag}\n${body}\n${end}`
}

// ─── Busy Detection ─────────────────────────────────────────────────

/** Check if the agent is currently processing (streaming/busy). */
async function isAgentBusy(): Promise<boolean> {
  try {
    if (!_sdkClient) return false
    const { data } = await _sdkClient.session.status()
    return data?.sessions?.some?.((s: any) => s.status === 'streaming' || s.status === 'busy') ?? false
  } catch {
    return false
  }
}

// ─── Inject Wake Event (CR-02, DB-05) ───────────────────────────────

/**
 * Inject a wake event into the agent's LLM loop via sdkClient.session.promptAsync.
 * Uses noReply:false so the LLM processes and responds (CR-02).
 */
// Cached session ID — resolved lazily on first injection, reused after
let _cachedSessionId: string | null = null
let _discoveryPath: string | null = null

// CWD of this agent's serve instance — used to filter sessions
let _agentDirectory: string | null = null

function updateDiscoverySession(sessionId: string, agentInstanceId?: string): boolean {
  if (!_discoveryPath) {
    dbg('updateDiscoverySession: no discovery path')
    return false
  }
  try {
    const disc = JSON.parse(readFileSync(_discoveryPath, 'utf-8'))
    disc.sessionId = sessionId
    if (agentInstanceId) disc.agentInstanceId = agentInstanceId
    const tmpPath = _discoveryPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(disc))
    renameSync(tmpPath, _discoveryPath)
    dbg(`SESSION_BOUND discovery updated session=${sessionId} agentInstanceId=${disc.agentInstanceId ?? '-'}`)
    return true
  } catch (e: any) {
    dbg(`updateDiscoverySession failed: ${e?.message}`)
    return false
  }
}

export function bindWakeListenerSession(
  handle: WakeListenerHandle | null,
  sessionId: string,
  opts?: { agentInstanceId?: string; reason?: string },
): boolean {
  if (!handle) {
    dbg(`SESSION_BIND_WAITING no handle session=${sessionId}`)
    return false
  }
  if (!sessionId || sessionId === 'unknown') {
    dbg(`SESSION_BIND_WAITING invalid session=${sessionId}`)
    return false
  }
  if (_cachedSessionId && _cachedSessionId !== 'unknown' && _cachedSessionId !== sessionId) {
    dbg(`SESSION_BIND_AMBIGUOUS existing=${_cachedSessionId} candidate=${sessionId} reason=${opts?.reason ?? '-'}`)
    return false
  }
  _cachedSessionId = sessionId
  updateDiscoverySession(sessionId, opts?.agentInstanceId)
  dbg(`SESSION_BOUND session=${sessionId} reason=${opts?.reason ?? 'explicit'} agentInstanceId=${opts?.agentInstanceId ?? '-'}`)
  return true
}

async function resolveSessionId(sessionId: string): Promise<string | null> {
  // Return cached if already resolved
  if (_cachedSessionId && _cachedSessionId !== 'unknown') return _cachedSessionId

  // Use explicit session ID from env/config
  if (sessionId && sessionId !== 'unknown') {
    _cachedSessionId = sessionId
    return sessionId
  }

  // Fallback 1: read from discovery file (launcher updates it)
  if (_discoveryPath) {
    try {
      const disc = JSON.parse(readFileSync(_discoveryPath, 'utf-8'))
      if (disc.sessionId && disc.sessionId !== 'unknown') {
        _cachedSessionId = disc.sessionId
        dbg(`resolveSessionId from discovery file: ${_cachedSessionId}`)
        return _cachedSessionId
      }
    } catch { /* discovery file not ready yet */ }
  }

  // Degraded fallback: bind by directory only when exactly one candidate exists.
  // Multiple sessions in one workspace are ambiguous and must not be guessed.
  if (_agentDirectory) {
    try {
      if (!_sdkClient) { dbg('resolveSessionId: no sdkClient'); return null }
      const { data: sessions } = await _sdkClient.session.list()
      if (!Array.isArray(sessions)) return null
      const matches = sessions.filter((s: any) => s.directory === _agentDirectory)
      if (matches.length > 1) {
        dbg(`SESSION_BIND_AMBIGUOUS directory=${_agentDirectory} candidates=${matches.map((s: any) => s.id).join(',')}`)
        return null
      }
      const match = matches[0]
      if (match) {
        const matchedSessionId = String(match.id)
        _cachedSessionId = matchedSessionId
        dbg(`SESSION_BOUND_FALLBACK by directory ${_agentDirectory}: ${matchedSessionId}`)
        updateDiscoverySession(matchedSessionId)
        return matchedSessionId
      }
    } catch (e: any) { dbg(`resolveSessionId by directory failed: ${e?.message}`) }
  }

  dbg('resolveSessionId: no session ID yet, events will queue')
  return null
}

async function injectWakeEvent(
  event: WakeEvent,
  sessionId: string,
): Promise<boolean> {
  const resolvedSessionId = await resolveSessionId(sessionId)
  if (!resolvedSessionId) {
    dbg(`INJECT_DEFERRED_NO_SESSION event=${event.eventId}`)
    return false
  }
  if (!_sdkClient) {
    dbg('inject: no sdkClient')
    return false
  }

  const text = formatWakeMessage(event, _agentIdentity)

  try {
    await syncLifecycle({ action: 'injecting', event, currentTaskId: extractWakeTaskId(event) })
    const { error } = await _sdkClient.session.promptAsync({
      path: { id: resolvedSessionId },
      body: { noReply: false, parts: [{ type: 'text', text }] },
    })
    if (!error) {
      await syncTaskStart(event, 'start_injected')
      await syncLifecycle({ action: 'online', event, currentTaskId: extractWakeTaskId(event) })
      dbg(`inject OK: session=${resolvedSessionId}`)
      return true
    }
    dbg(`inject failed: ${error}`)
    return false
  } catch (e: any) {
    dbg(`inject error: ${e?.message}`)
    return false
  }
}

// ─── Start Wake Listener ────────────────────────────────────────────

/**
 * Start the L4 Plugin Wake Listener.
 *
 * - Spins up a Bun.serve() on a random port (or configured port)
 * - Generates a per-session auth token (CR-07)
 * - Writes a discovery file to DISCOVERY_DIR (DB-04)
 * - Returns a handle for stopping the listener
 */
export async function startWakeListener(
  config: WakeListenerConfig,
): Promise<WakeListenerHandle> {
  // Store agent directory for session resolution by CWD
  _agentDirectory = process.cwd()

  // Store sdkClient for in-process session API calls (ARCH-01)
  _sdkClient = config.sdkClient ?? null

  // Resolve known member identity or fail-open register/reconcile missing agent identity (CR-07).
  const resolvedIdentity = await resolveOrRegisterAgentIdentity(config)
  _currentMemberType = resolvedIdentity.memberType
  _lifecycleConfig = config
  _lifecycleMemberId = resolvedIdentity.memberId ?? config.memberId ?? _agentIdentity?.memberId ?? null
  await syncLifecycle({ action: 'starting', reason: 'listener_start', force: true })

  // Stage 3: Inject team playbook at session start (CR-11, CN-10: once, not per-wake)
  if (_agentIdentity?.teamPlaybook) {
    try {
      const playbookSessionId = await resolveSessionId(config.sessionId)
      if (playbookSessionId) {
        const playbookText = `<team-playbook team="${_agentIdentity.teamName ?? 'unknown'}">\n${_agentIdentity.teamPlaybook}\n</team-playbook>`
        if (!_sdkClient) { dbg('playbook: no sdkClient') } else {
          await _sdkClient.session.prompt({
            path: { id: playbookSessionId },
            body: { noReply: true, parts: [{ type: 'text', text: playbookText }] },
          })
          dbg('playbook injected at session start')
        }
      }
    } catch (e: any) { dbg(`playbook injection failed (non-fatal): ${e?.message}`) }
  }

  // Generate per-session auth token (CR-07)
  const token = crypto.randomUUID()

  // ─── Queue state ─────────────────────────────
  const queue: WakeEvent[] = []
  const maxQueue = config.maxQueueSize ?? MAX_QUEUE_DEFAULT
  const retryInterval = config.busyRetryInterval ?? BUSY_RETRY_INTERVAL_DEFAULT

  function queueWakeEvent(event: WakeEvent, reason: string): number {
    if (hasSeenWakeEvent(event)) return queue.findIndex(e => e.eventId === event.eventId) + 1
    if (queue.length >= maxQueue) {
      const dropped = queue.shift()
      dbg(`wake: queue full, dropped oldest event ${dropped?.eventId}`)
    }
    queue.push(event)
    rememberWakeEvent(event)
    dbg(`wake: queued ${event.eventId} reason=${reason} position=${queue.length}`)
    return queue.length
  }

  async function runDegradedActivityCatchup(reason: string): Promise<void> {
    try {
      if (!_lastActivityCursor) {
        _lastActivityCursor = await fetchActivityCursor(config)
        dbg(`fallback catch-up initialized cursor=${_lastActivityCursor ?? '-'} reason=${reason}`)
        return
      }

      const { entries, cursor } = await pollActivity(config, _lastActivityCursor)
      let replayed = 0
      for (const entry of entries.slice(0, FALLBACK_REPLAY_LIMIT)) {
        const event = activityToWakeEvent(entry, config)
        if (!event) continue
        if (!isWakeEventRelevant(event) || !isWakeEventSubscribed(event)) continue
        if (hasSeenWakeEvent(event)) continue

        if (await isAgentBusy()) {
          queueWakeEvent(event, `fallback_${reason}`)
        } else if (await injectWakeEvent(event, config.sessionId)) {
          rememberWakeEvent(event)
        } else {
          queueWakeEvent(event, `fallback_${reason}_inject_failed`)
        }
        replayed++
      }
      _lastActivityCursor = cursor ?? _lastActivityCursor
      dbg(`fallback catch-up complete reason=${reason} entries=${entries.length} replayed=${replayed} cursor=${_lastActivityCursor ?? '-'}`)
    } catch (e: any) {
      dbg(`fallback catch-up failed-open reason=${reason} error=${e?.message}`)
    }
  }

  // ─── Route handler ───────────────────────────

  async function handleRequest(req: Request): Promise<Response> {
    try {
      const url = new URL(req.url)

      // GET /health — health check
      if (req.method === 'GET' && url.pathname === '/health') {
        return Response.json({
          alive: true,
          sessionId: config.sessionId,
          uptime: Math.floor((Date.now() - STARTUP_TS) / 1000),
          queueSize: queue.length,
        })
      }

      // POST /wake — main wake endpoint
      if (req.method === 'POST' && url.pathname === '/wake') {
        return await handleWake(req)
      }

      // Everything else → 404
      return new Response('Not found', { status: 404 })
    } catch (e: any) {
      dbg('request handler error:', e?.message)
      return Response.json(
        { accepted: false, error: 'internal error' } satisfies WakeResponse,
        { status: 500 },
      )
    }
  }

  // ─── POST /wake handler ──────────────────────

  async function handleWake(req: Request): Promise<Response> {
    // Validate auth token (CR-07)
    const reqToken = req.headers.get('X-Wake-Token')
    if (reqToken !== token) {
      dbg('wake: auth failed')
      return Response.json(
        { accepted: false, error: 'unauthorized' } satisfies WakeResponse,
        { status: 401 },
      )
    }

    // Parse body
    let event: WakeEvent
    try {
      event = (await req.json()) as WakeEvent
    } catch {
      return Response.json(
        { accepted: false, error: 'invalid JSON' } satisfies WakeResponse,
        { status: 400 },
      )
    }

    // Basic validation
    if (!event.eventId || !event.type || !event.source) {
      return Response.json(
        { accepted: false, error: 'missing required fields' } satisfies WakeResponse,
        { status: 400 },
      )
    }

    dbg(`wake: received ${event.type} from ${event.source} [${event.priority}]`)

    if (hasSeenWakeEvent(event)) {
      dbg(`wake: duplicate ignored ${event.eventId}`)
      return Response.json(
        { accepted: true, queued: false } satisfies WakeResponse,
      )
    }

    await syncTaskStart(event, 'start_accepted')
    await syncExplicitTaskResultOrCompletion(event)

    // ─── Engine routing: evaluate through SignalWire if available ───
    const signalWireInstance = config.signalWire ?? config.signalWireResolver?.() ?? null
    if (signalWireInstance) {
      try {
        const result = await signalWireInstance.evaluateExternal(event)
        if (result.matched) {
          // Engine handled it (may have triggered wake action, or just logged)
          rememberWakeEvent(event)
          dbg(`wake: engine handled event ${event.eventId} (wake=${result.wakeTriggered}, actions=${result.actionsExecuted.length})`)
          return Response.json({
            accepted: true,
            engineHandled: true,
            wakeTriggered: result.wakeTriggered,
            actionsExecuted: result.actionsExecuted.length,
          })
        }
        // No matching rule — fall through to direct injection as fallback
        dbg('no matching rule for event, falling back to direct injection')
      } catch (e: any) {
        dbg('engine evaluateExternal error, falling back:', e?.message)
      }
    }

    // ─── Fallback: direct injection (original behavior) ────────────
    // Check if agent is busy
    const busy = await isAgentBusy()

    if (busy) {
      // Queue the event (FIFO, drop oldest if full)
      const pos = queueWakeEvent(event, 'busy')
      await syncLifecycle({ action: 'busy', event, currentTaskId: extractWakeTaskId(event), reason: 'queued' })
      dbg(`wake: agent busy, queued at position ${pos}`)
      return Response.json(
        { accepted: true, queued: true, queuePosition: pos } satisfies WakeResponse,
      )
    }

    // Agent idle — inject immediately
    const injected = await injectWakeEvent(event, config.sessionId)
    if (injected) {
      rememberWakeEvent(event)
      dbg(`wake: injected ${event.eventId}`)
      return Response.json(
        { accepted: true, queued: false } satisfies WakeResponse,
      )
    }

    // Injection failed — queue as fallback
    const queuePosition = queueWakeEvent(event, 'inject_failed')
    await syncLifecycle({ action: 'busy', event, currentTaskId: extractWakeTaskId(event), reason: 'inject_failed_queued' })
    dbg(`wake: inject failed, queued at position ${queuePosition}`)
    return Response.json(
      { accepted: true, queued: true, queuePosition } satisfies WakeResponse,
    )
  }

  // ─── Start Bun.serve (like OAuth at index.ts:363) ─────

  const server = Bun.serve({
    port: config.port ?? 0, // 0 = random
    fetch: handleRequest,
  })

  const actualPort = server.port!
  dbg(`started on port ${actualPort} for session ${config.sessionId}`)

  // ─── Write discovery file (DB-04) ────────────
  // Resolve lazily so launchers that set WAKE_DISCOVERY_DIR (e.g. agent
  // runner with isolated HOME) are honored even if this module was
  // imported before the env var was set.
  const resolvedDiscoveryDir = discoveryDir()
  const discoveryPath = join(
    resolvedDiscoveryDir,
    `${process.pid}-${config.sessionId}.json`,
  )
  try {
    mkdirSync(resolvedDiscoveryDir, { recursive: true })
    // Set module state from config/reconciled identity
    _currentSubscribe = config.subscribe ?? null
    _currentSubscribePreset = config.subscribePreset ?? null
    _currentMemberType = resolvedIdentity.memberType

    const discoveryData: DiscoveryFile = {
      port: actualPort,
      token,
      sessionId: config.sessionId,
      agentInstanceId: config.agentInstanceId,
      memberId: resolvedIdentity.memberId,
      memberName: resolvedIdentity.memberName ?? _agentIdentity?.name ?? resolvedIdentity.memberId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      transport: 'http',
      // Stage 2.1: Chain tracking (REQ-16a)
      parentMemberId: _parentMemberId,
      parentSessionId: _parentSessionId,
      spawnDepth: _currentDepth ?? 0,
      maxSpawnDepth: _agentIdentity?.budget?.maxSpawnDepth ?? 2,
      maxSubagents: _agentIdentity?.budget?.maxSubagents ?? 5,
      // Wake subscriptions (REQ-02)
      subscribe: _currentSubscribe ?? undefined,
      subscribePreset: _currentSubscribePreset ?? undefined,
      memberType: _currentMemberType,
    }
    // Atomic write: tmp → rename (safe against partial writes)
    const tmpPath = discoveryPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(discoveryData))
    renameSync(tmpPath, discoveryPath)
    _discoveryPath = discoveryPath
    dbg(`discovery file written: ${discoveryPath} member=${discoveryData.memberId ?? 'unregistered'} depth=${discoveryData.spawnDepth} parent=${discoveryData.parentMemberId ?? 'ROOT'}`)
  } catch (e: any) {
    dbg('discovery file write failed:', e?.message)
  }
  await syncLifecycle({ action: 'online', reason: 'listener_ready', force: true })
  void runDegradedActivityCatchup('listener_ready')

  // ─── Queue drain timer ───────────────────────

  const drainInterval = setInterval(async () => {
    if (queue.length === 0) return
    try {
      if (await isAgentBusy()) return
      const event = queue.shift()!
      const ok = await injectWakeEvent(event, config.sessionId)
      if (queue.length === 0) await syncLifecycle({ action: 'resting', event, currentTaskId: extractWakeTaskId(event), reason: ok ? 'queue_drained' : 'queue_empty_after_failed_drain' })
      dbg(`drain: ${event.eventId} ${ok ? 'injected' : 'failed'}`)
    } catch (e: any) {
      dbg('drain error:', e?.message)
    }
  }, retryInterval * 1000)

  // ─── Cleanup on exit ─────────────────────────

  let cleaned = false
  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    clearInterval(drainInterval)
    void syncLifecycle({ action: 'offline', reason: 'listener_stop', force: true })
    try {
      if (_discoveryPath) unlinkSync(_discoveryPath)
    } catch {}
    try {
      server.stop()
    } catch {}
    dbg('cleanup complete')
  }

  process.on('exit', cleanup)
  process.on('SIGTERM', cleanup)
  process.on('SIGINT', cleanup)

  // ─── Return handle ───────────────────────────

  return {
    port: actualPort,
    token,
    server,
    stop: cleanup,
  }
}

// ─── Stop Wake Listener ─────────────────────────────────────────────

/** Stop the wake listener and clean up the discovery file. */
export function stopWakeListener(handle: WakeListenerHandle): void {
  try {
    handle.stop()
  } catch (e: any) {
    dbg('stopWakeListener error:', e?.message)
  }
}

// ─── Update Discovery File (CN-05: single writer for all mutations) ─

/**
 * Update the discovery file with new subscription data.
 * Called by /wake command (via tui.tsx) — NEVER write discovery directly from TUI.
 * Uses atomic tmp→rename pattern.
 *
 * @returns true if write succeeded, false otherwise
 */
export function updateDiscovery(update: {
  subscribe?: string[]
  subscribePreset?: string | null
  memberType?: 'human' | 'agent' | 'unknown'
}): boolean {
  if (!_discoveryPath) {
    dbg('updateDiscovery: no discovery path (listener not started or no memberId)')
    return false
  }

  try {
    // Read current discovery file
    const raw = readFileSync(_discoveryPath, 'utf-8')
    const current = JSON.parse(raw)

    // Merge updates
    if (update.subscribe !== undefined) {
      current.subscribe = update.subscribe
      _currentSubscribe = update.subscribe
    }
    if (update.subscribePreset !== undefined) {
      current.subscribePreset = update.subscribePreset
      _currentSubscribePreset = update.subscribePreset
    }
    if (update.memberType !== undefined) {
      current.memberType = update.memberType
      _currentMemberType = update.memberType
    }

    // Atomic write: tmp → rename
    const tmpPath = _discoveryPath + '.tmp'
    writeFileSync(tmpPath, JSON.stringify(current))
    renameSync(tmpPath, _discoveryPath)
    dbg(`updateDiscovery: subscribe=${JSON.stringify(current.subscribe)} preset=${current.subscribePreset}`)
    return true
  } catch (e: any) {
    dbg(`updateDiscovery failed: ${e?.message}`)
    return false
  }
}

/** Get current subscription state (for /wake status) */
export function getSubscriptionState(): {
  subscribe: string[] | null
  subscribePreset: string | null
  memberType: 'human' | 'agent' | 'unknown'
  discoveryPath: string | null
  memberId: string | null
  memberName: string | null
} {
  return {
    subscribe: _currentSubscribe,
    subscribePreset: _currentSubscribePreset,
    memberType: _currentMemberType,
    discoveryPath: _discoveryPath,
    memberId: _agentIdentity?.memberId ?? null,
    memberName: _agentIdentity?.name ?? null,
  }
}
