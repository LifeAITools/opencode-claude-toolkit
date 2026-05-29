/**
 * SignalWire adapter over @kiberos/signal-wire-core.
 *
 * Drop-in replacement for the internal SignalWire class in signal-wire.ts.
 * Same public API (provider.ts call sites unchanged), same constructor shape,
 * but internally delegates rule evaluation to the canonical Core engine.
 *
 * Translation helpers live in signal-wire-translate.ts (ADR-0007 LOC budget).
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import {
  Pipeline,
  MemoryBackend,
  EmitterRegistry,
  validateRuleSet,
  getBundledRulesPath,
  CORE_VERSION,
  CORE_SOURCE_HASH,
  coreIdentityTag,
  contextToEvent,
  translateLegacyRules,
  type Rule as CoreRule,
  type SignalWireEvent,
  type EmitResult,
  type SignalWireContext,
  type HookEvent,
} from '@kiberos/signal-wire-core'

import type { WakeEvent } from './wake-types'

/**
 * Model context window SSOT (mirrors @life-ai-tools/claude-code-sdk/src/models.ts).
 *
 * Inlined here (not imported) because @kiberos signal-wire adapter has no
 * runtime dep on claude-code-sdk — adding one would create a circular
 * dependency (claude-code-sdk → opencode-claude → opencode-signal-wire).
 *
 * KEEP IN SYNC with claude-code-sdk/src/models.ts when models change. Drift
 * here causes contextPercent miscalculation → premature session wrap-up
 * (bug 2026-05-13: every Claude model was assumed 200K → 1M-window models
 * computed 5× inflated contextPercent → agents winding up at ~15% real use).
 */
const MODEL_CONTEXT_WINDOW: Record<string, number> = {
  // Opus 4.x — 1M context (beta)
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-6': 1_000_000,
  // Sonnet 4.6 — 1M context
  'claude-sonnet-4-6': 1_000_000,
  // Haiku 4.5 — 200K context
  'claude-haiku-4-5-20251001': 200_000,
}

/** Resolve the context window for a model id. Returns undefined if unknown. */
function resolveContextWindow(modelId: string): number | undefined {
  if (MODEL_CONTEXT_WINDOW[modelId]) return MODEL_CONTEXT_WINDOW[modelId]
  const lower = modelId.toLowerCase()
  // Substring match — handles dated suffixes like "claude-opus-4-7-20251115"
  for (const [id, window] of Object.entries(MODEL_CONTEXT_WINDOW)) {
    if (lower.includes(id) || id.includes(lower)) return window
  }
  // Family-level fallback for models not in table — be optimistic about
  // window size (1M for Opus/Sonnet families) to avoid false-positive
  // premature-wrap-up. Only Haiku gets the smaller window.
  if (/haiku/i.test(modelId)) return 200_000
  if (/(opus-4|sonnet-4|opus-5|sonnet-5)/i.test(modelId)) return 1_000_000
  if (/(opus|sonnet)/i.test(modelId)) return 200_000 // older opus/sonnet (3.x)
  return undefined
}

// ─── Adapter identity SSOT ────────────────────────────────
// Bumped when this file's behavior changes, independent of Core version.
const ADAPTER_VERSION = '1.0.0' as const
const ADAPTER_MTIME: string = new Date().toISOString()
const ADAPTER_ID = `sw-adapter-opencode-claude v${ADAPTER_VERSION}@${ADAPTER_MTIME.slice(11, 19)}`

const LOG_FILE = join(homedir(), '.claude', 'signal-wire-debug.log')

function swLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${coreIdentityTag()} [${ADAPTER_ID}] ${msg}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
}

/** Emit adapter identity line ONCE per process on first construction. */
let adapterBannerEmitted = false
function emitAdapterBanner(rulesLoaded: number, rulesPath: string | undefined): void {
  if (adapterBannerEmitted) return
  adapterBannerEmitted = true
  // Include process-identification info so multiple opencode instances can be
  // distinguished in the shared log file:
  //   pid                  — OS process
  //   ppid                 — parent (helps spot Task-tool sub-agents)
  //   argv0                — what binary is running
  //   cwd                  — working dir (often differentiates instances)
  //   OPENCODE_*           — opencode-supplied env (instance id, session id)
  // Grep recipe: `grep ADAPTER_BANNER ~/.claude/signal-wire-debug.log`
  const env = process.env
  const sessionEnv = env.OPENCODE_SESSION_ID || env.OPENCODE_SESSION_SLUG || '?'
  const instanceEnv = env.OPENCODE_AGENT_INSTANCE_ID || '?'
  swLog(`ADAPTER_BANNER pid=${process.pid} ppid=${process.ppid ?? '?'} cwd=${process.cwd()} session_env=${sessionEnv} instance_env=${instanceEnv} core=${CORE_SOURCE_HASH} rules_loaded=${rulesLoaded} rules_path=${rulesPath ?? '(unset)'}`)
}

