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
import { DISCOVERY_DIR, WAKE_EVENT_TYPES, WARM_CHANNEL_TTL_MS } from './wake-types'

// ─── Constants ────────────────────────────────────────────

const DEBUG = process.env.WAKE_LISTENER_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'wake-listener-debug.log')
const MAX_QUEUE_DEFAULT = 50
const BUSY_RETRY_INTERVAL_DEFAULT = 5 // seconds
const STARTUP_TS = Date.now()

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
export async function resolveCurrentDepth(serverUrl: string, sessionId: string): Promise<number> {
  if (_currentDepth !== null) return _currentDepth

  let depth = 0
  let currentId = sessionId

  try {
    for (let i = 0; i < 10; i++) {  // safety limit
      const res = await fetch(`${serverUrl}/session/${currentId}`, {
        signal: AbortSignal.timeout(2000),
      })
      if (!res.ok) break
      const session = await res.json() as any
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

  return {
    allowed: true,
    depth: currentDepth, maxDepth: budget.maxSpawnDepth,
    spawned: spawnCount, maxSpawns: budget.maxSubagents,
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
  // Resolve Bearer token: env var → mcp-auth.json → none
  let bearerToken = process.env.SYNQTASK_BEARER_TOKEN ?? ''
  if (!bearerToken) {
    try {
      const authPath = join(homedir(), '.local', 'share', 'opencode', 'mcp-auth.json')
      const authData = JSON.parse(readFileSync(authPath, 'utf-8'))
      bearerToken = authData?.synqtask?.tokens?.accessToken ?? ''
    } catch { /* no mcp-auth.json, proceed without auth */ }
  }
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    }
    if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`
    const res = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: {
          name: 'todo_members',
          arguments: { operations: { action: 'get_role_prompt', member_id: memberId } },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs ?? 3000),
    })

    if (!res.ok) {
      dbg(`fetchIdentity: HTTP ${res.status}`)
      return parseAgentsMd()
    }

    // Parse SSE response: "event: message\ndata: {...}\n"
    const text = await res.text()
    const dataLine = text.split('\n').find(l => l.startsWith('data: '))
    if (!dataLine) {
      dbg('fetchIdentity: no data line in response')
      return parseAgentsMd()
    }

    const rpcResult = JSON.parse(dataLine.substring(6))
    const content = rpcResult?.result?.content?.[0]?.text
    if (!content) {
      dbg('fetchIdentity: empty content')
      return parseAgentsMd()
    }

    const parsed = JSON.parse(content)
    const result = parsed?.results?.[0]?.result ?? parsed

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
          headers,
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
                    headers,
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
      teamPlaybook: null,
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
function formatWakeMessage(event: WakeEvent, identity?: AgentIdentity | null): string {
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
      const sendName = p.sender_name ?? p.senderName ?? p.senderId ?? 'unknown'
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
async function isAgentBusy(serverUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/session/status`)
    if (!res.ok) return false // assume idle if can't check
    const data = (await res.json()) as any
    // If any session is actively streaming, agent is busy
    return (
      data?.sessions?.some?.(
        (s: any) => s.status === 'streaming' || s.status === 'busy',
      ) ?? false
    )
  } catch {
    return false
  }
}

// ─── Inject Wake Event (CR-02, DB-05) ───────────────────────────────

/**
 * Inject a wake event into the agent's LLM loop.
 * Tries promptAsync first (v1.4.0), falls back to /message endpoint.
 * Uses noReply:false so the LLM processes and responds (CR-02).
 */
// Cached session ID — resolved lazily on first injection, reused after
let _cachedSessionId: string | null = null
let _discoveryPath: string | null = null

// CWD of this agent's serve instance — used to filter sessions
let _agentDirectory: string | null = null

async function resolveSessionId(serverUrl: string, sessionId: string): Promise<string | null> {
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

  // Fallback 2: find OUR session by directory (CWD of this serve instance)
  // Each serve runs in agent's workspace dir. Sessions have directory field.
  // Filter by directory to find THIS agent's session, not other agents'.
  if (_agentDirectory && serverUrl) {
    try {
      const res = await fetch(`${serverUrl}/session?limit=20`)
      if (res.ok) {
        const sessions = await res.json() as any[]
        const match = sessions.find((s: any) => s.directory === _agentDirectory)
        if (match) {
          _cachedSessionId = match.id
          dbg(`resolveSessionId by directory ${_agentDirectory}: ${_cachedSessionId}`)
          // Update discovery file
          if (_discoveryPath) {
            try {
              const disc = JSON.parse(readFileSync(_discoveryPath, 'utf-8'))
              disc.sessionId = _cachedSessionId
              writeFileSync(_discoveryPath, JSON.stringify(disc))
            } catch {}
          }
          return _cachedSessionId
        }
      }
    } catch (e: any) { dbg(`resolveSessionId by directory failed: ${e?.message}`) }
  }

  dbg('resolveSessionId: no session ID yet, events will queue')
  return null
}

