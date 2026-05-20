/**
 * OpenCode plugin entrypoint for @life-ai-tools/opencode-signal-wire.
 *
 * This package owns wake/signal runtime integration independently from any
 * model/provider plugin. Provider packages may coexist, but must not bootstrap
 * the wake listener by default.
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { SignalWire } from './signal-wire'
import {
  // Note: legacy local spawn-check helpers (checkSpawnAllowed, getAgentIdentity,
  // getSpawnActive, getSpawnTotal) intentionally NOT imported here — all spawn
  // decisions go through wake-router decision-engine (Phase 4.2 routeTaskThroughEngine).
  // The local helpers remain exported from wake-listener.ts only for any
  // external consumers and for the helperStarted/active counter (in-process
  // metric, not a policy decision).
  helperStarted,
  resolveCurrentDepth,
  bindWakeListenerSession,
  startWakeListener,
  stopWakeListener,
} from './wake-listener'
import type { WakeListenerHandle } from './wake-listener'
import { computeSubscribe, loadPreferences } from './wake-preferences'
import { bootstrapIdentity, applyIdentityToEnv, type ResolvedIdentity } from './identity-bootstrap'
import {
  normalizeChatMessage,
  normalizeToolBefore,
  normalizeToolAfter,
  applyHintResults,
  applyCompactResults,
  applyChatHintResults,
  applyBlockResults,
} from './hook-listener'
import { startQuotaWatcher, type QuotaWatcherHandle } from './quota-watcher'
import { getBoundSdk, setCurrentSignalWire } from './token-rotation-bridge'
import { WAKE_ROOT, AGENT_IDENTITY_DIR } from './domain-constants'

const DEBUG = process.env.OPENCODE_SIGNAL_WIRE_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'opencode-signal-wire-debug.log')

let startupSeq = 0

function dbg(...args: any[]) {
  if (!DEBUG) return
  try {
    appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`)
  } catch {}
}

function logStep(step: string, details: Record<string, unknown> = {}) {
  startupSeq++
  dbg({ seq: startupSeq, step, ...details })
}

function maskPresence(value: unknown): 'present' | 'absent' {
  return value === undefined || value === null || value === '' ? 'absent' : 'present'
}

function readOwnPackage(): { name: string; version: string; path: string } {
  const path = join(import.meta.dir, 'package.json')
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf-8'))
    return { name: pkg.name ?? 'unknown', version: pkg.version ?? 'unknown', path }
  } catch {
    return { name: 'unknown', version: 'unknown', path }
  }
}

function getServerUrl(input: any): string {
  if (typeof input?.serverUrl === 'object' && input.serverUrl?.href) return input.serverUrl.href.replace(/\/$/, '')
  if (typeof input?.serverUrl === 'string') return input.serverUrl.replace(/\/$/, '')
  return ''
}

function readProjectConfig(cwd: string): any {
  try {
    const configPath = join(cwd, 'opencode.json')
    if (!existsSync(configPath)) return null
    return JSON.parse(readFileSync(configPath, 'utf-8'))
  } catch (e: any) {
    dbg(`config read failed: ${e?.message}`)
    return null
  }
}

function resolveMemberHints(cwd: string): {
  memberId?: string
  memberType: 'human' | 'agent' | 'unknown'
  agentRegistration: any
  projectConfigFound: boolean
  agentIdSource: 'opencode.json' | 'env' | 'none'
} {
  const config = readProjectConfig(cwd)
  const synqHeaders = config?.mcp?.synqtask?.headers
  const agentRegistration = config?.wake?.agentRegistration ?? config?.synqtask?.agentRegistration ?? null
  const memberId = synqHeaders?.['X-Agent-Id'] ?? process.env.SYNQTASK_MEMBER_ID
  return {
    memberId,
    memberType: synqHeaders?.['X-Agent-Id'] ? 'agent' : (memberId ? 'unknown' : 'unknown'),
    agentRegistration,
    projectConfigFound: Boolean(config),
    agentIdSource: synqHeaders?.['X-Agent-Id'] ? 'opencode.json' : (process.env.SYNQTASK_MEMBER_ID ? 'env' : 'none'),
  }
}

function createSignalWire(serverUrl: string, sessionId: string, sdkClient: any): SignalWire {
  const signalWire = new SignalWire({ serverUrl, sessionId })
  signalWire.setSdkClient(sdkClient)
  return signalWire
}

function eventTypeOf(event: any): string {
  return event?.type ?? event?.name ?? event?.event ?? 'unknown'
}

function eventPayloadOf(event: any): any {
  return event?.properties ?? event?.payload ?? event?.data ?? event
}

function sessionFromEvent(event: any): { id?: string; directory?: string } {
  const payload = eventPayloadOf(event)
  const session = payload?.session ?? payload
  return {
    id: session?.id ?? payload?.sessionID ?? payload?.sessionId,
    directory: session?.directory ?? payload?.directory,
  }
}

async function findNewSessionByDirectory(client: any, directory: string, notBeforeMs: number): Promise<{ id?: string; directory?: string; count: number }> {
  if (!client?.session?.list) return { count: 0 }
  const { data } = await client.session.list()
  if (!Array.isArray(data)) return { count: 0 }
  const candidates = data.filter((session: any) => {
    const created = Number(session?.time?.created ?? session?.createdAt ?? 0)
    return session?.directory === directory && created >= notBeforeMs
  })
  if (candidates.length !== 1) return { count: candidates.length }
  return { id: candidates[0].id, directory: candidates[0].directory, count: 1 }
}

// ─── Subagent type → role mapping (loaded once on first call) ────

let _subagentRoleMap: Record<string, string> | null = null
function loadSubagentRoleMap(): Record<string, string> {
  if (_subagentRoleMap) return _subagentRoleMap
  const mapPath = join(WAKE_ROOT, 'subagent-role-map.json')
  try {
    const raw = readFileSync(mapPath, 'utf-8')
    const parsed = JSON.parse(raw)
    // Strip _comment / _doc fields (they're documentation, not mappings)
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (k.startsWith('_')) continue
      if (typeof v === 'string') map[k] = v
    }
    _subagentRoleMap = map
    return map
  } catch {
    return { default: 'staff-helper' }
  }
}

function inferTargetRole(subagentType?: string): string {
  if (!subagentType) {
    return loadSubagentRoleMap().default ?? 'staff-helper'
  }
  const map = loadSubagentRoleMap()
  // Direct match first
  if (map[subagentType]) return map[subagentType]
  // Prefix wildcard match: e.g. "lat-dev-kit-prompt-booster-*" → all prompt-booster-X
  for (const [pattern, role] of Object.entries(map)) {
    if (pattern.endsWith('*') && subagentType.startsWith(pattern.slice(0, -1))) {
      return role
    }
  }
  return map.default ?? 'staff-helper'
}

/**
 * Phase 4.2: routeTaskThroughEngine — central task tool intercept.
 *
 * Replaces the old local handlePreToolUseSpawnCheck. ALL task spawn decisions
 * MUST go through wake-router's decision-engine (CN-01: no bypass).
 *
 * Failure modes are HARD BLOCKS with explicit recovery instructions — no
 * silent fallback. If the central system is down, the operator must fix it
 * (start router / install stack / set explicit override). This is intentional:
 * silent fallbacks let the new system "kind of work" without anyone noticing
 * the central layer was never actually engaged, defeating the whole purpose.
 *
 * The ONLY escape valve is the explicit env var:
 *     SW_ALLOW_TASK_WITHOUT_ROUTER=1
 * which is loudly logged on every fire. Intended exclusively for operators
 * debugging the router itself; NOT to be set in any persistent .env.
 *
 * Flow:
 *   1. Not a spawn tool → undefined (no-op)
 *   2. Description quality gate (cheap early reject)
 *   3. Check identity provisioned + router reachable
 *      - missing identity → BLOCK with `wake-status install` hint
 *      - router down → BLOCK with `systemctl start synqtask-stack` hint
 *      - both can be overridden by SW_ALLOW_TASK_WITHOUT_ROUTER=1 (loud warning)
 *   4. POST /agent-action/request with intent='inline_helper'
 *   5. On decision:
 *      - inline_ok → inject _sw* args; opencode spawns subprocess
 *      - denied → BLOCK with router's reason + alternative
 *      - any error → BLOCK with the error message
 */
