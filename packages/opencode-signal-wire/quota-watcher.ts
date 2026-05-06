/**
 * Quota Watcher (per-pid, signal-wire side).
 *
 * Watches `~/.claude-local/quota-status.json` (written exclusively by the
 * claude-max-proxy quota-watcher process). When this pid's account
 * transitions to warning/critical, emit a synthetic WakeEvent that flows
 * through the canonical signal-wire dispatch path:
 *
 *     fs.watch(quota-status.json)
 *           ↓
 *     transition detected (issuedAt change for this pid's account)
 *           ↓
 *     synthesize WakeEvent { source:"proxy", type:"quota_critical|warning",
 *                            payload:{accountHint, util5h, util7d, resetAt,
 *                                     level, message, issuedAt} }
 *           ↓
 *     signalWire.evaluateExternal(event)
 *           ↓ rule matched (cooldown enforced by engine)
 *           ↓ wake-action triggers formatWakeMessage(event) [QUOTA_CRITICAL/WARNING case]
 *           ↓ injectContextEvent (noReply:true, single canonical sink)
 *           ↓
 *     agent sees `<system-reminder type="wake" source="proxy">…<rules>…</rules></system-reminder>`
 *
 * ─── Why this lives here, not in opencode-claude ─────────────────────
 *
 * Architectural decision (signal-wire-architecture-v3 closure 2026-04-30):
 * `opencode-signal-wire` is the **dispatcher for all context-injection
 * signals** in opencode (not just synqtask wake events). Quota-critical
 * is a context signal — same class of object as a wake event, just with
 * a different source (proxy file vs HTTP push). Putting it here:
 *
 *   • One audit log (signal-wire-audit.jsonl) for all context events
 *   • One cooldown system (engine's stateBackend, no per-pid Maps)
 *   • One inject path (injectContextEvent) → cannot drift in wrap format
 *   • One dispatcher to test, monitor, debug
 *   • Zero parallel `session.prompt` calls outside this package
 *
 * `opencode-claude` becomes purely Claude/OAuth/provider concern. The
 * quota SOURCE (proxy) and the quota CONSUMER (this file) communicate
 * only through `~/.claude-local/quota-status.json` — same pattern as
 * before, only the consumer moved.
 *
 * ─── Per-pid dedup via engine ────────────────────────────────────────
 *
 * Engine cooldowns (rule.cooldown_seconds=300 for critical, 600 for
 * warning) replace the in-memory `lastInjected` Map this consumer used
 * to maintain. Single source of truth = engine. The proxy's `issuedAt`
 * field still serves as the change-detection trigger here; we only
 * synthesize an event when issuedAt CHANGES (otherwise nothing new
 * happened — same critical state, no event needed).
 *
 * ─── Failure modes ───────────────────────────────────────────────────
 *
 * - quota-status.json missing → no-op (proxy not running yet)
 * - File malformed → log, retry on next event
 * - signalWire null (not configured) → log warning; quota signals dropped
 * - injectContextEvent returns false (session not bound) → set pending
 *   flag, retry every 5s until resolved
 */

