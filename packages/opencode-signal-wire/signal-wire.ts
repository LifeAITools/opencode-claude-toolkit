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
  swLog(`ADAPTER_BANNER pid=${process.pid} core=${CORE_SOURCE_HASH} rules_loaded=${rulesLoaded} rules_path=${rulesPath ?? '(unset)'}`)
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
      const validated = validateRuleSet({ rules: canonical }, this.registry).rules
      this.translatedLegacy = canonical
      this.lastFingerprint = fp
      return { rules: validated, fingerprint: fp }
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
      const validated = validateRuleSet({ rules: canonical }, this.registry).rules
      const oldCount = this.rules.length
      this.rules = validated  // ATOMIC SWAP
      this.translatedLegacy = canonical
      this.lastFingerprint = fp
      this.onSwap(validated)
      swLog(`RULES_RELOADED old=${oldCount} new=${validated.length} mtime=${new Date(fp.mtimeMs).toISOString()}`)
      return { reloaded: true }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      this.lastFingerprint = fp  // don't retry every 2s
      swLog(`RULES_RELOAD_FAIL error="${msg}" keeping-old-rules=${this.rules.length}`)
      return { reloaded: false, error: msg }
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

  evaluate(ctx: SignalWireContext): SignalWireResult | null {
    this.rulesStore.maybeReload()
    const event = contextToEvent(ctx, this.sessionId)
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
    this.logInvoke('evaluate-hook', event)
    const results = await this.pipeline.process(event)
    // Cache so legacy sync evaluate() (if anyone still calls it) sees something
    this.lastAsyncResult = this.toLegacy(results)
    return results
  }

  /** External wake-event evaluation (wake-listener.ts consumer). */
  async evaluateExternal(wakeEvent: WakeEvent): Promise<{ matched: CoreRule[]; results: EmitResult[] }> {
    this.rulesStore.maybeReload()
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