async function routeTaskThroughEngine(
  toolName: string,
  sessionId: string,
  input?: Record<string, any>,
  output?: { args?: Record<string, any> },
): Promise<{ decision: 'block'; message: string } | undefined> {
  const spawnTools = ['task', 'Task', 'task_tool', 'call_omo_agent']
  if (!spawnTools.includes(toolName)) return undefined

  const description = String(input?.description ?? input?.prompt ?? input?.message ?? '')
  // Cheap early gate (router would deny too, but this saves a network call)
  if (description.length > 0 && description.length < 200) {
    return {
      decision: 'block',
      message: `Delegation blocked: description too short (${description.length} chars, need 200+). ` +
               `Include concrete task, constraints, files, and expected output.`,
    }
  }

  // Operator override — explicit, loud, NEVER persisted in .env.
  // Used for debugging the router itself when you can't otherwise unblock task tool.
  const override = process.env.SW_ALLOW_TASK_WITHOUT_ROUTER === '1'

  // Lazy-load to avoid plugin boot dependency on these modules if unused
  const [{ requestAgentAction, RouterUnreachableError, RouterRejectedError, isRouterReachable }, { detectRunMode }] = await Promise.all([
    import('./agent-action-client'),
    import('./run-mode'),
  ])

  const memberId = process.env.SYNQTASK_MEMBER_ID
  const memberSecret = process.env.SYNQTASK_MEMBER_SECRET

  // ─── Gate: identity provisioned? ──
  if (!memberId || !memberSecret) {
    if (override) {
      console.error(
        `[SW] ⚠️⚠️⚠️ SW_ALLOW_TASK_WITHOUT_ROUTER=1: task tool firing without provisioned identity. ` +
        `This bypasses RBAC and audit. ONLY for debugging.`,
      )
      // Override = allow with no further checks. Operator's responsibility.
      helperStarted()
      return undefined
    }
    return {
      decision: 'block',
      message:
        `Task tool blocked: plugin has no SynqTask identity.\n` +
        `\n` +
        `Run \`wake-status install\` (or check that ${WAKE_ROOT}/router.json exists\n` +
        `and ${AGENT_IDENTITY_DIR}/ contains your cached identity).\n` +
        `\n` +
        `Debug override (NOT for normal use): SW_ALLOW_TASK_WITHOUT_ROUTER=1`,
    }
  }

  // ─── Gate: router reachable? ──
  const reachable = await isRouterReachable(800)
  if (!reachable) {
    if (override) {
      console.error(
        `[SW] ⚠️⚠️⚠️ SW_ALLOW_TASK_WITHOUT_ROUTER=1: router unreachable but task tool firing anyway. ` +
        `RBAC bypassed. ONLY for debugging.`,
      )
      helperStarted()
      return undefined
    }
    return {
      decision: 'block',
      message:
        `Task tool blocked: wake-router is unreachable.\n` +
        `\n` +
        `Run \`systemctl --user start synqtask-stack\` to start the router.\n` +
        `Check status: \`wake-status\` or \`curl http://127.0.0.1:9800/health\`.\n` +
        `\n` +
        `Debug override (NOT for normal use): SW_ALLOW_TASK_WITHOUT_ROUTER=1`,
    }
  }

  const runMode = detectRunMode().mode
  const subagentType = input?.subagent_type ?? input?.subagentType
  const targetRole = inferTargetRole(subagentType)
  const depth = await resolveCurrentDepth(sessionId)

  // ─── Main path: ask the router ──
  try {
    const result = await requestAgentAction({
      caller: {
        memberId,
        memberSecret,
        sessionId,
        spawnDepth: depth,
        pid: process.pid,
        runMode,
      },
      intent: 'inline_helper',
      target: { role: targetRole },
      task: {
        title: input?.description?.slice(0, 80) ?? 'subagent task',
        description: description || '(no description provided)',
      },
    }, { timeoutMs: 6000 })

    if (result.decision === 'inline_ok' && result.inline) {
      // Phase 4.3 — in-process brief registration.
      //
      // Important: opencode's `task` tool does NOT spawn a subprocess. It
      // creates a sub-session within the SAME opencode runtime, handled by
      // the SAME plugin instance. So we don't inject env vars; we register
      // the brief in our in-process registry, keyed by spawnBriefRef. On
      // the first chat.message for the new sub-session, we claim the brief,
      // associate it with the session ID, and apply:
      //   - composed system prompt (via experimental.chat.system.transform)
      //   - tool restrictions (via tool.definition + tool.execute.before)
      //   - per-call reminder injected into chat parts
      const { registerBrief } = await import('./spawn-brief-applier')
      registerBrief({
        briefRef: result.inline.spawnBriefRef,
        decisionLogId: result.decisionLogId,
        parentMemberId: memberId,
      })

      helperStarted()
      dbg(`task routed via engine: decision=inline_ok role=${targetRole} ` +
          `decisionLogId=${result.decisionLogId.slice(0, 8)} promptHash=${result.audit.promptHash?.slice(0, 8)} ` +
          `briefRef=${result.inline.spawnBriefRef}`)
      return undefined  // ALLOW (opencode spawns sub-session, our chat.message hook will pick up brief)
    }
    return {
      decision: 'block',
      message: `Unexpected engine decision: ${result.decision} (${result.reason})`,
    }
  } catch (e: any) {
    if (e instanceof RouterRejectedError) {
      const resp = e.response
      const alt = resp.denial?.alternative ? `\n\nAlternative: ${resp.denial.alternative}` : ''
      return {
        decision: 'block',
        message: `Task blocked by router: ${resp.reason}${alt}\n\n(decisionLogId: ${resp.decisionLogId})`,
      }
    }
    if (e instanceof RouterUnreachableError) {
      // Router was reachable a moment ago (we just probed /health), so this
      // is a real network/protocol error. Surface explicitly.
      return {
        decision: 'block',
        message:
          `Task blocked: router became unreachable during request (${e.reason}).\n` +
          `Check \`wake-status\` or \`journalctl --user -u synqtask-stack -n 50\`.`,
      }
    }
    // Unknown error — fail-closed for safety.
    dbg(`task routing error: ${e?.message ?? String(e)}`)
    return {
      decision: 'block',
      message:
        `Task routing error: ${e?.message ?? 'unknown'}.\n` +
        `Run \`wake-status\` to diagnose.`,
    }
  }
}

