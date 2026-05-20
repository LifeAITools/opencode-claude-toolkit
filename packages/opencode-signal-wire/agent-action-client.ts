/**
 * agent-action-client — plugin-side HTTP client for wake-router's
 * /agent-action/request endpoint.
 *
 * Used by `routeTaskThroughEngine()` (Phase 4.2) to delegate spawn decisions
 * to the central wake-router decision-engine.
 *
 * Auth: caller's `memberSecret` carried in `Authorization: Bearer ...`
 * header. The plugin gets its secret from identity-bootstrap cache.
 *
 * Timeout: short (~5s default) — decision-engine performs at most 2
 * synqtask round-trips, should complete in <500ms p99.
 *
 * Error handling: returns structured Error so caller can apply fail-mode
 * (differential by runMode — REQ-36).
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { WAKE_ROOT, ACTION_CLIENT_TIMEOUT_MS } from './domain-constants'

const ROUTER_JSON_PATH = join(WAKE_ROOT, 'router.json')
const DEFAULT_TIMEOUT_MS = ACTION_CLIENT_TIMEOUT_MS

export interface AgentActionRequest {
  caller: {
    memberId: string
    memberSecret: string
    sessionId?: string
    spawnDepth?: number
    pid?: number
    runMode?: 'human' | 'agent' | 'unknown'
  }
  intent: 'inline_helper' | 'dispatch_to' | 'queue_only'
  target: {
    memberId?: string
    role?: string
    cwd?: string
    preferredTool?: 'opencode' | 'claude'
  }
  task: {
    title: string
    description: string
    expectedOutput?: string
    deadlineSec?: number
    priority?: 'high' | 'medium' | 'low'
  }
  context?: {
    parentTaskId?: string
    channelId?: string
    relatedFiles?: string[]
    additionalEnv?: Record<string, string>
  }
  policy_hints?: {
    maxWaitForReuseSec?: number
    commentsBack?: boolean
    suggestedSystemPromptStrategy?: 'append' | 'replace'
  }
}

export interface AgentActionResponse {
  decision: 'spawned_new' | 'reused' | 'inline_ok' | 'queued' | 'denied'
  decisionLogId: string
  reason: string

  inline?: {
    composedSystemPrompt: string
    systemPromptStrategy: 'append' | 'replace'
    allowedTools: string[]
    blockedTools: string[]
    spawnBriefRef: string
    ephemeralMemberId: string
    ephemeralMemberSecret: string
    ttlSec: number
    perCallReminder: string
  }

  agent?: {
    memberId: string
    sessionId?: string
    wakeListenerUrl?: string
    tmuxSession?: string
    spawnedAt: string
  }

  queuedTask?: {
    synqtaskTaskId: string
    assignedRole: string
  }

  denial?: {
    code: string
    details: string
    alternative?: string
  }

  audit: {
    promptHash?: string
    routerVersion: string
    systemPromptStrategyUsed?: 'append' | 'replace'
  }
}

export class RouterUnreachableError extends Error {
  constructor(public reason: 'no_router_json' | 'network' | 'timeout', detail: string) {
    super(`Router unreachable (${reason}): ${detail}`)
    this.name = 'RouterUnreachableError'
  }
}

export class RouterRejectedError extends Error {
  constructor(public response: AgentActionResponse) {
    super(`Router rejected: ${response.reason}`)
    this.name = 'RouterRejectedError'
  }
}

interface RouterDiscoveryData {
  host: string
  port: number
  bootstrapKey: string
  synqtaskUrl: string
  pid: number
  startedAt: string
  version: string
}

function readRouterDiscovery(): RouterDiscoveryData | null {
  try {
    return JSON.parse(readFileSync(ROUTER_JSON_PATH, 'utf-8')) as RouterDiscoveryData
  } catch {
    return null
  }
}

/**
 * Send an /agent-action/request and return the parsed response.
 *
 * Throws:
 *   - RouterUnreachableError when router.json missing OR HTTP fails OR timeout
 *   - RouterRejectedError when router returns decision='denied' (caller may want
 *     to surface the denial info to the LLM instead of failing silently)
 *
 * Returns parsed AgentActionResponse on success decisions
 * (inline_ok, reused, spawned_new, queued).
 */
export async function requestAgentAction(
  req: AgentActionRequest,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AgentActionResponse> {
  const router = readRouterDiscovery()
  if (!router) {
    throw new RouterUnreachableError(
      'no_router_json',
      `${ROUTER_JSON_PATH} not found; install synqtask-stack or start wake-router`,
    )
  }

  const url = `http://${router.host}:${router.port}/agent-action/request`
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS

  try {
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${req.caller.memberSecret}`,
      },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(timeoutMs),
    })

    let data: AgentActionResponse
    try {
      data = await resp.json() as AgentActionResponse
    } catch (e: any) {
      throw new RouterUnreachableError('network', `invalid JSON response: ${e?.message ?? String(e)}`)
    }

    if (data.decision === 'denied') {
      throw new RouterRejectedError(data)
    }
    return data
  } catch (e: any) {
    if (e instanceof RouterRejectedError) throw e
    if (e instanceof RouterUnreachableError) throw e
    if (e?.name === 'AbortError' || e?.message?.includes('timeout')) {
      throw new RouterUnreachableError('timeout', `request to ${url} timed out after ${timeoutMs}ms`)
    }
    throw new RouterUnreachableError('network', e?.message ?? String(e))
  }
}

/**
 * Probe: is the router reachable? Used by routeTaskThroughEngine to decide
 * fail-mode without making a real request.
 *
 * Returns true iff router.json exists AND /health responds within 1s.
 */
export async function isRouterReachable(timeoutMs = 1000): Promise<boolean> {
  const router = readRouterDiscovery()
  if (!router) return false
  try {
    const resp = await fetch(`http://${router.host}:${router.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    return resp.ok
  } catch {
    return false
  }
}