// ─── Hot-reload rules store ────────────────────────────────
//
// Architecturally: pull-based lazy check. Each public evaluate/emit call first
// calls maybeReload(); it's a cheap no-op when less than HOT_RELOAD_INTERVAL_MS
// has passed. Fingerprint = (mtimeMs, size) catches both normal edits and
// `git checkout` restoring same mtime with different content.
//
// Validate-before-swap: new rules parsed + validated into a separate array
// then atomically re-assigned. If validation fails, keep the old array and
// log. Bump fingerprint anyway so we don't retry a broken file every 2s.

const HOT_RELOAD_INTERVAL_MS = 2000

interface Fingerprint { mtimeMs: number; size: number }

class RulesStore {
  private rules: CoreRule[]
  private translatedLegacy: CoreRule[] = []
  private readonly path: string
  private readonly platform: string
  private readonly registry: EmitterRegistry
  private lastFingerprint: Fingerprint | null = null
  private lastCheckMs: number = 0
  private readonly onSwap: (newRules: CoreRule[]) => void
  /**
   * Set of disabled rule IDs that are CURRENTLY accepted by validateRuleSet
   * (i.e. _minCoreVersion either absent or ≤ this engine's version) and would
   * therefore become live the moment operator flips enabled=true.
   *
   * We log RULES_ELIGIBLE_FOR_ENABLE only when this set CHANGES (rule moves
   * from "rejected by gate" → "would-be-loaded if enabled"). Without the
   * transition check we'd spam the log on every 2s hot-reload tick.
   */
  private eligibleForEnable: Set<string> = new Set()

  constructor(opts: {
    path: string
    platform: string
    registry: EmitterRegistry
    onSwap: (newRules: CoreRule[]) => void
  }) {
    this.path = opts.path
    this.platform = opts.platform
    this.registry = opts.registry
    this.onSwap = opts.onSwap
    this.rules = this.loadFromDisk().rules
  }

  getRules(): CoreRule[] { return this.rules }
  getPath(): string { return this.path }

