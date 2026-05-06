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
  checkSpawnAllowed,
  getAgentIdentity,
  getSpawnActive,
  getSpawnTotal,
  helperStarted,
  resolveCurrentDepth,
  bindWakeListenerSession,
  startWakeListener,
  stopWakeListener,
} from './wake-listener'
import type { WakeListenerHandle } from './wake-listener'
import { computeSubscribe, loadPreferences } from './wake-preferences'
import {
  normalizeChatMessage,
  normalizeToolBefore,
  normalizeToolAfter,
  applyHintResults,
  applyChatHintResults,
  applyBlockResults,
} from './hook-listener'
import { startQuotaWatcher, type QuotaWatcherHandle } from './quota-watcher'

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

async function handlePreToolUseSpawnCheck(
  toolName: string,
  sessionId: string,
  input?: Record<string, any>,
): Promise<{ decision: 'block'; message: string } | undefined> {
  const spawnTools = ['task', 'Task', 'task_tool', 'call_omo_agent']
  if (!spawnTools.includes(toolName)) return undefined

  try {
    const identity = getAgentIdentity()
    const depth = await resolveCurrentDepth(sessionId)

    if (!identity || !identity.roleName) {
      const maxDepth = parseInt(process.env.__MAX_HELPER_DEPTH ?? '1', 10)
      if (depth >= maxDepth) {
        return {
          decision: 'block',
          message: [
            `Helper blocked: depth ${depth}/${maxDepth}.`,
            `Do the work yourself and return the result; do not spawn another task agent at this level.`,
          ].join('\n'),
        }
      }
      helperStarted()
      dbg(`helper spawn OK depth=${depth}/${maxDepth} active=${getSpawnActive()} total=${getSpawnTotal()}`)
      return undefined
    }

    const check = checkSpawnAllowed(identity, depth, getSpawnActive())
    if (!check.allowed) {
      const roleName = identity.roleName ?? 'unknown'
      const reason = check.depth >= check.maxDepth
        ? `Depth ${check.depth}/${check.maxDepth} for role '${roleName}'.`
        : `Active helpers ${check.active}/${check.maxConcurrent} for role '${roleName}'.`
      return {
        decision: 'block',
        message: [`Spawn blocked: ${reason}`, `Do the work yourself or coordinate through SynqTask instead of spawning.`].join('\n'),
      }
    }

    const description = String(input?.description ?? input?.prompt ?? input?.message ?? '')
    if (description.length < 200) {
      return {
        decision: 'block',
        message: `Delegation blocked: description too short (${description.length} chars, need 200+). Include concrete task, constraints, files, and expected output.`,
      }
    }

    helperStarted()
    dbg(`agent spawn OK role=${identity.roleName} depth=${depth} active=${getSpawnActive()} total=${getSpawnTotal()}`)
  } catch (e: any) {
    dbg(`pre_tool_use spawn check failed-open: ${e?.message}`)
  }

  return undefined
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

      // ─── In-process rule-engine hooks (signal-wire-architecture-v3 Stage 2) ─
      // Closes the "НЕ мигрировал opencode-claude" item from
      // PRPs/signal-wire-architecture-v3/AUDIT-FULL.md. The hook normalizers,
      // appliers, and signalWire.evaluateHook() route all rule-driven
      // injection (hint/block/exec) through the canonical
      // @kiberos/signal-wire-core engine — same engine wake-listener already
      // uses via evaluateExternal, but for in-process events.

      'chat.message': async (input: any, output: any) => {
        if (!signalWireEngine) return
        try {
          const event = normalizeChatMessage(input ?? {}, output ?? { parts: [] })
          // Use bound session if available — input.sessionID is authoritative
          // but boundSessionId fallback handles the rare case where opencode
          // delivers the hook before session.created bookkeeping settles.
          if (!event.sessionId && boundSessionId) {
            ;(event as any).sessionId = boundSessionId
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
            const injected = applyHintResults(results, output ?? { output: '', title: '', metadata: {} }, event.sessionId)
            logStep('HOOK_FIRED', {
              hook: 'tool.execute.after',
              tool: input?.tool,
              sessionId: event.sessionId ?? 'unbound',
              matched: results.length,
              hintsInjected: injected,
            })
          }
        } catch (e: any) {
          logStep('HOOK_FAILED_OPEN', { hook: 'tool.execute.after', error: e?.message ?? String(e) })
        }
      },
    }
  },
}