async function injectWakeEvent(
  event: WakeEvent,
  serverUrl: string,
  sessionId: string,
): Promise<boolean> {
  const resolvedSessionId = await resolveSessionId(serverUrl, sessionId)
  if (!resolvedSessionId) {
    dbg('inject: no valid sessionId')
    return false
  }

  const text = formatWakeMessage(event, _agentIdentity)

  // POST /session/{id}/message with noReply:false
  // - Idle agent: LLM starts immediately
  // - Busy agent: message queued, LLM picks up after current response
  // - TUI (via attach): shows message cleanly in conversation, not in prompt box
  const url = `${serverUrl}/session/${resolvedSessionId}/message`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        noReply: false,
        parts: [{ type: 'text', text }],
      }),
    })
    if (res.ok) {
      dbg(`inject OK: session=${resolvedSessionId}`)
      return true
    }
    dbg(`inject failed: ${res.status}`)
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

  // Fetch identity from SynqTask (CR-02). Fail-open (CN-01).
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
  }

  // Stage 3: Inject team playbook at session start (CR-11, CN-10: once, not per-wake)
  if (_agentIdentity?.teamPlaybook) {
    try {
      const playbookSessionId = await resolveSessionId(config.serverUrl, config.sessionId)
      if (playbookSessionId) {
        const playbookText = `<team-playbook team="${_agentIdentity.teamName ?? 'unknown'}">\n${_agentIdentity.teamPlaybook}\n</team-playbook>`
        await fetch(`${config.serverUrl}/session/${playbookSessionId}/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            noReply: true,
            parts: [{ type: 'text', text: playbookText }],
          }),
        })
        dbg('playbook injected at session start')
      }
    } catch (e: any) { dbg(`playbook injection failed (non-fatal): ${e?.message}`) }
  }

  // Generate per-session auth token (CR-07)
  const token = crypto.randomUUID()

  // ─── Queue state ─────────────────────────────
  const queue: WakeEvent[] = []
  const maxQueue = config.maxQueueSize ?? MAX_QUEUE_DEFAULT
  const retryInterval = config.busyRetryInterval ?? BUSY_RETRY_INTERVAL_DEFAULT

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

    // ─── Engine routing: evaluate through SignalWire if available ───
    const signalWireInstance = config.signalWire ?? config.signalWireResolver?.() ?? null
    if (signalWireInstance) {
      try {
        const result = await signalWireInstance.evaluateExternal(event)
        if (result.matched) {
          // Engine handled it (may have triggered wake action, or just logged)
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
    const busy = await isAgentBusy(config.serverUrl)

    if (busy) {
      // Queue the event (FIFO, drop oldest if full)
      if (queue.length >= maxQueue) {
        const dropped = queue.shift()
        dbg(`wake: queue full, dropped oldest event ${dropped?.eventId}`)
      }
      queue.push(event)
      const pos = queue.length
      dbg(`wake: agent busy, queued at position ${pos}`)
      return Response.json(
        { accepted: true, queued: true, queuePosition: pos } satisfies WakeResponse,
      )
    }

    // Agent idle — inject immediately
    const injected = await injectWakeEvent(event, config.serverUrl, config.sessionId)
    if (injected) {
      dbg(`wake: injected ${event.eventId}`)
      return Response.json(
        { accepted: true, queued: false } satisfies WakeResponse,
      )
    }

    // Injection failed — queue as fallback
    if (queue.length >= maxQueue) {
      queue.shift()
    }
    queue.push(event)
    dbg(`wake: inject failed, queued at position ${queue.length}`)
    return Response.json(
      { accepted: true, queued: true, queuePosition: queue.length } satisfies WakeResponse,
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
  // Only write discovery for agent sessions (with memberId).
  // Non-agent sessions don't need to be discoverable by the router.

  if (config.memberId) {
    const discoveryPath = join(
      DISCOVERY_DIR,
      `${process.pid}-${config.sessionId}.json`,
    )
    try {
      mkdirSync(DISCOVERY_DIR, { recursive: true })
      const discoveryData = {
        port: actualPort,
        token,
        sessionId: config.sessionId,
        memberId: config.memberId,
        memberName: _agentIdentity?.name ?? config.memberId,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        transport: 'http',
        // Stage 2.1: Chain tracking (REQ-16a)
        parentMemberId: _parentMemberId,
        parentSessionId: _parentSessionId,
        spawnDepth: _currentDepth ?? 0,
        maxSpawnDepth: _agentIdentity?.budget?.maxSpawnDepth ?? 2,
        maxSubagents: _agentIdentity?.budget?.maxSubagents ?? 5,
      }
      // Atomic write: tmp → rename (safe against partial writes)
      const tmpPath = discoveryPath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(discoveryData))
      renameSync(tmpPath, discoveryPath)
      _discoveryPath = discoveryPath
      dbg(`discovery file written: ${discoveryPath} depth=${discoveryData.spawnDepth} parent=${discoveryData.parentMemberId ?? 'ROOT'}`)
    } catch (e: any) {
      dbg('discovery file write failed:', e?.message)
    }
  } else {
    dbg('skipping discovery file: no memberId configured (non-agent session)')
  }

  // ─── Queue drain timer ───────────────────────

  const drainInterval = setInterval(async () => {
    if (queue.length === 0) return
    try {
      if (await isAgentBusy(config.serverUrl)) return
      const event = queue.shift()!
      const ok = await injectWakeEvent(event, config.serverUrl, config.sessionId)
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