  private loadFromDisk(): { rules: CoreRule[]; fingerprint: Fingerprint | null } {
    if (!existsSync(this.path)) {
      return { rules: [], fingerprint: null }
    }
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(this.path) } catch { return { rules: [], fingerprint: null } }
    const fp: Fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const legacy = (raw.rules ?? []) as unknown[]
      const canonical = translateLegacyRules(legacy, this.platform)
      // CRITICAL (v1.2): pass _minCoreVersion through to validateRuleSet so
      // the engine version gate fires. Without this, an updated rules.json
      // requiring a newer core would silently load in older engines and
      // unknown predicates would be ignored → unconditional fires with
      // empty templates (the v0.2.0 bug we're fixing).
      const minCoreVersion = typeof raw._minCoreVersion === 'string' ? raw._minCoreVersion : undefined
      const result = validateRuleSet({ rules: canonical, _minCoreVersion: minCoreVersion }, this.registry)
      if (result.rejectedCount > 0) {
        // Surface rejection reasons in adapter log — operators tail this to
        // diagnose "why aren't my rules firing".
        const sampled = result.rejected.slice(0, 5).map(r => `${r.id ?? '?'}: ${r.reason}`).join('; ')
        swLog(`RULES_LOAD_REJECTED count=${result.rejectedCount}/${canonical.length} samples="${sampled}"`)
      }
      this.translatedLegacy = canonical
      this.lastFingerprint = fp
      // Seed initial eligibility snapshot so first hot-reload diff is correct
      // (otherwise everything-disabled would log as a transition on first
      // post-startup reload).
      this.detectEligibilityTransitions(legacy, raw._minCoreVersion)
      return { rules: result.rules, fingerprint: fp }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      swLog(`RULES_LOAD_FAIL path=${this.path} error="${msg}"`)
      this.lastFingerprint = fp
      return { rules: [], fingerprint: fp }
    }
  }

  /** Call before every evaluate. Cheap no-op when interval hasn't elapsed. */
  maybeReload(): { reloaded: boolean; error?: string } {
    const now = Date.now()
    if (now - this.lastCheckMs < HOT_RELOAD_INTERVAL_MS) return { reloaded: false }
    this.lastCheckMs = now

    if (!existsSync(this.path)) return { reloaded: false, error: 'rules file missing' }
    let stat: ReturnType<typeof statSync>
    try { stat = statSync(this.path) } catch (e) {
      return { reloaded: false, error: e instanceof Error ? e.message : String(e) }
    }
    const fp: Fingerprint = { mtimeMs: stat.mtimeMs, size: stat.size }
    if (this.lastFingerprint &&
        fp.mtimeMs === this.lastFingerprint.mtimeMs &&
        fp.size === this.lastFingerprint.size) {
      return { reloaded: false }
    }

    // Changed — try to load + validate
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      const legacy = (raw.rules ?? []) as unknown[]
      const canonical = translateLegacyRules(legacy, this.platform)
      const minCoreVersion = typeof raw._minCoreVersion === 'string' ? raw._minCoreVersion : undefined
      const result = validateRuleSet({ rules: canonical, _minCoreVersion: minCoreVersion }, this.registry)
      const oldCount = this.rules.length
      // ATOMIC SWAP — but only when validation actually returned rules.
      // If version gate or unknown predicates rejected EVERY rule, we do
      // NOT clear the existing in-memory ruleset (better to keep the
      // older effective set than fall back to empty/unsafe state).
      if (result.rules.length > 0 || result.rejectedCount === 0) {
        this.rules = result.rules
      }
      if (result.rejectedCount > 0) {
        const sampled = result.rejected.slice(0, 5).map(r => `${r.id ?? '?'}: ${r.reason}`).join('; ')
        swLog(`RULES_RELOAD_REJECTED count=${result.rejectedCount}/${canonical.length} samples="${sampled}" keeping-old-rules=${result.rules.length === 0 ? oldCount : 0}`)
      }
      this.translatedLegacy = canonical
      this.lastFingerprint = fp
      this.onSwap(this.rules)
      swLog(`RULES_RELOADED old=${oldCount} new=${this.rules.length} rejected=${result.rejectedCount} mtime=${new Date(fp.mtimeMs).toISOString()}`)

      // ─── Eligibility transition tracking (Step 2 of stabilization plan) ───
      // For each disabled rule in the source file: would it pass validation
      // if we set enabled=true RIGHT NOW on this engine? If yes and it wasn't
      // before, this is a state transition worth surfacing to the operator.
      // No auto-enable — just a single nudge line per transition.
      this.detectEligibilityTransitions(legacy, raw._minCoreVersion)

      return { reloaded: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.lastFingerprint = fp  // don't retry every 2s
      swLog(`RULES_RELOAD_FAIL error="${msg}" keeping-old-rules=${this.rules.length}`)
      return { reloaded: false, error: msg }
    }
  }

  /**
   * For each disabled rule in source: check whether THIS engine would now
   * accept it if enabled. Emit a single log line per transition (was-blocked
   * → now-eligible). Operators tail signal-wire-debug.log and see when their
   * fleet has rotated enough to safely flip enabled=true.
   *
   * Pure side effect via swLog. Does NOT mutate any rule state. Cheap:
   * only runs on actual rule-file changes (not every tick).
   *
   * Logic:
   *   1. From source rules, take only those with enabled === false
   *   2. For each, ask: would `validateRuleSet` accept it if it were enabled?
   *      (i.e. is _minCoreVersion ≤ CORE_VERSION on this engine?)
   *   3. Compare to last-seen eligibility set; log transitions only.
   */
  private detectEligibilityTransitions(rawRules: unknown[], fileMinCore: unknown): void {
    try {
      const newEligible = new Set<string>()
      // Build a "what would be accepted" probe by enabling every disabled rule
      // and feeding through validateRuleSet on a one-rule-at-a-time basis.
      // Single-rule probes isolate per-rule rejections from file-level gate
      // (which is global). For the file-level gate to be relevant, we still
      // pass it through to validateRuleSet (engine ANDs both gates).
      for (const r of rawRules) {
        if (!r || typeof r !== 'object') continue
        const rule = r as Record<string, unknown>
        if (typeof rule.id !== 'string') continue
        if (rule.enabled !== false) continue // only check currently-disabled rules

        const probe = { ...rule, enabled: true } as unknown as Record<string, unknown>
        const probeCanonical = translateLegacyRules([probe], this.platform)
        const probeResult = validateRuleSet(
          {
            rules: probeCanonical,
            _minCoreVersion: typeof fileMinCore === 'string' ? fileMinCore : undefined,
          },
          this.registry,
        )
        if (probeResult.rules.length > 0) {
          newEligible.add(rule.id)
        }
      }

      // Diff old vs new — log only transitions
      const becameEligible: string[] = []
      const becameIneligible: string[] = []
      for (const id of newEligible) {
        if (!this.eligibleForEnable.has(id)) becameEligible.push(id)
      }
      for (const id of this.eligibleForEnable) {
        if (!newEligible.has(id)) becameIneligible.push(id)
      }

      for (const id of becameEligible) {
        swLog(
          `RULES_ELIGIBLE_FOR_ENABLE rule=${id} reason=engine_now_satisfies_minCoreVersion ` +
          `hint="rule is currently enabled=false but its _minCoreVersion gate now passes; ` +
          `consider flipping enabled=true after running 'sw-fleet activation' to confirm fleet quorum"`,
        )
      }
      for (const id of becameIneligible) {
        swLog(
          `RULES_NO_LONGER_ELIGIBLE rule=${id} reason=engine_no_longer_satisfies_minCoreVersion ` +
          `hint="probably _minCoreVersion was bumped above this engine's version; rule cannot be enabled here"`,
        )
      }

      this.eligibleForEnable = newEligible
    } catch (e) {
      // Best-effort: never let eligibility tracking break rules reload.
      const msg = e instanceof Error ? e.message : String(e)
      swLog(`ELIGIBILITY_PROBE_FAIL error="${msg}"`)
    }
  }

  /**
   * Atomically persist an updated ruleset to the JSON file. Next hot-reload
   * picks it up within HOT_RELOAD_INTERVAL_MS. Uses tmp + rename for atomicity.
   */
  writeRulesFile(updatedRawRules: unknown[]): void {
    const tmp = `${this.path}.tmp.${process.pid}`
    const payload = JSON.stringify({ rules: updatedRawRules }, null, 2) + '\n'
    writeFileSync(tmp, payload, 'utf8')
    renameSync(tmp, this.path)
    swLog(`RULES_FILE_REWRITTEN rules=${updatedRawRules.length} path=${this.path}`)
  }

  getRawLegacyRules(): unknown[] {
    // Re-read from disk so we have the exact original shape (with 'action',
    // 'events', 'cooldown_minutes', etc.) rather than translated canonical.
    if (!existsSync(this.path)) return []
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      return (raw.rules ?? []) as unknown[]
    } catch {
      return []
    }
  }
}