import { existsSync, readFileSync, watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { WakeEvent } from './wake-types'
import { WAKE_EVENT_TYPES } from './wake-types'
import { injectContextEvent } from './wake-listener'

const QUOTA_STATUS_JSON = join(homedir(), '.claude-local', 'quota-status.json')
const DEBOUNCE_MS = 200          // coalesce rapid file changes
const RETRY_NO_SESSION_MS = 5000 // re-attempt if session not bound yet

interface AccountState {
  accountHint: string
  util5h: number | null
  util7d: number | null
  resetAt: number | null
  level: 'ok' | 'warning' | 'critical'
  message: string
  issuedAt: string
  pids: number[]
}

interface PidState {
  pid: number
  accountHint: string
  level: 'ok' | 'warning' | 'critical'
}

interface QuotaStatusFile {
  version: number
  updatedAt: string
  accounts: Record<string, AccountState>
  pids: Record<string, PidState>
}

export interface QuotaWatcherHandle {
  stop: () => void
  forceCheck: () => Promise<void>
  /**
   * Inject current quota snapshot as quota_status event, regardless of
   * level/transition. Used by on-demand rule when user explicitly asks
   * about quota. Returns true if injection succeeded.
   */
  injectCurrentSnapshot: () => Promise<boolean>
}

export interface QuotaWatcherOptions {
  /**
   * SignalWire instance. Quota events are routed through
   * `signalWire.evaluateExternal()` so engine handles cooldown + audit.
   * If null, watcher logs a warning and skips injection (degraded mode).
   */
  signalWire: { evaluateExternal: (event: WakeEvent) => Promise<any> } | null
  /**
   * Returns the currently-bound session ID, or null if not yet bound.
   * Pulled fresh on each invocation (sessions can rebind).
   */
  resolveSessionId: () => string | null
  /** Debug logger (writes to opencode-signal-wire-debug.log). */
  log: (msg: string) => void
}

export function startQuotaWatcher(opts: QuotaWatcherOptions): QuotaWatcherHandle {
  const { signalWire, resolveSessionId, log } = opts
  const myPid = process.pid

  // Track last-seen `issuedAt` per account so we only synthesize an event
  // when the proxy ACTUALLY transitioned state (not on every refresh of
  // the status file). The proxy bumps issuedAt only on level changes.
  const lastIssuedAt = new Map<string, string>()

  // Track last-known LEVEL per account to detect trailing-edge transitions
  // (critical→warning, critical→ok, warning→ok). Without this, recovery is
  // silent and agents keep stale snapshots from prior rising-edge warnings.
  // Possible values: 'ok' | 'warning' | 'critical' | undefined (first sight).
  const lastLevel = new Map<string, 'ok' | 'warning' | 'critical'>()

  // Pending account hint for retry when session wasn't bound at first try.
  // The 5s retry timer below probes this.
  let pendingForAccount: string | null = null

  let watcher: FSWatcher | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let retryTimer: ReturnType<typeof setInterval> | null = null

  function readStatus(): QuotaStatusFile | null {
    try {
      if (!existsSync(QUOTA_STATUS_JSON)) return null
      const raw = readFileSync(QUOTA_STATUS_JSON, 'utf8')
      return JSON.parse(raw) as QuotaStatusFile
    } catch (e: any) {
      log(`quota-watcher: read failed: ${e?.message ?? e}`)
      return null
    }
  }

  function findMyAccount(status: QuotaStatusFile): AccountState | null {
    // Primary lookup: account.pids contains our pid
    for (const acc of Object.values(status.accounts)) {
      if (acc.pids.includes(myPid)) return acc
    }
    // Secondary: pids map (more direct but only set after first request)
    const myPidState = status.pids[String(myPid)]
    if (myPidState) {
      return status.accounts[myPidState.accountHint] ?? null
    }
    return null
  }

  function synthesizeWakeEvent(
    account: AccountState,
    type: 'quota_critical' | 'quota_warning' | 'quota_recovered' | 'quota_status',
    extras: { previousLevel?: 'ok' | 'warning' | 'critical' } = {},
  ): WakeEvent {
    return {
      eventId: `quota-${type}-${randomUUID()}`,
      source: 'proxy',
      type,
      priority: type === 'quota_critical' ? 'urgent' : 'info',
      // Quota events are not addressed to a specific synqtask member — we
      // route by sessionId in injectContextEvent. Empty string is the
      // canonical "no target" placeholder.
      targetMemberId: '',
      payload: {
        accountHint: account.accountHint,
        util5h: account.util5h,
        util7d: account.util7d,
        resetAt: account.resetAt,
        level: account.level,
        message: account.message,
        issuedAt: account.issuedAt,
        pids: account.pids,
        // Trailing-edge events include previousLevel so formatter can render
        // "back from critical to ok" or "back from warning to ok" etc.
        ...(extras.previousLevel !== undefined ? { previousLevel: extras.previousLevel } : {}),
      },
      timestamp: new Date().toISOString(),
      // Fingerprint = accountHint+issuedAt+type — engine can use this for
      // deeper dedup if needed (cooldown_seconds is the primary throttle).
      // Including type prevents a recovered event from sharing fingerprint
      // with a prior warning event (different events, both of value).
      fingerprint: `${account.accountHint}:${account.issuedAt}:${type}`,
      schemaVersion: 1,
    }
  }

  async function dispatchQuotaEvent(
    account: AccountState,
    previousLevel?: 'ok' | 'warning' | 'critical',
  ): Promise<boolean> {
    // Decide event type based on transition direction:
    //   ok|undefined  → warning   = quota_warning  (rising edge)
    //   ok|warning    → critical  = quota_critical (rising edge)
    //   critical      → warning   = quota_recovered (trailing edge)
    //   critical|warning → ok     = quota_recovered (trailing edge)
    //   warning       → warning   (issuedAt changed) = quota_warning (proxy refresh)
    //   critical      → critical  (issuedAt changed) = quota_critical (proxy refresh)
    let type: 'quota_critical' | 'quota_warning' | 'quota_recovered'
    if (account.level === 'critical') {
      type = 'quota_critical'
    } else if (account.level === 'warning') {
      // Rising edge or refresh: ok|undefined|warning → warning = quota_warning
      // Trailing partial: critical → warning = quota_recovered
      type = previousLevel === 'critical' ? 'quota_recovered' : 'quota_warning'
    } else {
      // account.level === 'ok' — only emit if previously was warning|critical
      if (previousLevel === undefined || previousLevel === 'ok') {
        return true  // healthy → healthy, nothing to say
      }
      type = 'quota_recovered'
    }

    const event = synthesizeWakeEvent(account, type, { previousLevel })

    // Two-step canonical path:
    //
    //   1. Engine evaluation: cooldown check + audit log + rule match.
    //      If cooldown denies the rule, engine returns matched=false and
    //      we drop the inject (intentional — the rule throttled us).
    //
    //   2. Inject via canonical sink (injectContextEvent): formatWakeMessage
    //      formats payload → session.prompt(noReply:true). Same path
    //      handleWake uses for HTTP-arrived advisory events. Single
    //      formatter, single sink, single wrap convention.
    //
    // The engine's wake-emitter doesn't inject for us — wake-emitter is
    // for cross-pid wake routing (wake-router service uses it). For
    // in-process advisory injection, we explicitly call injectContextEvent
    // after engine evaluation succeeds. This keeps the dependency direction
    // clean: quota-watcher orchestrates {engine → injector}, neither of
    // which knows about quota specifics.
    let engineMatched = false
    if (signalWire) {
      try {
        const result = await signalWire.evaluateExternal(event)
        engineMatched = Boolean((result as any)?.matched)
        if (!engineMatched) {
          // Could be cooldown OR rule mis-configured. The engine itself
          // logged the reason in signal-wire-debug.log. Skip injection —
          // engine is the source of truth for "should we fire now?".
          log(`quota-watcher: engine declined ${type} for account=${account.accountHint} issuedAt=${account.issuedAt} (cooldown or no-match)`)
          // Return true to mark as "handled" — we won't retry on next
          // file-watch tick. The proxy will bump issuedAt only on next
          // real transition, naturally re-eligible after cooldown.
          return true
        }
      } catch (e: any) {
        log(`quota-watcher: engine error (${e?.message ?? e}), falling back to bypass-engine inject`)
        // Fall through to direct inject below.
      }
    } else {
      log(`quota-watcher: signalWire absent, using bypass-engine inject (degraded mode)`)
    }

    // Inject via canonical sink. Same call regardless of whether engine
    // matched (engine handles cooldown for us; if we got here, we should
    // inject) or signalWire is absent (graceful degradation).
    const sessionId = resolveSessionId()
    if (!sessionId) {
      log(`quota-watcher: session not bound, deferring ${type} for account=${account.accountHint}`)
      pendingForAccount = account.accountHint
      return false
    }
    const ok = await injectContextEvent(event, sessionId)
    if (ok) {
      log(`quota-watcher: injected ${type} for account=${account.accountHint} (engineMatched=${engineMatched})`)
    } else {
      log(`quota-watcher: inject failed for ${type} account=${account.accountHint} (engineMatched=${engineMatched})`)
    }
    return ok
  }

  async function check(): Promise<void> {
    const status = readStatus()
    if (!status) return

    const myAccount = findMyAccount(status)
    if (!myAccount) return  // proxy hasn't seen us yet — normal during startup

    const previousLevel = lastLevel.get(myAccount.accountHint)
    const lastSeen = lastIssuedAt.get(myAccount.accountHint)

    // Trailing-edge case: account was warning|critical, now ok.
    // Proxy may NOT bump issuedAt on level decrease (depends on proxy impl)
    // — so we use level transition (not issuedAt) as the trigger here.
    if (myAccount.level === 'ok') {
      if (previousLevel === 'warning' || previousLevel === 'critical') {
        // Recovery! Emit quota_recovered.
        const ok = await dispatchQuotaEvent(myAccount, previousLevel)
        if (ok) {
          lastLevel.set(myAccount.accountHint, 'ok')
          // Track issuedAt to avoid re-firing if proxy did bump it.
          lastIssuedAt.set(myAccount.accountHint, myAccount.issuedAt)
          pendingForAccount = null
          log(`quota-watcher: recovered ${previousLevel}→ok for account=${myAccount.accountHint}`)
        }
        return
      }
      // ok→ok (steady state). Update tracker, no event.
      lastLevel.set(myAccount.accountHint, 'ok')
      pendingForAccount = null
      return
    }

    // Account is warning or critical.
    // Skip if same issuedAt AND same level (no transition).
    if (lastSeen === myAccount.issuedAt && previousLevel === myAccount.level) {
      return
    }

    // Either issuedAt changed (proxy refreshed) OR level changed (transition).
    // Both warrant an event — could be rising edge (e.g. warning→critical)
    // or trailing edge with level still elevated (critical→warning = partial
    // recovery, treated as quota_recovered with level=warning).
    const ok = await dispatchQuotaEvent(myAccount, previousLevel)
    if (ok) {
      lastIssuedAt.set(myAccount.accountHint, myAccount.issuedAt)
      lastLevel.set(myAccount.accountHint, myAccount.level)
      pendingForAccount = null
    }
  }

  // ─── On-demand snapshot ────────────────────────────────────────────
  // Public method: read current quota state and inject as quota_status event.
  // Used by signal-wire rule when user types "quota?" / "квота?" etc.
  // Bypasses level-tracking entirely — always reads fresh from quota-status.json.
  async function injectCurrentSnapshot(): Promise<boolean> {
    const status = readStatus()
    if (!status) {
      log(`quota-watcher: on-demand snapshot — no quota-status.json (proxy not running?)`)
      return false
    }
    const myAccount = findMyAccount(status)
    if (!myAccount) {
      log(`quota-watcher: on-demand snapshot — pid ${myPid} not registered with proxy yet`)
      return false
    }
    const event = synthesizeWakeEvent(myAccount, 'quota_status')
    const sessionId = resolveSessionId()
    if (!sessionId) {
      log(`quota-watcher: on-demand snapshot — session not bound`)
      return false
    }
    // Run engine to record audit, but force-inject regardless of cooldown
    // (user explicitly asked, throttling here would hide info from them).
    if (signalWire) {
      try { await signalWire.evaluateExternal(event) } catch (e: any) {
        log(`quota-watcher: on-demand engine error: ${e?.message ?? e}`)
      }
    }
    const ok = await injectContextEvent(event, sessionId)
    log(`quota-watcher: on-demand snapshot ${ok ? 'injected' : 'failed'} for account=${myAccount.accountHint} level=${myAccount.level}`)
    return ok
  }

  function scheduleCheck(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => { void check() }, DEBOUNCE_MS)
  }

  // fs.watch on the directory (watching the file directly is unreliable
  // across atomic rename — proxy writes via tmp+rename).
  try {
    watcher = watch(join(homedir(), '.claude-local'), { persistent: false }, (_evt, filename) => {
      if (filename === 'quota-status.json' || filename === 'quota-status.json.tmp') {
        scheduleCheck()
      }
    })
    watcher?.unref?.()
    log(`quota-watcher: started (pid=${myPid}, watching ${QUOTA_STATUS_JSON})`)
  } catch (e: any) {
    log(`quota-watcher: fs.watch failed: ${e?.message ?? e}`)
  }

  // Immediate first check (catch state at boot)
  void check()

  // Periodic retry — handles "session not bound at first attempt" case.
  // Also a safety net if fs.watch missed an event (rare on Linux).
  retryTimer = setInterval(() => {
    if (pendingForAccount) void check()
  }, RETRY_NO_SESSION_MS)
  ;(retryTimer as any)?.unref?.()

  return {
    stop: () => {
      if (watcher) watcher.close()
      if (debounceTimer) clearTimeout(debounceTimer)
      if (retryTimer) clearInterval(retryTimer)
    },
    forceCheck: check,
    injectCurrentSnapshot,
  }
}
