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
import { execSuppressionReason } from '@kiberos/signal-wire-core'
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
  writeThoughtFile,
} from './hook-listener'
import { startQuotaWatcher, type QuotaWatcherHandle } from './quota-watcher'
import { getBoundSdk, setCurrentSignalWire } from './token-rotation-bridge'
import { WAKE_ROOT, AGENT_IDENTITY_DIR } from './domain-constants'
import { sessionFromArgv } from './session-argv'
import { isOneShotRun } from './launch-kind'
import { createModelWindowResolver, usageFromMessageEvent } from './context-usage'
import { answeredFromPermissionReplied, askedFromPermissionUpdated, createPermissionKindMemory, createSessionStartTracker, endFromSessionDeleted, errorFromSessionError, extractSessionId, failureFromPartUpdated } from './session-lifecycle'
import { defaultOpencodeDbPath, readModelWindowSpend, readSessionSpend } from './session-spend'
import { computeGoWindows, GO_MODEL_MONTHLY_LIMIT_USD } from './provider-go-usage'
import { stampSessionLaunch } from './session-stamp'
import { PROVIDER_QUOTA_ENDPOINTS, queryProviderQuota, type ProviderQuota } from './provider-quota'

const DEBUG = process.env.OPENCODE_SIGNAL_WIRE_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'opencode-signal-wire-debug.log')

let startupSeq = 0

// Расход сессии из базы opencode обновляется не чаще раза в минуту на процесс.
let lastSpendRefreshMs = 0
// Старт сессии — один раз на процесс (session-lifecycle.ts): повторы
// session.created — переподключения, не новые процессы.
const isFirstSessionStart = createSessionStartTracker()
// Вид запроса человеку по id (PRP 08): в replied вида нет, помним из asked.
const permissionKinds = createPermissionKindMemory()
// Клеймо запуска — один раз на процесс (реестр однократен, повтор безопасен).
const stampGuard: { done?: boolean } = {}
// Лимиты поставщиков — не чаще раза в 10 минут: это внешняя сеть за деньги чужих дверей.
let lastProviderQuotaRefreshMs = 0

/**
 * Опрос дверей лимитов Zhipu/Z.ai своим ключом (provider-quota.ts). Ключи читаются
 * из auth.json в момент запроса и никуда не едут, кроме самих дверей: в журнал —
 * только имена поставщиков и счёт лимитов, никогда ключи и их обрезки. Пусто = null.
 */
async function refreshProviderQuota(signalWire: { trackProviderQuota: (q: ProviderQuota[] | null) => void }): Promise<void> {
  try {
    const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
    if (!existsSync(authPath)) { signalWire.trackProviderQuota(null); return }
    const auth = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, { type?: unknown; key?: unknown }>
    // Связка измерена живьём 06.10 (обе 200): ключ `zai` → bigmodel.cn, ключ `zai-coding-plan` → api.z.ai.
    const pairs = [
      { provider: 'zhipu' as const, key: auth['zai']?.key },
      { provider: 'zai' as const, key: auth['zai-coding-plan']?.key },
    ] as const
    const out: ProviderQuota[] = []
    await Promise.all(pairs.map(async ({ provider, key }) => {
      if (typeof key !== 'string' || !key) return
      const q = await queryProviderQuota(fetch as any, provider, key)
      if (q) out.push(q)
    }))
    // Окна Go из публичных лимитов и измеренного расхода (provider-go-usage.ts):
    // вход не нужен, только база. Модели без трафика не везём.
    try {
      const { Database } = await import('bun:sqlite')
      const openDb = (path: string) => new Database(path, { readonly: true }) as any
      const dbPath = process.env.OPENCODE_DB_PATH ?? defaultOpencodeDbPath()
      const nowMs = Date.now()
      for (const modelId of Object.keys(GO_MODEL_MONTHLY_LIMIT_USD)) {
        const s = readModelWindowSpend(openDb, dbPath, modelId, nowMs)
        if (!s || (s.spend5h == null && s.spendWeek == null && s.spendMonth == null)) continue
        const windows = computeGoWindows(modelId, s.spend5h, s.spendWeek, s.spendMonth, new Date(nowMs))
        if (!windows) continue
        out.push({
          provider: 'go' as const,
          measuredAt: new Date(nowMs).toISOString(),
          limits: [],
          windows: windows.map((w) => ({ kind: w.kind, util: w.util, measuredAt: w.measuredAt })),
        })
      }
    } catch (e: any) {
      logStep('GO_WINDOWS_FAILED', { error: e?.message ?? String(e) })
    }
    signalWire.trackProviderQuota(out.length > 0 ? out : null)
    logStep('PROVIDER_QUOTA_REFRESH', { providers: out.map((q) => `${q.provider}:${q.limits.length}`) })
  } catch (e: any) {
    logStep('PROVIDER_QUOTA_REFRESH_FAILED', { error: e?.message ?? String(e) })
  }
}

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