// ─── Legacy-surface types (unchanged contract) ─────────────

export type { HookEvent, SignalWireContext } from '@kiberos/signal-wire-core'

export interface SignalWireResult {
  ruleId: string
  hint: string
  execCmd?: string
}

export interface SignalWireConfig {
  serverUrl: string
  sessionId: string
  rulesPath?: string
  platform?: string
  maxRulesPerFire?: number
}

// ─── Adapter ───────────────────────────────────────────────

export class SignalWire {
  private readonly pipeline: Pipeline
  private readonly registry: EmitterRegistry
  private sessionId: string
  private readonly platform: string
  private readonly maxRulesPerFire: number
  private readonly rulesStore: RulesStore
  private readonly disabledRuleIds = new Set<string>()
  private contextPosition = 0
  /** Cache of last async evaluate result — supports legacy sync `evaluate()`. */
  private lastAsyncResult: SignalWireResult | null = null

  // ─── runtimeMeta state (v1.2) ────────────────────────────
  // Track latest known runtime values to attach to outgoing events. These
  // are updated opportunistically as the adapter sees real activity:
  //   - trackTokens() updates contextPosition (already existed)
  //   - trackModel() updates last seen model id (called from provider.ts on API_REQ)
  //   - trackRateLimit() updates quota util (called from provider.ts on API_RESPONSE)
  // Adapter merges all into runtimeMeta inside getRuntimeMeta() at emit time.
  private lastModel: string | undefined
  private lastQuotaUtil5h: number | undefined
  private lastQuotaUtil7d: number | undefined
  private lastContextWindow: number | undefined

  // ─── Diagnostic logging state (added 2026-05-13) ─────────
  // Track last-logged context snapshot to rate-limit CTX_SNAPSHOT lines:
  // only log when something CHANGES (model, window, or contextPercent diff > 1%).
  // Without this, logs would flood — every chat.message event triggers an emit.
  // With it, you get one log line per real state transition + a periodic
  // heartbeat every 60s so silent processes still show up.
  private lastLoggedSnapshot: {
    model?: string
    window?: number
    contextTokens?: number
    contextPercent?: number
    tsMs?: number
  } = {}

  constructor(config: SignalWireConfig) {
    this.sessionId = config.sessionId
    this.platform = config.platform ?? 'opencode'
    this.maxRulesPerFire = config.maxRulesPerFire ?? 3
    this.registry = new EmitterRegistry()

    // Default rules path → canonical SSOT inside @kiberos/signal-wire-core.
    // Consumer (provider.ts) can still override via config.rulesPath for tests.
    const resolvedPath = config.rulesPath ?? getBundledRulesPath()

    this.rulesStore = new RulesStore({
      path: resolvedPath,
      platform: this.platform,
      registry: this.registry,
      onSwap: (newRules) => this.applyRulesToPipeline(newRules),
    })

    // Adapter identity banner (before Pipeline — so the line appears early)
    emitAdapterBanner(this.rulesStore.getRules().length, resolvedPath)

    this.pipeline = new Pipeline({
      rules: this.rulesStore.getRules(),
      registry: this.registry,
      stateBackend: new MemoryBackend(),
      sessionId: this.sessionId || 'opencode-claude',
      serverUrl: config.serverUrl,
    })
  }

  /** Static identity — exported for introspection/TUI. */
  static readonly identity = {
    adapterVersion: ADAPTER_VERSION,
    adapterId: ADAPTER_ID,
    coreVersion: CORE_VERSION,
    coreHash: CORE_SOURCE_HASH,
  }

  /**
   * Apply a ruleset to the underlying pipeline, respecting the current
   * disabled-rule override set. Called on initial load AND after every
   * hot-reload swap.
   */
  private applyRulesToPipeline(rules: CoreRule[]): void {
    const effective = rules.map(r => ({
      ...r,
      enabled: r.enabled !== false && !this.disabledRuleIds.has(r.id),
    }))
    this.pipeline._setRules(effective)
  }