/**
 * Backward-compat shim — kept only because existing in-tree callers reference
 * the old name. New code uses routeTaskThroughEngine directly. Both paths
 * lead to the SAME implementation; no legacy bypass anywhere.
 */
async function handlePreToolUseSpawnCheck(
  toolName: string,
  sessionId: string,
  input?: Record<string, any>,
): Promise<{ decision: 'block'; message: string } | undefined> {
  return routeTaskThroughEngine(toolName, sessionId, input, undefined)
}

export default {
  id: 'opencode-signal-wire',
  server: async (input: any) => {
    startupSeq = 0
    const startupMs = Date.now()
    const pkg = readOwnPackage()
    const cwd = input.directory ?? process.cwd()
    const serverUrl = getServerUrl(input)
    const sessionId = input.sessionID ?? 'unknown'
    let agentInstanceId = process.env.OPENCODE_AGENT_INSTANCE_ID ?? `opencode:${sessionId}:${process.pid}`
    // Phase 2.4: Identity bootstrap (read router.json + provision or cache hit).
    //
    // Sets SYNQTASK_MEMBER_ID/SECRET in process.env when provisioning succeeds.
    // When it fails (router down, no router.json, provision rejected):
    //   - We do NOT silently fall back to whatever happened to be in env before.
    //   - Plugin continues to boot (signal-wire engine, wake-listener, etc. still load
    //     because they're decoupled from identity), but downstream identity-dependent
    //     operations (task tool through router, SynqTask MCP calls as agent) will
    //     hit explicit failure paths with actionable recovery instructions.
    //   - Operator must fix the root cause (start stack, run install).
    let provisionedIdentity: ResolvedIdentity | null = null
    try {
      provisionedIdentity = await bootstrapIdentity({ cwd })
      if (provisionedIdentity) {
        applyIdentityToEnv(provisionedIdentity)
        logStep('IDENTITY_PROVISIONED', {
          memberId: provisionedIdentity.memberId,
          role: provisionedIdentity.role,
          deterministicKey: provisionedIdentity.deterministicKey,
          isNew: provisionedIdentity.isNewlyProvisioned,
          orgRoleSlug: provisionedIdentity.orgRole?.slug ?? 'unknown',
        })
      } else {
        // No router.json AND no cache → plugin runs without provisioned identity.
        // This is degraded mode; identity-dependent operations will explicitly fail
        // (not silently use whatever env had).
        logStep('IDENTITY_NOT_PROVISIONED', {
          reason: 'no_router_json_and_no_cache',
          impact: 'task_tool_will_block_until_router_reachable',
          recovery: 'run `wake-status install` then restart opencode',
        })
        // Clear any inherited stale identity env so downstream sees the truth:
        // we don't have an identity. Tells task tool "block with clear message"
        // rather than "use stale memberId that backend will reject anyway".
        if (process.env.SYNQTASK_MEMBER_ID && !process.env.OPENCODE_AGENT_INSTANCE_ID) {
          // Only clear when the env doesn't look like opencode.json-driven config.
          // OPENCODE_AGENT_INSTANCE_ID presence means an external launcher pre-set
          // identity intentionally — respect that path.
          delete (process.env as any).SYNQTASK_MEMBER_ID
          delete (process.env as any).SYNQTASK_MEMBER_SECRET
        }
      }
    } catch (e: any) {
      // Bootstrap threw (network, parse error, etc.). Surface explicitly.
      logStep('IDENTITY_BOOTSTRAP_ERROR', {
        error: e?.message ?? String(e),
        impact: 'task_tool_will_block_until_router_reachable',
        recovery: 'check journalctl --user -u synqtask-stack and wake-status',
      })
    }

    const { memberId, memberType, agentRegistration, projectConfigFound, agentIdSource } = resolveMemberHints(cwd)

    logStep('PLUGIN_BANNER', {
      package: pkg.name,
      version: pkg.version,
      packageJson: pkg.path,
      entrypoint: import.meta.url,
      pid: process.pid,
      cwd,
      node: process.version,
    })
    logStep('RUNTIME_INPUT', {
      serverUrl: maskPresence(serverUrl),
      directory: cwd,
      sessionID: maskPresence(input.sessionID),
      client: maskPresence(input.client),
    })
    logStep('ENV_SUMMARY', {
      OPENCODE_AGENT_INSTANCE_ID: maskPresence(process.env.OPENCODE_AGENT_INSTANCE_ID),
      SYNQTASK_API_URL: maskPresence(process.env.SYNQTASK_API_URL),
      SYNQTASK_MEMBER_ID: maskPresence(process.env.SYNQTASK_MEMBER_ID),
      SYNQTASK_AGENT_REGISTRATION: process.env.SYNQTASK_AGENT_REGISTRATION === '1' ? 'enabled' : 'disabled',
      SYNQTASK_REGISTER_AGENT: process.env.SYNQTASK_REGISTER_AGENT === '1' ? 'enabled' : 'disabled',
      SYNQTASK_AGENT_NAME: maskPresence(process.env.SYNQTASK_AGENT_NAME),
      SYNQTASK_SPACE_ID: maskPresence(process.env.SYNQTASK_SPACE_ID),
      WAKE_LISTENER_DEBUG: process.env.WAKE_LISTENER_DEBUG ?? 'unset',
      OPENCODE_SIGNAL_WIRE_DEBUG: process.env.OPENCODE_SIGNAL_WIRE_DEBUG ?? 'unset',
    })
    logStep('IDENTITY_HINTS', {
      sessionId,
      agentInstanceId,
      agentInstanceIdSource: process.env.OPENCODE_AGENT_INSTANCE_ID ? 'env' : 'generated',
      memberId: maskPresence(memberId),
      memberType,
      agentIdSource,
      projectConfigFound,
      agentRegistrationConfig: agentRegistration ? 'present' : 'absent',
    })

    const prefs = loadPreferences(cwd)
    const { subscribe, preset } = computeSubscribe(prefs, memberType)
    logStep('WAKE_PREFERENCES', {
      preset: preset ?? 'default',
      subscribe: subscribe ?? 'default',
    })

    const signalWire = serverUrl ? createSignalWire(serverUrl, sessionId, input.client) : null
    logStep('SIGNAL_WIRE_ENGINE', {
      created: Boolean(signalWire),
      reason: signalWire ? 'serverUrl_present' : 'serverUrl_absent',
    })

    // ─── Expose signalWire to token-rotation-bridge consumers ─────────
    // PRP token-rotation-deferred-apply: provider.ts in opencode-claude
    // creates ClaudeCodeSDK with a contextTokensProvider that lazily
    // looks up signalWire.getContextPosition() via the bridge registry.
    // Per-session lifecycle: overwritten on each session's createSignalWire
    // call. Mirrors the setBoundSdk/_boundSdk pattern in
    // token-rotation-bridge.ts (cross-package handoff without adding a
    // direct dep). Best-effort; never block plugin init.
    if (signalWire) {
      try { setCurrentSignalWire(signalWire as any) } catch { /* */ }
    }

    const signalWireEngine = signalWire
      ? {
          evaluateExternal: async (event: any) => {
            const result = await signalWire.evaluateExternal(event)
            // Extract hint texts from emitter results so wake-listener can
            // route them through injectHintText (the canonical context-
            // injection path). Patch (systematic fix): without this, hint
            // actions emitted by matched rules were swallowed at the
            // evaluator boundary, which is why the 18 loaded rules fired
            // into the void since signal-wire-architecture-v3.
            const hintTexts: string[] = []
            for (const r of result.results) {
              const ar = r as { type?: string; success?: boolean; hintText?: string }
              if ((ar.type === 'hint' || ar.type === 'respond') && ar.success && ar.hintText) {
                hintTexts.push(ar.hintText)
              }
            }
            return {
              matched: result.matched.length > 0,
              matchedCount: result.matched.length,
              actionsExecuted: result.results.map(r => ({ type: r.type, wakeTriggered: Boolean((r as any).wakeTriggered) })),
              wakeTriggered: result.results.some(r => Boolean((r as any).wakeTriggered)),
              hintTexts,
            }
          },
          // Direct in-process pipeline access for hook normalizers
          // (chat.message, tool.execute.before/after). Returns raw
          // EmitResult[] so the hook caller can apply hint/block results
          // with full fidelity.
          evaluateHook: (event: any) => signalWire.evaluateHook(event),
        }
      : null
    let wakeHandle: WakeListenerHandle | null = null
    let boundSessionId = sessionId !== 'unknown' ? sessionId : null

    const bindSession = (candidateSessionId: string, reason: string, directory?: string) => {
      if (!candidateSessionId) return false
      if (boundSessionId && boundSessionId !== candidateSessionId) {
        logStep('SESSION_BIND_SKIPPED', { reason: 'already_bound', existing: boundSessionId, candidate: candidateSessionId })
        return false
      }
      if (!process.env.OPENCODE_AGENT_INSTANCE_ID && agentInstanceId.includes(':unknown:')) {
        agentInstanceId = `opencode:${candidateSessionId}:${process.pid}`
      }
      const bound = bindWakeListenerSession(wakeHandle, candidateSessionId, { agentInstanceId, reason })
      if (bound) boundSessionId = candidateSessionId
      // Propagate the resolved sessionId to the SignalWire adapter so its
      // runtimeMeta.sessionId stops emitting the boot-time placeholder
      // `'unknown'`. Without this, hint templates like
      // `<ctx session="{sessionId}" />` show `session="unknown"` for the
      // whole process lifetime even after the real session is bound.
      if (bound && signalWire) {
        try { signalWire.setSessionId(candidateSessionId) } catch { /* best-effort */ }
      }
      logStep(bound ? 'SESSION_BOUND' : 'SESSION_BIND_SKIPPED', {
        reason,
        sessionId: candidateSessionId,
        directory: directory ?? 'absent',
        agentInstanceId,
      })
      return bound
    }

    const scheduleSessionBindRetries = () => {
      const delays = [250, 1000, 3000]
      for (const delay of delays) {
        setTimeout(() => {
          void (async () => {
            if (boundSessionId) return
            try {
              const candidate = await findNewSessionByDirectory(input.client, cwd, startupMs)
              if (candidate.count === 1 && candidate.id) {
                bindSession(candidate.id, `sdk_session_list_after_${delay}ms`, candidate.directory)
              } else {
                logStep(candidate.count > 1 ? 'SESSION_BIND_AMBIGUOUS' : 'SESSION_BIND_WAITING', {
                  reason: `sdk_session_list_after_${delay}ms`,
                  directory: cwd,
                  candidates: candidate.count,
                })
              }
            } catch (e: any) {
              logStep('SESSION_BIND_WAITING', { reason: `sdk_session_list_failed_after_${delay}ms`, error: e?.message ?? String(e) })
            }
          })()
        }, delay)
      }
    }

    let quotaHandle: QuotaWatcherHandle | null = null

    if (serverUrl) {
      try {
        logStep('WAKE_LISTENER_STARTING', { sessionId, agentInstanceId })
        wakeHandle = await startWakeListener({
          serverUrl,
          sessionId,
          agentInstanceId,
          memberId,
          synqtaskUrl: process.env.SYNQTASK_API_URL,
          signalWire: signalWireEngine,
          sdkClient: input.client,
          subscribe,
          subscribePreset: preset ?? undefined,
          memberType,
          agentRegistration: {
            enabled: Boolean(agentRegistration?.enabled)
              || process.env.SYNQTASK_AGENT_REGISTRATION === '1'
              || process.env.SYNQTASK_REGISTER_AGENT === '1',
            name: agentRegistration?.name ?? process.env.SYNQTASK_AGENT_NAME,
            displayName: agentRegistration?.displayName ?? process.env.SYNQTASK_AGENT_DISPLAY_NAME,
            description: agentRegistration?.description ?? process.env.SYNQTASK_AGENT_DESCRIPTION,
            spaceId: agentRegistration?.spaceId ?? process.env.SYNQTASK_SPACE_ID,
          },
        })
        logStep('WAKE_LISTENER_STARTED', {
          port: wakeHandle.port,
          sessionId,
          agentInstanceId,
          token: wakeHandle.token ? `${wakeHandle.token.slice(0, 8)}...` : 'absent',
        })
        scheduleSessionBindRetries()
      } catch (e: any) {
        logStep('WAKE_LISTENER_FAILED_OPEN', { error: e?.message ?? String(e) })
      }
    } else {
      logStep('WAKE_LISTENER_SKIPPED', { reason: 'serverUrl_absent', sessionId })
    }

    // ─── Quota Watcher ─────────────────────────────────────────────
    // Independent of wake-listener (file-watcher, not HTTP). Starts even
    // when serverUrl is absent — quota-status.json is local and only needs
    // signalWire engine for routing. Will degrade gracefully (direct-
    // inject via injectContextEvent) if signalWire is null.
    try {
      quotaHandle = startQuotaWatcher({
        signalWire: signalWireEngine,
        resolveSessionId: () => boundSessionId ?? (sessionId !== 'unknown' ? sessionId : null),
        log: (msg) => dbg(msg),
      })
      logStep('QUOTA_WATCHER_STARTED', { pid: process.pid })
    } catch (e: any) {
      logStep('QUOTA_WATCHER_FAILED_OPEN', { error: e?.message ?? String(e) })
    }

    return {
      event: async ({ event }: { event: any }) => {
        const eventType = eventTypeOf(event)
        logStep('OPENCODE_EVENT', {
          eventType,
          keys: event && typeof event === 'object' ? Object.keys(event).slice(0, 10) : [],
        })
        if (eventType === 'session.created' || eventType === 'session.updated') {
          const session = sessionFromEvent(event)
          if (session.id && (!session.directory || session.directory === cwd)) {
            bindSession(session.id, eventType, session.directory)
          } else {
            logStep('SESSION_BIND_SKIPPED', {
              eventType,
              reason: session.id ? 'directory_mismatch_or_absent' : 'missing_session_id',
              sessionId: session.id ?? 'absent',
              directory: session.directory ?? 'absent',
            })
          }
        }
        if (eventType === 'app.exit' || eventType === 'server.stop') {
          try {
            if (wakeHandle) {
              stopWakeListener(wakeHandle)
              logStep('WAKE_LISTENER_STOPPED', { eventType })
            }
          } catch (e: any) {
            logStep('WAKE_LISTENER_STOP_FAILED_OPEN', { error: e?.message ?? String(e) })
          }
          try {
            if (quotaHandle) {
              quotaHandle.stop()
              logStep('QUOTA_WATCHER_STOPPED', { eventType })
            }
          } catch (e: any) {
            logStep('QUOTA_WATCHER_STOP_FAILED_OPEN', { error: e?.message ?? String(e) })
          }
        }
      },
      pre_tool_use: async ({ toolName, input }: { toolName: string; input?: any }) => {
        return await handlePreToolUseSpawnCheck(toolName, boundSessionId ?? sessionId, input)
      },

      // ─── Phase 4.5: System prompt + tool definition hooks ──────────────
      // Inject role-specific context (from OrgRole template OR ephemeral
      // brief for sub-sessions) into opencode's system prompt and tool
      // definitions sent to the LLM.

      'experimental.chat.system.transform': async (input: any, output: any) => {
        const { systemTransformHook } = await import('./system-prompt-hook')
        await systemTransformHook(input, output)
      },

      'tool.definition': async (input: any, output: any) => {
        const { toolDefinitionHook } = await import('./tool-definition-hook')
        await toolDefinitionHook(input, output)
      },

      // ─── In-process rule-engine hooks (signal-wire-architecture-v3 Stage 2) ─
      // Closes the "НЕ мигрировал opencode-claude" item from
      // PRPs/signal-wire-architecture-v3/AUDIT-FULL.md. The hook normalizers,
      // appliers, and signalWire.evaluateHook() route all rule-driven
      // injection (hint/block/exec) through the canonical
      // @kiberos/signal-wire-core engine — same engine wake-listener already
      // uses via evaluateExternal, but for in-process events.

      'chat.message': async (input: any, output: any) => {
        // ─── Token rotation: turn-boundary apply (REQ-08 / CR-04) ───
        // User sent a new message → that's the consent-signal to apply
        // any deferred rotation BEFORE the next API request. The SDK
        // (registered by opencode-claude via wireTokenRotation) owns the
        // pending state; we just trigger the apply at the safe boundary.
        // Fail-open per NFR-08: rotation hiccups must NOT block the
        // user's message processing.
        try {
          const sdk = getBoundSdk()
          if (sdk?.tokenRotation?.hasPending?.() && sdk.tokenRotation.applyPending) {
            await sdk.tokenRotation.applyPending('turn-boundary').catch((e: any) => {
              logStep('TOKEN_ROTATION_TURN_BOUNDARY_FAILED_OPEN', {
                error: e?.message ?? String(e),
              })
            })
          }
        } catch (e: any) {
          logStep('TOKEN_ROTATION_TURN_BOUNDARY_FAILED_OPEN', {
            error: e?.message ?? String(e),
          })
        }

        if (!signalWireEngine) return
        try {
          const event = normalizeChatMessage(input ?? {}, output ?? { parts: [] })
          // Use bound session if available — input.sessionID is authoritative
          // but boundSessionId fallback handles the rare case where opencode
          // delivers the hook before session.created bookkeeping settles.
          if (!event.sessionId && boundSessionId) {
            ;(event as any).sessionId = boundSessionId
          }
          // chat.message always carries the authoritative session id — use
          // it to refresh the SignalWire adapter so runtimeMeta.sessionId
          // is correct for THIS turn's hint interpolation, even if
          // bindSession never fired (e.g. server started before opencode
          // surfaced the session, then user typed before retries landed).
          if (event.sessionId && signalWire) {
            try { signalWire.setSessionId(event.sessionId) } catch { /* */ }
          }
          // Track model from input.model — opencode supplies provider+modelID.
          // Updates runtimeMeta lastModel for subsequent runtimeMeta predicates
          // and template interpolation in this and following turns.
          const modelId = input?.model?.modelID
          if (typeof modelId === 'string' && modelId.length > 0) {
            try { (signalWireEngine as any).trackModel?.(modelId) } catch { /* tracking is best-effort */ }
          }
          // Coarse context-position estimate from text part lengths.
          // ~4 chars/token (Anthropic Claude tokenizer rule of thumb).
          // This is a fallback so context-percent rules can fire even when
          // sdk-provided trackTokens is not wired. Real usage data (from
          // RAW_USAGE log) supersedes this when sdk hooks land.
          try {
            let totalChars = 0
            const parts = (output as any)?.parts
            if (Array.isArray(parts)) {
              for (const p of parts) {
                const t = (p as any)?.text
                if (typeof t === 'string') totalChars += t.length
              }
            }
            if (totalChars > 0) {
              ;(signalWireEngine as any).trackTokens?.({ inputTokens: Math.ceil(totalChars / 4) })
            }
          } catch { /* best-effort */ }
          const results = await signalWireEngine.evaluateHook(event)
          const matched = results.length
          if (matched > 0) {
            const injected = applyChatHintResults(results, output ?? { parts: [] }, event.sessionId)
            logStep('HOOK_FIRED', {
              hook: 'chat.message',
              sessionId: event.sessionId ?? 'unbound',
              matched,
              hintsInjected: injected,
            })
            // Side-effect: if 'quota-on-demand-trigger' fired (user asked
            // about quota), force-inject current quota snapshot. The rule's
            // hint already informed the agent that fresh values are coming;
            // this side-effect actually delivers them. Async/non-blocking —
            // hint is already in output, snapshot arrives in next message
            // turn as <system-reminder type="wake" event="quota_status">.
            const triggeredOnDemand = results.some(
              (r: any) => r?.ruleId === 'quota-on-demand-trigger',
            )
            if (triggeredOnDemand && quotaHandle) {
              // Don't await — let it inject in background. Errors are
              // already logged inside injectCurrentSnapshot.
              void quotaHandle.injectCurrentSnapshot().catch(() => { /* logged */ })
              logStep('QUOTA_ON_DEMAND_TRIGGERED', {
                sessionId: event.sessionId ?? 'unbound',
              })
            }
          }
        } catch (e: any) {
          logStep('HOOK_FAILED_OPEN', { hook: 'chat.message', error: e?.message ?? String(e) })
        }
      },

      'tool.execute.before': async (input: any, output: any) => {
        // ═══════════════════════════════════════════════════════════════
        // Phase 4.5.3 — role-based + ephemeral-brief tool blocking
        // (runs BEFORE signal-wire rule engine so rules can layer on top)
        // ═══════════════════════════════════════════════════════════════
        try {
          const toolName = input?.tool ?? ''
          const sessionID = input?.sessionID ?? boundSessionId ?? ''

          // 1) Sub-session blocked tools (from ephemeral brief)
          const { getBriefForSession } = await import('./spawn-brief-applier')
          const brief = sessionID ? getBriefForSession(sessionID) : null
          if (brief?.blockedTools?.includes(toolName)) {
            if (output?.args) {
              output.args = {
                _swBlocked: true,
                _swReason: `Tool '${toolName}' is blocked for this sub-session's role (ephemeral brief). Use one of: ${brief.allowedTools.join(', ')}`,
                _swDecisionLogId: brief.decisionLogId,
              }
            }
            logStep('TOOL_BLOCKED_BY_BRIEF', {
              tool: toolName,
              sessionId: sessionID,
              decisionLogId: brief.decisionLogId,
              allowedTools: brief.allowedTools,
            })
            return  // hard stop; signal-wire engine doesn't run
          }

          // 2) Parent identity blocked tools (from OrgRole.metadata.tools_blocked)
          const memberId = process.env.SYNQTASK_MEMBER_ID
          if (memberId && !brief) {
            // Only check parent identity blocks for non-sub-session calls
            // (sub-session blocks are handled by step 1)
            const { _getBlockedForSession } = await import('./tool-definition-hook')
            const blocked = _getBlockedForSession(sessionID)
            if (blocked.includes(toolName)) {
              const role = process.env.SYNQTASK_AGENT_ROLE ?? 'unknown'
              if (output?.args) {
                output.args = {
                  _swBlocked: true,
                  _swReason: `Tool '${toolName}' is blocked for your role '${role}'. ` +
                             `Allowed tools are listed in your AGENT.md role section. ` +
                             `To use this tool, delegate to a higher-privilege role via 'task' tool or SynqTask.`,
                  _swRole: role,
                }
              }
              logStep('TOOL_BLOCKED_BY_ROLE', { tool: toolName, sessionId: sessionID, role })
              return  // hard stop
            }
          }
        } catch (e: any) {
          // Role/brief check failure must NOT block tool execution
          // (would deny legitimate calls). Log and fall through to signal-wire engine.
          logStep('TOOL_BLOCK_CHECK_FAILED_OPEN', { error: e?.message ?? String(e) })
        }

        // ═══════════════════════════════════════════════════════════════
        // Existing signal-wire rule engine path (Phase 4.5.3 layers on top)
        // ═══════════════════════════════════════════════════════════════
        if (!signalWireEngine) return
        try {
          const event = normalizeToolBefore(input ?? { tool: 'unknown', sessionID: '', callID: '' }, output ?? { args: {} })
          if (!event.sessionId && boundSessionId) {
            ;(event as any).sessionId = boundSessionId
          }
          const results = await signalWireEngine.evaluateHook(event)
          if (results.length > 0) {
            const blockReason = applyBlockResults(results, output ?? { args: {} }, input?.tool)
            logStep('HOOK_FIRED', {
              hook: 'tool.execute.before',
              tool: input?.tool,
              sessionId: event.sessionId ?? 'unbound',
              matched: results.length,
              blocked: Boolean(blockReason),
              blockReason: blockReason ?? undefined,
            })
          }
        } catch (e: any) {
          logStep('HOOK_FAILED_OPEN', { hook: 'tool.execute.before', error: e?.message ?? String(e) })
        }
      },

      'tool.execute.after': async (input: any, output: any) => {
        if (!signalWireEngine) return
        try {
          const event = normalizeToolAfter(
            input ?? { tool: 'unknown', sessionID: '', callID: '', args: {} },
            output ?? { title: '', output: '', metadata: {} },
          )
          if (!event.sessionId && boundSessionId) {
            ;(event as any).sessionId = boundSessionId
          }
          const results = await signalWireEngine.evaluateHook(event)
          if (results.length > 0) {
            const safeOutput = output ?? { output: '', title: '', metadata: {} }
            // CR-03 + REQ-05 + NFR-07: compact MUST run BEFORE hint append
            // so subsequent hint text lands on the compacted body, not the
            // raw original. Cross-rule idempotency (REQ-15) enforced inside.
            const compactResult = applyCompactResults(results, safeOutput, event.sessionId)
            const injected = applyHintResults(results, safeOutput, event.sessionId)
            logStep('HOOK_FIRED', {
              hook: 'tool.execute.after',
              tool: input?.tool,
              sessionId: event.sessionId ?? 'unbound',
              matched: results.length,
              hintsInjected: injected,
              ...(compactResult.compacted && {
                compactRuleId: compactResult.ruleId,
                bytesDropped: compactResult.bytesDropped,
                linesDropped: compactResult.linesDropped,
              }),
            })
          }
        } catch (e: any) {
          logStep('HOOK_FAILED_OPEN', { hook: 'tool.execute.after', error: e?.message ?? String(e) })
        }
      },
    }
  },
}