/**
 * 🔴 Suppression that leaks into a LIVE session looks exactly like a quiet day.
 *
 * If a test-runner marker (NODE_ENV/BUN_ENV=test) reaches a real opencode
 * process, every `exec` action in the fleet's rules goes silent — memory
 * writes, session reconciliation, mirror syncs — and nothing in the visible
 * output says so.
 *
 * The core announces this too, on stderr, since its commit 9310c35 — so why
 * keep ours? Because the two say DIFFERENT things. Theirs fires at the first
 * suppressed ACTION, so a session where no exec rule ever matched hears
 * nothing at all; ours fires at engine construction, unconditionally, before
 * a single event. Earlier and always — that is what an operator needs from
 * the process they are actually sitting in front of.
 *
 * ONCE PER PROCESS, not per engine. `server:` is invoked per SESSION (see
 * `input.sessionID`), so the first version of this line — shipped 2026-08-18
 * without a guard — would have repeated for every session an opencode process
 * served. That is precisely the noise that gets a warning muted. Same idiom as
 * `adapterBannerEmitted` in signal-wire.ts, which exists for the same reason.
 *
 * `SW_EXEC_OFF` is deliberately NOT reported: it is set knowingly, by our own
 * test suite. Only the default nobody asked for is worth shouting about.
 */
/**
 * The DECISION, split out from the guard so both halves can be tested with a
 * real red path: what (if anything) this process should say about exec
 * suppression right now. Returns null when there is nothing to say.
 *
 * Exported for its test. Keeping it fused with the once-per-process guard made
 * the "explicit switch stays silent" case untestable — the guard, already
 * tripped by the previous test, would have swallowed the call and the test
 * would have passed no matter what this function decided. A test that cannot
 * fail is worse than no test; that is the same principle this whole file exists
 * to defend.
 */
export function execSuppressionAnnouncement(): string | null {
  const reason = execSuppressionReason()
  if (reason === null || reason.startsWith('SW_EXEC_OFF')) return null
  return `[SW] ⚠️ exec actions are SUPPRESSED in this process — ${reason}. `
    + `Rule scripts (memory writes, session sync, mirrors) will NOT run for any `
    + `session it serves. In a real session this is an environment error, not a mode.`
}

let execSuppressionAnnounced = false
/** Exported for its test only — the once-per-process guard is the whole point,
 *  and a guard nobody can observe is the class of defect this file is closing. */
export function warnIfExecSuppressedInLiveSession(): void {
  if (execSuppressionAnnounced) return
  const line = execSuppressionAnnouncement()
  if (line === null) return
  execSuppressionAnnounced = true
  console.error(line)
}