  // ─── Legacy public API ─────────────────────────────────

  setSdkClient(_client: unknown): void { /* no-op in Core-adapter */ }

  /**
   * Update the bound sessionId after construction.
   *
   * Why this exists: at `server` boot, opencode often delivers
   * `input.sessionID === undefined`, which we floor to `'unknown'` in
   * plugin.ts. That stale value gets baked into the adapter and then
   * leaks into runtimeMeta.sessionId → into hint templates like
   * `<ctx session="{sessionId}" />`, producing `session="unknown"` even
   * after the real session has been bound.
   *
   * Call sites:
   *   - plugin.ts `bindSession()` once the real session id is discovered
   *     (from `session.created`, `findNewSessionByDirectory`, or any
   *     subsequent hook that surfaces `input.sessionID`).
   *   - plugin.ts `chat.message` hook on every fire — chat hooks ALWAYS
   *     carry the authoritative session id, so each turn refreshes any
   *     stale state.
   *
   * Idempotent: no-op when the candidate is empty / `'unknown'` /
   * unchanged. Logs the transition for audit.
   */
  setSessionId(candidate: string | null | undefined): void {
    if (!candidate) return
    if (candidate === 'unknown') return
    if (this.sessionId === candidate) return
    const prev = this.sessionId
    this.sessionId = candidate
    swLog(`SET_SESSION_ID pid=${process.pid} prev=${prev || '?'} new=${candidate}`)
  }

  trackTokens(u: { inputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }): void {
    const promptSize = (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0)
    const prev = this.contextPosition
    if (prev > 0 && promptSize > 0 && promptSize < prev * 0.6) {
      // Compaction detected — reset cooldowns
      this.pipeline.getCooldownTracker().resetTokens()
      void this.pipeline.getCooldownTracker().resetSession(this.sessionId || 'opencode-claude')
    }
    if (promptSize > 0) {
      this.contextPosition = promptSize
      this.pipeline.updateTokens(promptSize)
    }
  }

  getContextPosition(): number { return this.contextPosition }

  /**
   * Update last-seen model id. Called by provider.ts on API_REQ. Used in
   * runtimeMeta for both match predicates ({"match":{"model":"..."}}) and
   * template interpolation ({model} in hint text).
   *
   * Also captures the implicit context window for the model (200k for
   * Claude Opus/Sonnet, 128k for Haiku) — used to compute contextPercent.
   */
  trackModel(modelId: string): void {
    if (typeof modelId !== 'string' || modelId.length === 0) return
    const prevModel = this.lastModel
    const prevWindow = this.lastContextWindow
    this.lastModel = modelId
    // Use MODEL_CONTEXT_WINDOW (mirror of claude-code-sdk MAX_MODELS) for
    // accurate per-model window size. The old code hardcoded 200K for every
    // model — for 1M-window models (Opus 4.x, Sonnet 4.6) this meant
    // contextPercent was 5× inflated. At 142K real tokens, agents saw "71%
    // full" instead of "14% full", causing premature session wrap-up.
    // Bug fix 2026-05-13.
    const window = resolveContextWindow(modelId)
    if (window) this.lastContextWindow = window
    // else: leave previous value — don't overwrite with stale data

    // Log model→window resolution on EVERY model change so we can audit
    // mismatches between processes. One line per pid per unique model.
    if (prevModel !== modelId || prevWindow !== this.lastContextWindow) {
      swLog(`TRACK_MODEL pid=${process.pid} session=${this.sessionId || '?'} model=${modelId} window=${this.lastContextWindow ?? 'unknown'} resolved_from=${window ? 'table' : 'fallback'}`)
    }
  }

  /**
   * Update quota utilization. Called by provider.ts on API_RESPONSE when
   * rateLimit headers were observed. util5h/util7d in 0..1 range.
   */
  trackRateLimit(rl: { util5h?: number | null; util7d?: number | null }): void {
    if (typeof rl.util5h === 'number') this.lastQuotaUtil5h = rl.util5h
    if (typeof rl.util7d === 'number') this.lastQuotaUtil7d = rl.util7d
  }

  /**
   * Build the RuntimeMeta snapshot for the current moment. Adapter-side
   * single source of truth — engine never builds this directly.
   *
   * Returned object is a snapshot (cloned each call); safe to attach to
   * events without aliasing concerns.
   */
  private getRuntimeMeta(): Record<string, unknown> {
    // Treat the boot-time placeholder 'unknown' as missing — otherwise it
    // leaks into hint templates as `session="unknown"` and confuses
    // downstream consumers (operators, log analysis). Real sessions are
    // opencode UUIDs (`ses_…`) — never literal "unknown".
    const sid = this.sessionId && this.sessionId !== 'unknown' ? this.sessionId : undefined
    const meta: Record<string, unknown> = {
      pid: process.pid,
      sessionId: sid,
      contextTokens: this.contextPosition || undefined,
    }
    if (this.lastContextWindow != null) {
      meta.contextWindow = this.lastContextWindow
      if (this.contextPosition > 0) {
        meta.contextPercent = Math.min(100, Math.round((this.contextPosition / this.lastContextWindow) * 100))
        meta.contextRemaining = Math.max(0, this.lastContextWindow - this.contextPosition)
      }
    }
    if (this.lastModel) meta.model = this.lastModel
    if (this.lastQuotaUtil5h != null) meta.quotaUtil5h = this.lastQuotaUtil5h
    if (this.lastQuotaUtil7d != null) meta.quotaUtil7d = this.lastQuotaUtil7d

    // ─── Diagnostic CTX_SNAPSHOT (added 2026-05-13) ──────────
    // Log a snapshot when state CHANGED meaningfully OR every 60s heartbeat.
    // This file is THE audit trail: grep CTX_SNAPSHOT to see what each pid
    // believed about its own context size — catches future regressions where
    // a process computes the wrong contextPercent without you noticing.
    const now = Date.now()
    const prev = this.lastLoggedSnapshot
    const curTokens = (typeof meta.contextTokens === 'number' ? meta.contextTokens : undefined)
    const curPct = (typeof meta.contextPercent === 'number' ? meta.contextPercent : undefined)
    const pctChanged = (curPct ?? -1) !== (prev.contextPercent ?? -1) && Math.abs((curPct ?? 0) - (prev.contextPercent ?? 0)) >= 1
    const modelChanged = this.lastModel !== prev.model
    const windowChanged = this.lastContextWindow !== prev.window
    const heartbeatDue = !prev.tsMs || (now - prev.tsMs) >= 60_000
    if (pctChanged || modelChanged || windowChanged || heartbeatDue) {
      const reason = modelChanged ? 'model_change'
        : windowChanged ? 'window_change'
        : pctChanged ? 'pct_change'
        : 'heartbeat'
      swLog(`CTX_SNAPSHOT pid=${process.pid} session=${this.sessionId || '?'} model=${this.lastModel ?? '?'} tokens=${curTokens ?? 'null'} window=${this.lastContextWindow ?? 'null'} pct=${curPct ?? 'null'}% remaining=${typeof meta.contextRemaining === 'number' ? meta.contextRemaining : 'null'} util5h=${this.lastQuotaUtil5h ?? 'null'} util7d=${this.lastQuotaUtil7d ?? 'null'} reason=${reason}`)
      this.lastLoggedSnapshot = { model: this.lastModel, window: this.lastContextWindow, contextTokens: curTokens, contextPercent: curPct, tsMs: now }
    }
    return meta
  }

  /**
   * Public read-only accessor for adapter consumers (provider.ts logging,
   * tests). Returns the same snapshot used internally for event attachment.
   */
  getCurrentRuntimeMeta(): Record<string, unknown> {
    return this.getRuntimeMeta()
  }