function createSignalWire(serverUrl: string, sessionId: string, sdkClient: any, oneShot: boolean, projectRoot: string): SignalWire {
  warnIfExecSuppressedInLiveSession()
  // Разовый `opencode run` не место агента: без отметки жизни и без привязки сессии к агенту — иначе
  // прогон, запущенный из сессии агента, перепишет в реестре его настоящую сессию своей.
  // Корень проекта — каталог этого окна: по нему сервер находит правила папки (.sw).
  const signalWire = new SignalWire({ serverUrl, sessionId, projectRoot, ...(oneShot ? { lifeTrace: false as const } : {}) })
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

// 🔴 ВЕТКА ДЕЛЕГИРОВАНИЯ УДАЛЕНА (02.10.2026, опись адаптера, задача signal-wire-core 9d18128d).
// Здесь жили routeTaskThroughEngine / handlePreToolUseSpawnCheck / карта «тип под-агента → роль»:
// порог «описание ≥200 знаков», блокировки «роутер недоступен», регистрация брифов. Всё это висело на
// перехватчике `pre_tool_use`, которого у opencode НЕТ (бинарь: `tool.execute.before` — 5 вхождений,
// `pre_tool_use` — 0), то есть ни разу не исполнялось. Решения о делегировании — правилам и роутеру.

/**
 * ОДИН ПРИЁМНИК ПОБУДОК И ОДИН НАБЛЮДАТЕЛЬ КВОТЫ НА ПРОЦЕСС, сколько бы раз opencode ни поднял плагин.
 *
 * opencode заводит отдельный экземпляр на каждую папку проекта и в каждом заново зовёт `server()`.
 * 30.09 пилот SynqTalk, поднятый `--session` на разговор, начатый в старой папке проекта, получил два
 * экземпляра (/mnt/d/Vibe_coding_projects/synqtalk и ~/projects/vibe/synqtalk) — и два приёмника на
 * портах 34841 и 38139. Второй перезаписал запись присутствия, первый остался слушать без адреса.
 * Агент в процессе один — значит, и дверь к нему одна. Держим в globalThis, а не в переменной модуля:
 * модуль может быть загружен дважды, если путь к плагину записан в настройках двумя написаниями.
 */
type ProcessSingletons = {
  wake?: Promise<WakeListenerHandle | null>
  quota?: QuotaWatcherHandle | null
  /** Сколько экземпляров opencode держат общие двери; закрывает их последний уходящий. */
  users?: number
}
const PROCESS_SINGLETONS_KEY = '__opencodeSignalWireProcessSingletons'
function processSingletons(): ProcessSingletons {
  const g = globalThis as Record<string, unknown>
  return (g[PROCESS_SINGLETONS_KEY] ??= {}) as ProcessSingletons
}
/**
 * Приёмник побудок процесса: первый вызов запускает `start`, остальные получают тот же. Сбой запуска
 * отдаётся всем как null — следующий экземпляр не пытается открыть вторую дверь поверх упавшей.
 */
export function processWakeListener(
  start: () => Promise<WakeListenerHandle>,
): { handle: Promise<WakeListenerHandle | null>; shared: boolean } {
  const s = processSingletons()
  s.users = (s.users ?? 0) + 1
  if (s.wake) return { handle: s.wake, shared: true }
  s.wake = start().catch(() => null)
  return { handle: s.wake, shared: false }
}

/** Экземпляр уходит. true — он был последним, и общие двери пора закрыть. */
export function releaseProcessWakeListener(): boolean {
  const s = processSingletons()
  s.users = Math.max(0, (s.users ?? 0) - 1)
  return s.users === 0
}

/** Закрыть общие двери процесса: на выходе процесса и в тестах. */
export function resetProcessSingletons(): void {
  delete (globalThis as Record<string, unknown>)[PROCESS_SINGLETONS_KEY]
}

export default {
  id: 'opencode-signal-wire',
  server: async (input: any) => {
    startupSeq = 0
    const startupMs = Date.now()
    const pkg = readOwnPackage()
    const cwd = input.directory ?? process.cwd()
    const serverUrl = getServerUrl(input)
    // Номер сессии: от opencode, иначе из командной строки пускателя (`--session <id>`) — по папке
    // продолженную сессию не найти, если она начата в другом месте проекта (session-argv.ts).
    const argvSessionId = sessionFromArgv(process.argv)
    // Разовый прогон (`opencode run`) — правила signal-wire работают, но двери агента не открываются:
    // ни приёмника побудок, ни файловой двери, ни наблюдателя квоты, ни следа, ни привязки (launch-kind.ts).
    const oneShot = isOneShotRun(process.argv)
    const sessionId = input.sessionID ?? argvSessionId ?? 'unknown'
    // Номер экземпляра: при неизвестной сессии — от места агента (KIBEROS_BINDING_ID), а не
    // 'opencode:unknown:<pid>' — живая проба 2026-09-24 видела ровно это в записи приёмника.
    const instanceAnchor = sessionId !== 'unknown' ? sessionId : (process.env.KIBEROS_BINDING_ID || sessionId)
    let agentInstanceId = process.env.OPENCODE_AGENT_INSTANCE_ID ?? `opencode:${instanceAnchor}:${process.pid}`
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

    const signalWire = serverUrl ? createSignalWire(serverUrl, sessionId, input.client, oneShot, cwd) : null
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

    const resolveModelWindow = createModelWindowResolver(() => input.client?.config?.providers?.())
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
              const ar = r as { type?: string; success?: boolean; hintText?: string; inject?: boolean }
              // v1.6 exec-inject twin gate (core ≥0.3.4): an exec result
              // flagged inject:true carries its stdout in hintText and must
              // ride the same injection path as hint/respond — without this
              // the memory-recall inject leg is silently dropped in opencode.
              const carriesHint =
                ar.type === 'hint' || ar.type === 'respond' || (ar.type === 'exec' && ar.inject === true)
              if (carriesHint && ar.success && ar.hintText) {
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
      // Клеймо запуска для семейства сборщика (session-stamp.ts): один раз на
      // процесс, не блокирует привязку, исход — в журнал строкой.
      if (bound) {
        void (async () => {
          try {
            const { execFile } = await import('node:child_process')
            const { promisify } = await import('node:util')
            const run = async (cmd: string, args: string[], opts: { timeoutMs: number }) => {
              try {
                const out = await (promisify(execFile))(cmd, args, { timeout: opts.timeoutMs, maxBuffer: 64 * 1024 })
                return { code: 0, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') }
              } catch (e: any) {
                return { code: typeof e?.code === 'number' ? e.code : 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? '') }
              }
            }
            const r = await stampSessionLaunch(run, candidateSessionId, cwd, stampGuard)
            logStep(r.ok ? 'STAMP_LAUNCH_OK' : 'STAMP_LAUNCH_SKIPPED', { sessionId: candidateSessionId, detail: r.detail })
          } catch (e: any) {
            logStep('STAMP_LAUNCH_FAILED', { sessionId: candidateSessionId, error: e?.message ?? String(e) })
          }
        })()
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

    const singletons = processSingletons()
    if (oneShot) {
      logStep('WAKE_LISTENER_SKIPPED', { reason: 'one_shot_run', sessionId })
    } else if (serverUrl) {
      let startError: unknown = null
      const { handle, shared } = processWakeListener(() => {
        logStep('WAKE_LISTENER_STARTING', { sessionId, agentInstanceId })
        return startWakeListener({
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
          // След пути побудки в прод-логе (жалоба 06.10): получение, дубль,
          // очередь, drain и исход вставки — с eventId, без тел и секретов.
          onWakeTrace: (step, details) => logStep(step, details),
          agentRegistration: {
            enabled: Boolean(agentRegistration?.enabled)
              || process.env.SYNQTASK_AGENT_REGISTRATION === '1'
              || process.env.SYNQTASK_REGISTER_AGENT === '1',
            name: agentRegistration?.name ?? process.env.SYNQTASK_AGENT_NAME,
            displayName: agentRegistration?.displayName ?? process.env.SYNQTASK_AGENT_DISPLAY_NAME,
            description: agentRegistration?.description ?? process.env.SYNQTASK_AGENT_DESCRIPTION,
            spaceId: agentRegistration?.spaceId ?? process.env.SYNQTASK_SPACE_ID,
          },
        }).catch((e) => { startError = e; throw e })
      })
      wakeHandle = await handle
      if (shared) {
        // Второй экземпляр opencode в том же процессе: дверь к агенту уже открыта.
        logStep('WAKE_LISTENER_SHARED', { port: wakeHandle?.port ?? null, directory: cwd, sessionId })
      } else if (wakeHandle) {
        logStep('WAKE_LISTENER_STARTED', {
          port: wakeHandle.port,
          sessionId,
          agentInstanceId,
          token: wakeHandle.token ? `${wakeHandle.token.slice(0, 8)}...` : 'absent',
        })
      } else {
        logStep('WAKE_LISTENER_FAILED_OPEN', { error: (startError as any)?.message ?? String(startError) })
      }
      if (wakeHandle) scheduleSessionBindRetries()
    } else {
      logStep('WAKE_LISTENER_SKIPPED', { reason: 'serverUrl_absent', sessionId })
    }

    // ─── Quota Watcher ─────────────────────────────────────────────
    // Independent of wake-listener (file-watcher, not HTTP). Starts even
    // when serverUrl is absent — quota-status.json is local and only needs
    // signalWire engine for routing. Will degrade gracefully (direct-
    // inject via injectContextEvent) if signalWire is null.
    if (oneShot) {
      logStep('QUOTA_WATCHER_SKIPPED', { reason: 'one_shot_run' })
    } else if (singletons.quota !== undefined) {
      quotaHandle = singletons.quota
      logStep('QUOTA_WATCHER_SHARED', { pid: process.pid })
    } else try {
      quotaHandle = startQuotaWatcher({
        signalWire: signalWireEngine,
        resolveSessionId: () => boundSessionId ?? (sessionId !== 'unknown' ? sessionId : null),
        log: (msg) => dbg(msg),
      })
      singletons.quota = quotaHandle
      logStep('QUOTA_WATCHER_STARTED', { pid: process.pid })
    } catch (e: any) {
      singletons.quota = null
      logStep('QUOTA_WATCHER_FAILED_OPEN', { error: e?.message ?? String(e) })
    }

    // Двери лимитов поставщиков — один опрос на старте, дальше не чаще раза в 10 минут.
    if (signalWire) {
      lastProviderQuotaRefreshMs = Date.now()
      void refreshProviderQuota(signalWire).catch(() => { /* залогировано внутри */ })
    }

    return {
      event: async ({ event }: { event: any }) => {
        const eventType = eventTypeOf(event)
        logStep('OPENCODE_EVENT', {
          eventType,
          keys: event && typeof event === 'object' ? Object.keys(event).slice(0, 10) : [],
        })
        const usage = usageFromMessageEvent(event)
        if (usage && signalWire && (!boundSessionId || usage.sessionId === boundSessionId)) {
          // Только своя сессия: помощники в том же процессе шлют свои ответы, и их заполнение — не наше.
          try {
            signalWire.trackModel(usage.modelId, usage.providerId)
            const window = await resolveModelWindow(usage.providerId, usage.modelId)
            if (window) signalWire.trackContextWindow(usage.modelId, window)
            signalWire.trackTokens({ inputTokens: usage.promptTokens })
          } catch (e: any) {
            logStep('CONTEXT_USAGE_TRACK_FAILED', { error: e?.message ?? String(e) })
          }
          // Расход сессии из базы opencode (session-spend.ts): индексированный SUM
          // ~2 мс на базе 3.8 ГБ, но чаще раза в минуту ему меняться не с чего.
          try {
            const now = Date.now()
            if (now - lastSpendRefreshMs >= 60_000) {
              lastSpendRefreshMs = now
              const { Database } = await import('bun:sqlite')
              const spend = readSessionSpend(
                (path: string) => new Database(path, { readonly: true }) as any,
                process.env.OPENCODE_DB_PATH ?? defaultOpencodeDbPath(),
                usage.sessionId,
              )
              signalWire.trackSpend(spend)
              if (spend) logStep('SPEND_REFRESH', { sessionId: usage.sessionId, cost: spend.cost, input: spend.inputTokens })
            }
          } catch (e: any) {
            logStep('SPEND_REFRESH_FAILED', { error: e?.message ?? String(e) })
          }
          // Лимиты поставщиков — не чаще раза в 10 минут (внешняя сеть).
          try {
            const now = Date.now()
            if (now - lastProviderQuotaRefreshMs >= 600_000) {
              lastProviderQuotaRefreshMs = now
              void refreshProviderQuota(signalWire).catch(() => { /* залогировано внутри */ })
            }
          } catch (e: any) {
            logStep('PROVIDER_QUOTA_REFRESH_FAILED', { error: e?.message ?? String(e) })
          }
        }
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
        // ─── session.idle → в правила (договор стыка, часть 2: signal-wire-core/docs/harness-adapter-contract.md) ───
        // До 2026-09-25 общий поток `event` в правила не отдавался вовсе, и четыре правила флота на конце
        // хода у агентов opencode не срабатывали: сохранение памяти (memory-session-autostore), сверка
        // реестра сессий (session-reconcile-on-event), зеркало памяти (memory-mirror-on-stop) и подсказка
        // session-stop-review. Побочные действия выполняет ядро; ПОДСКАЗКИ здесь НЕ вставляются, и это
        // сказано в журнале: у session-stop-review нет перезарядки, и тихая вставка на каждом конце хода
        // дописывала бы в разговор по сообщению на ход. Номера сессии нет — события нет (REQ-LOOP-14).
        if (eventType === 'session.idle' && signalWireEngine) {
          const idleSession = sessionFromEvent(event).id ?? boundSessionId ?? undefined
          if (idleSession) {
            try {
              const results = await signalWireEngine.evaluateHook({
                source: 'plugin',
                type: 'session.idle',
                sessionId: idleSession,
                timestamp: Date.now(),
                payload: {},
              })
              const hintsNotDelivered = results.filter((r: any) =>
                r?.success && r?.hintText && (r.type === 'hint' || r.type === 'respond' || (r.type === 'exec' && r.inject === true)),
              ).length
              logStep('SESSION_IDLE_EVALUATED', { sessionId: idleSession, results: results.length, hintsNotDelivered })
            } catch (e: any) {
              logStep('SESSION_IDLE_EVAL_FAILED', { sessionId: idleSession, error: e?.message ?? String(e) })
            }
          } else {
            logStep('SESSION_IDLE_SKIPPED', { reason: 'no_session_id' })
          }
        }
        // ─── session.compacted → серверу (договор адаптеров v2, часть 4) ───
        // Сжатие у opencode заменяет историю; перезарядку и кольцо петли этой сессии обнуляет ядро
        // само по событию. Своего счёта у адаптера нет — только передать.
        if (eventType === 'session.compacted' && signalWireEngine) {
          const compactedSession = sessionFromEvent(event).id ?? boundSessionId ?? undefined
          if (compactedSession) {
            try {
              await signalWireEngine.evaluateHook({ source: 'plugin', type: 'session.compacted', sessionId: compactedSession, timestamp: Date.now(), payload: {} })
              logStep('SESSION_COMPACTED_FORWARDED', { sessionId: compactedSession })
            } catch (e: any) {
              logStep('SESSION_COMPACTED_FORWARD_FAILED', { sessionId: compactedSession, error: e?.message ?? String(e) })
            }
          }
        }
        // ─── session.created → session.start (дыра доктрины 06.10) ───
        // У opencode нет события старта — только created. По договору старт — «процесс
        // поднялся, ещё до первого промпта», поэтому синтезируется из первого created.
        if (eventType === 'session.created' && signalWireEngine) {
          const startedSession = extractSessionId(event)
          if (startedSession && isFirstSessionStart(startedSession)) {
            try {
              await signalWireEngine.evaluateHook({ source: 'plugin', type: 'session.start', sessionId: startedSession, timestamp: Date.now(), payload: {} })
              logStep('SESSION_START_FORWARDED', { sessionId: startedSession })
            } catch (e: any) {
              logStep('SESSION_START_FORWARD_FAILED', { sessionId: startedSession, error: e?.message ?? String(e) })
            }
          }
        }
        // ─── PRP 08: человек и конец (ядро ≥0.27.0) ───
        // asked/answered/end — тем же узором, только своя сессия. Формы по
        // поправкам: tool нет, kind из памяти, reason опускается, disposed
        // без номера не синтезируется.
        if ((eventType === 'permission.updated' || eventType === 'permission.replied' || eventType === 'session.deleted') && signalWireEngine) {
          try {
            if (eventType === 'permission.updated') {
              const asked = askedFromPermissionUpdated(event)
              if (asked && (!boundSessionId || asked.sessionId === boundSessionId)) {
                permissionKinds.remember(asked.requestId, asked.kind)
                await signalWireEngine.evaluateHook({ source: 'plugin', type: 'human.asked', sessionId: asked.sessionId, timestamp: Date.now(), payload: { kind: asked.kind, message: asked.message, requestId: asked.requestId } })
                logStep('HUMAN_ASKED_FORWARDED', { sessionId: asked.sessionId, requestId: asked.requestId })
              }
            } else if (eventType === 'permission.replied') {
              const answered = answeredFromPermissionReplied(event, permissionKinds.recall)
              if (answered && (!boundSessionId || answered.sessionId === boundSessionId)) {
                await signalWireEngine.evaluateHook({ source: 'plugin', type: 'human.answered', sessionId: answered.sessionId, timestamp: Date.now(), payload: { kind: answered.kind, outcome: answered.outcome, requestId: answered.requestId } })
                logStep('HUMAN_ANSWERED_FORWARDED', { sessionId: answered.sessionId, requestId: answered.requestId, outcome: answered.outcome.slice(0, 40) })
              }
            } else {
              const ended = endFromSessionDeleted(event)
              if (ended && (!boundSessionId || ended.sessionId === boundSessionId)) {
                await signalWireEngine.evaluateHook({ source: 'plugin', type: 'session.end', sessionId: ended.sessionId, timestamp: Date.now(), payload: {} })
                logStep('SESSION_END_FORWARDED', { sessionId: ended.sessionId })
              }
            }
          } catch (e: any) {
            logStep('PRP08_FORWARD_FAILED', { eventType, error: e?.message ?? String(e) })
          }
        }
        // ─── session.error → дословно (дыра доктрины 06.10, ответ «да») ───
        // Канонического типа в ядре пока нет — имя сохраняется, правило совпадёт,
        // когда близнец появится. Только своя сессия, как у failure.
        if (eventType === 'session.error' && signalWireEngine) {
          const serr = errorFromSessionError(event)
          if (serr && (!boundSessionId || serr.sessionId === boundSessionId)) {
            try {
              await signalWireEngine.evaluateHook({
                source: 'plugin',
                type: 'session.error',
                sessionId: serr.sessionId,
                timestamp: Date.now(),
                payload: { error: serr.error },
              })
              logStep('SESSION_ERROR_FORWARDED', { sessionId: serr.sessionId })
            } catch (e: any) {
              logStep('SESSION_ERROR_FORWARD_FAILED', { sessionId: serr.sessionId, error: e?.message ?? String(e) })
            }
          }
        }
        // ─── tool-error part → tool.failure (дыра доктрины 06.10) ───
        // Провал вызова у opencode — не событие, а часть tool в state error прямо
        // в потоке. Только своя сессия (как у usage): чужие провалы — не наши.
        if (eventType === 'message.part.updated' && signalWireEngine) {
          const failure = failureFromPartUpdated(event)
          if (failure && (!boundSessionId || failure.sessionId === boundSessionId)) {
            try {
              await signalWireEngine.evaluateHook({
                source: 'plugin',
                type: 'tool.failure',
                sessionId: failure.sessionId,
                timestamp: Date.now(),
                payload: {
                  tool: failure.tool,
                  toolName: failure.tool,
                  callID: failure.callID,
                  args: failure.args,
                  response: { output: failure.error },
                },
              })
              logStep('TOOL_FAILURE_FORWARDED', { sessionId: failure.sessionId, tool: failure.tool })
            } catch (e: any) {
              logStep('TOOL_FAILURE_FORWARD_FAILED', { sessionId: failure.sessionId, tool: failure.tool, error: e?.message ?? String(e) })
            }
          }
        }
        if (eventType === 'app.exit' || eventType === 'server.stop') {
          // Двери общие для всех экземпляров процесса: закрывает их только последний уходящий.
          if (!releaseProcessWakeListener()) {
            logStep('WAKE_LISTENER_KEPT_FOR_SIBLING', { eventType, directory: cwd })
            return
          }
          resetProcessSingletons()
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

      // ─── Phase 4.5: System prompt + tool definition hooks ──────────────
      // Inject role-specific context (from OrgRole template OR ephemeral
      // brief for sub-sessions) into opencode's system prompt and tool
      // definitions sent to the LLM.

      'experimental.session.compacting': async (input: any, output: any) => {
        // Начало сжатия — десятое каноническое событие (сверка 07.10): единственный
        // момент, когда правило ещё может попросить записать знание, пока дословность
        // жива. Перехватчик есть в типах SDK; конец (compacted) уже едет из потока.
        // Хук НЕ меняет output — только отдаёт событие движку. Fail-open.
        if (signalWireEngine) {
          const sid = input?.sessionID ?? boundSessionId ?? undefined
          if (sid) {
            try {
              await signalWireEngine.evaluateHook({ source: 'plugin', type: 'session.compacting', sessionId: sid, timestamp: Date.now(), payload: {} })
              logStep('SESSION_COMPACTING_FORWARDED', { sessionId: sid })
            } catch (e: any) {
              logStep('SESSION_COMPACTING_FORWARD_FAILED', { sessionId: sid, error: e?.message ?? String(e) })
            }
          }
        }
      },

      'experimental.chat.system.transform': async (input: any, output: any) => {
        const { systemTransformHook } = await import('./system-prompt-hook')
        await systemTransformHook(input, output, {
          onStartupLine: (line) => logStep('STARTUP_CONTEXT', { sessionId: input?.sessionID ?? 'unknown', line }),
        })
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
          // Memory-recall thought side-channel (Phase 1.5) — MUST land BEFORE
          // evaluateHook: the memory-recall rule's detached searcher exec runs
          // during evaluation and reads this turn's thought from the file.
          try {
            writeThoughtFile(event.sessionId, String((event.payload as any)?.prompt ?? ''))
          } catch { /* fail-open — recall is an enhancement, never a blocker */ }
          // Track model from input.model — opencode supplies provider+modelID.
          // Updates runtimeMeta lastModel for subsequent runtimeMeta predicates
          // and template interpolation in this and following turns.
          const modelId = input?.model?.modelID
          if (typeof modelId === 'string' && modelId.length > 0) {
            try { (signalWireEngine as any).trackModel?.(modelId, input?.model?.providerID) } catch { /* tracking is best-effort */ }
          }
          // Заполнение контекста НЕ оценивается здесь по длине сообщения человека: до 0.3.24 так и было
          // (символы/4), и «контекстом» становился размер одной реплики. Настоящий замер приходит
          // событием message.updated (context-usage.ts), а для запросов через прокси — из его журнала.
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

          // Запрет по роли (OrgRole.metadata.tools_blocked). Это РЕШЕНИЕ адаптера (опись, D26) —
          // переезжает в правило набора отдельным шагом; запрет по брифу удалён как мёртвый.
          const memberId = process.env.SYNQTASK_MEMBER_ID
          if (memberId) {
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