  /**
   * Refresh runtime token / quota state from the canonical source of truth:
   * `~/.claude/claude-max-stats.jsonl`. Each line is a per-API-response record
   * written by opencode-claude provider with REAL usage numbers (cacheRead +
   * cacheCreate + input + rateLimit util). Tailing the file gives us accurate
   * data without coupling to opencode-claude internals — file is the natural
   * integration boundary between the two plugins.
   *
   * Strategy: read last ~256KB of file, scan lines from end, find LAST line
   * matching this pid. Parse usage; update contextPosition, model, quota.
   *
   * Cheap (small tail read) and idempotent — caller can invoke as often as
   * desired. Best-effort: any IO/parse error leaves state unchanged.
   *
   * Why tail-read not full read: file grows unbounded (we observed 40MB).
   * Last 256KB at typical 200-byte lines = ~1300 most recent records, more
   * than enough for the latest line per pid.
   *
   * Returns true iff state was updated, false if no matching record found.
   */
  refreshTokensFromStatsFile(): boolean {
    const STATS_FILE = join(homedir(), '.claude', 'claude-max-stats.jsonl')
    const TAIL_BYTES = 256 * 1024
    try {
      const fs = require('fs') as typeof import('fs')
      if (!fs.existsSync(STATS_FILE)) return false
      const stat = fs.statSync(STATS_FILE)
      const start = Math.max(0, stat.size - TAIL_BYTES)
      const fd = fs.openSync(STATS_FILE, 'r')
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      const tail = buf.toString('utf-8')
      const lines = tail.split('\n')

      // Walk from the END to find the LATEST line for this pid.
      const myPid = process.pid
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]?.trim()
        if (!line || !line.startsWith('{')) continue
        // Cheap pre-filter — skip lines that don't mention this pid at all.
        if (!line.includes(`"pid":${myPid}`)) continue
        try {
          const rec = JSON.parse(line) as {
            pid?: number
            type?: string
            model?: string
            usage?: { in?: number; out?: number; cacheRead?: number; cacheWrite?: number }
            rateLimit?: { util5h?: number; util7d?: number }
          }
          if (rec.pid !== myPid) continue
          // Only stream records carry full prompt-cache numbers; keepalive
          // records are a tiny refresh and would understate contextPosition.
          if (rec.type !== 'stream') continue
          const u = rec.usage ?? {}
          const totalIn = (u.in ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)
          if (totalIn > 0) {
            this.trackTokens({
              inputTokens: u.in ?? 0,
              cacheReadInputTokens: u.cacheRead ?? 0,
              cacheCreationInputTokens: u.cacheWrite ?? 0,
            })
          }
          if (rec.model) this.trackModel(rec.model)
          if (rec.rateLimit) {
            this.trackRateLimit({
              util5h: typeof rec.rateLimit.util5h === 'number' ? rec.rateLimit.util5h : null,
              util7d: typeof rec.rateLimit.util7d === 'number' ? rec.rateLimit.util7d : null,
            })
          }
          // Log STATS_REFRESH only when the consumed record changes (by line
          // identity heuristic = totalIn + model). Most refresh() calls see
          // the same most-recent record and shouldn't spam logs.
          const lineKey = `${rec.model ?? '?'}:${totalIn}`
          if (lineKey !== this.lastStatsRefreshKey) {
            swLog(`STATS_REFRESH pid=${process.pid} session=${this.sessionId || '?'} matched_pid=${rec.pid} rec_type=${rec.type} rec_model=${rec.model ?? '?'} in=${u.in ?? 0} cacheRead=${u.cacheRead ?? 0} cacheWrite=${u.cacheWrite ?? 0} totalIn=${totalIn} util5h=${rec.rateLimit?.util5h ?? 'null'} util7d=${rec.rateLimit?.util7d ?? 'null'}`)
            this.lastStatsRefreshKey = lineKey
          }
          return true
        } catch {
          // Malformed line — keep walking.
          continue
        }
      }
      return false
    } catch (e) {
      // Log read failures so silent-no-context-data isn't invisible.
      const msg = e instanceof Error ? e.message : String(e)
      if (msg !== this.lastStatsRefreshError) {
        swLog(`STATS_REFRESH_FAIL pid=${process.pid} session=${this.sessionId || '?'} error="${msg}"`)
        this.lastStatsRefreshError = msg
      }
      return false
    }
  }
  private lastStatsRefreshKey: string | undefined
  private lastStatsRefreshError: string | undefined

  /**
   * Toggle a rule on/off. Persists to the rules JSON file (atomic rewrite),
   * and the next hot-reload (within HOT_RELOAD_INTERVAL_MS) will pick it up.
   *
   * For immediate effect inside the current process we also update the
   * in-memory disabled set and re-apply rules to the pipeline.
   */
  toggleRule(ruleId: string, enabled: boolean): boolean {
    this.rulesStore.maybeReload()
    const rules = this.rulesStore.getRules()
    if (!rules.some(r => r.id === ruleId)) return false

    if (enabled) this.disabledRuleIds.delete(ruleId)
    else this.disabledRuleIds.add(ruleId)

    // Immediate in-process apply
    this.applyRulesToPipeline(rules)

    // Persist to SSOT so other consumers (and next restart) see the change.
    // We patch the raw legacy JSON, preserving its original structure.
    try {
      const rawRules = this.rulesStore.getRawLegacyRules()
      const patched = rawRules.map((r: unknown) => {
        if (typeof r !== 'object' || r === null) return r
        const rec = r as Record<string, unknown>
        if (rec.id === ruleId) return { ...rec, enabled }
        return rec
      })
      this.rulesStore.writeRulesFile(patched)
    } catch (e) {
      swLog(`TOGGLE_PERSIST_FAIL rule=${ruleId} enabled=${enabled} error="${e instanceof Error ? e.message : String(e)}"`)
    }

    return true
  }

  listRules(): Array<{ id: string; description: string; enabled: boolean; events: string[] }> {
    this.rulesStore.maybeReload()
    return this.rulesStore.getRules().map(r => ({
      id: r.id,
      description: '',
      enabled: r.enabled !== false && !this.disabledRuleIds.has(r.id),
      events: r.events,
    }))
  }

  isRuleEnabled(ruleId: string): boolean {
    this.rulesStore.maybeReload()
    return !this.disabledRuleIds.has(ruleId)
  }

  /**
   * Legacy sync evaluate. Kicks off async pipeline, returns last cached value.
   * Current invocation's result is cached for the NEXT call (tick-delayed).
   * Production call pattern in provider.ts is idempotent under this model.
   *
   * NEW callers should use evaluateAsync() for immediate results.
   */
  /**
   * Structured consumer-invoke log — one line per evaluate entry.
   * Complements the engine-side EVENT_RECEIVED/RULE_FIRED/EVENT_COMPLETE
   * lines so operators can trace: plugin-invoke → engine-receive →
   * rule-fire → engine-complete → (hook-complete if consumer-2).
   */
  private logInvoke(mode: string, event: SignalWireEvent): void {
    swLog(`CONSUMER_INVOKE consumer=opencode-plugin mode=${mode} type=${event.type} session=${this.sessionId || '?'}`)
  }

  /**
   * Mutate event in place to attach the current runtimeMeta snapshot.
   * Centralized so every emit path (sync/async/hook/external) gets the
   * same enrichment without duplicating logic at call sites.
   *
   * Refreshes tokens from claude-max-stats.jsonl tail FIRST, so the
   * snapshot reflects the latest API response for this pid. Without
   * this refresh, runtimeMeta would only get coarse chat.message-text
   * estimates (chars/4 fallback in plugin.ts), making contextPercent
   * predicates unreliable for warning/critical thresholds.
   *
   * Refresh is cheap (~256KB tail read + line scan) and gracefully
   * degrades to no-op when stats file unavailable.
   */
  private attachRuntimeMeta(event: SignalWireEvent): void {
    this.refreshTokensFromStatsFile()
    event.runtimeMeta = this.getRuntimeMeta() as SignalWireEvent['runtimeMeta']
  }

  evaluate(ctx: SignalWireContext): SignalWireResult | null {
    this.rulesStore.maybeReload()
    const event = contextToEvent(ctx, this.sessionId)
    this.attachRuntimeMeta(event)
    this.logInvoke('evaluate-sync', event)
    this.pipeline.process(event)
      .then(rs => { this.lastAsyncResult = this.toLegacy(rs) })
      .catch(() => { /* CN-09 */ })
    return this.lastAsyncResult
  }

  /** Preferred async API. */
  async evaluateAsync(ctx: SignalWireContext): Promise<SignalWireResult | null> {
    this.rulesStore.maybeReload()
    const event = contextToEvent(ctx, this.sessionId)
    this.attachRuntimeMeta(event)
    this.logInvoke('evaluate-async', event)
    const results = await this.pipeline.process(event)
    const legacy = this.toLegacy(results)
    this.lastAsyncResult = legacy
    return legacy
  }

  /**
   * Hook-event evaluation for in-process opencode plugin hooks
   * (chat.message, tool.execute.before/after, …).
   *
   * Returns raw EmitResult[] so the caller can apply hint/block/exec
   * results with full fidelity (multiple hints, block reasons, etc.).
   * Unlike `evaluate()`/`evaluateAsync()` which collapse to a single
   * legacy SignalWireResult, this preserves the full pipeline output.
   *
   * The caller is responsible for constructing `SignalWireEvent`
   * (typically via the `normalize*` helpers in `hook-listener.ts`).
   */
  async evaluateHook(event: SignalWireEvent): Promise<EmitResult[]> {
    this.rulesStore.maybeReload()
    this.attachRuntimeMeta(event)
    this.logInvoke('evaluate-hook', event)
    const results = await this.pipeline.process(event)
    // Cache so legacy sync evaluate() (if anyone still calls it) sees something
    this.lastAsyncResult = this.toLegacy(results)
    return results
  }

  /** External wake-event evaluation (wake-listener.ts consumer). */
  async evaluateExternal(wakeEvent: WakeEvent): Promise<{ matched: CoreRule[]; results: EmitResult[] }> {
    this.rulesStore.maybeReload()

    // Opportunistic quota tracking — wake events from quota-watcher carry
    // util5h/util7d in payload. Capture them so subsequent chat.message
    // events have fresh quota data in runtimeMeta for match predicates and
    // template interpolation. Cheap, idempotent.
    const wp = wakeEvent.payload as Record<string, unknown> | undefined
    if (wp && (typeof wp.util5h === 'number' || typeof wp.util7d === 'number')) {
      this.trackRateLimit({
        util5h: typeof wp.util5h === 'number' ? wp.util5h : null,
        util7d: typeof wp.util7d === 'number' ? wp.util7d : null,
      })
    }

    const event: SignalWireEvent = {
      source: 'wake',
      type: `wake.${wakeEvent.type}`,
      sessionId: this.sessionId || null,
      payload: {
        wakeEventId: wakeEvent.eventId,
        wakeSource: wakeEvent.source,
        wakeType: wakeEvent.type,
        priority: wakeEvent.priority,
        targetMemberId: wakeEvent.targetMemberId,
        ...(wakeEvent.payload as Record<string, unknown>),
      },
      timestamp: Date.now(),
    }
    this.attachRuntimeMeta(event)
    this.logInvoke('evaluate-external', event)
    const results = await this.pipeline.process(event)
    const firedIds = new Set(results.map(r => r.ruleId))
    const currentRules = this.rulesStore.getRules()
    return { matched: currentRules.filter(r => firedIds.has(r.id)), results }
  }

  // ─── Internal ──────────────────────────────────────────

  private toLegacy(results: EmitResult[]): SignalWireResult | null {
    const hintBearing = results.filter(r =>
      (r.type === 'hint' || r.type === 'respond') && r.success && r.hintText,
    )
    if (hintBearing.length === 0) return null
    const picked = hintBearing.slice(0, this.maxRulesPerFire)
    return {
      ruleId: picked[0].ruleId,
      hint: picked.map(h => h.hintText as string).join('\n\n'),
    }
  }
}
