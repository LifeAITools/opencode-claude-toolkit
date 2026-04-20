/**
 * SignalWire adapter over @kiberos/signal-wire-core.
 *
 * Drop-in replacement for the internal SignalWire class in signal-wire.ts.
 * Same public API (provider.ts call sites unchanged), same constructor shape,
 * but internally delegates rule evaluation to the canonical Core engine.
 *
 * Translation helpers live in signal-wire-translate.ts (ADR-0007 LOC budget).
 */

import { appendFileSync, existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  Pipeline,
  MemoryBackend,
  EmitterRegistry,
  validateRuleSet,
  CORE_VERSION,
  CORE_SOURCE_HASH,
  coreIdentityTag,
  type Rule as CoreRule,
  type SignalWireEvent,
  type EmitResult,
} from '@kiberos/signal-wire-core'

import type { WakeEvent } from './wake-types'
import {
  contextToEvent,
  translateLegacyRules,
  type SignalWireContext,
  type HookEvent,
} from './signal-wire-translate'

// ─── Adapter identity SSOT ────────────────────────────────
// Bumped when this file's behavior changes, independent of Core version.
const ADAPTER_VERSION = '1.0.0' as const
const ADAPTER_MTIME: string = new Date().toISOString()
const ADAPTER_ID = `sw-adapter-opencode-claude v${ADAPTER_VERSION}@${ADAPTER_MTIME.slice(11, 19)}`

const LOG_FILE = join(homedir(), '.claude', 'signal-wire-debug.log')

/** Emit adapter identity line ONCE per process on first construction. */
let adapterBannerEmitted = false
function emitAdapterBanner(rulesLoaded: number, rulesPath: string | undefined): void {
  if (adapterBannerEmitted) return
  adapterBannerEmitted = true
  const ts = new Date().toISOString()
  const line = `[${ts}] ${coreIdentityTag()} [${ADAPTER_ID}] ADAPTER_BANNER pid=${process.pid} core=${CORE_SOURCE_HASH} rules_loaded=${rulesLoaded} rules_path=${rulesPath ?? '(unset)'}\n`
  try { appendFileSync(LOG_FILE, line) } catch {}
}

// ─── Legacy-surface types (unchanged contract) ─────────────

export type { HookEvent, SignalWireContext } from './signal-wire-translate'

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
  private readonly rules: CoreRule[]
  private readonly disabledRuleIds = new Set<string>()
  private contextPosition = 0
  /** Cache of last async evaluate result — supports legacy sync `evaluate()`. */
  private lastAsyncResult: SignalWireResult | null = null

  constructor(config: SignalWireConfig) {
    this.sessionId = config.sessionId
    this.platform = config.platform ?? 'opencode'
    this.maxRulesPerFire = config.maxRulesPerFire ?? 3

    this.registry = new EmitterRegistry()
    this.rules = this.loadAndTranslate(config.rulesPath)

    // Adapter identity banner (before Pipeline — so the line appears early)
    emitAdapterBanner(this.rules.length, config.rulesPath)

    this.pipeline = new Pipeline({
      rules: this.rules,
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

  private loadAndTranslate(path: string | undefined): CoreRule[] {
    if (!path || !existsSync(path)) return []
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      const legacy = (raw.rules ?? []) as unknown[]
      const canonical = translateLegacyRules(legacy, this.platform)
      return validateRuleSet({ rules: canonical }, this.registry).rules
    } catch {
      return []
    }
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

  toggleRule(ruleId: string, enabled: boolean): boolean {
    if (!this.rules.some(r => r.id === ruleId)) return false
    if (enabled) this.disabledRuleIds.delete(ruleId)
    else this.disabledRuleIds.add(ruleId)
    // Apply effective enabled state to Core via re-set
    const effective = this.rules.map(r => ({
      ...r,
      enabled: r.enabled !== false && !this.disabledRuleIds.has(r.id),
    }))
    this.pipeline._setRules(effective)
    return true
  }

  listRules(): Array<{ id: string; description: string; enabled: boolean; events: string[] }> {
    return this.rules.map(r => ({
      id: r.id,
      description: '',
      enabled: r.enabled !== false && !this.disabledRuleIds.has(r.id),
      events: r.events,
    }))
  }

  isRuleEnabled(ruleId: string): boolean { return !this.disabledRuleIds.has(ruleId) }

  /**
   * Legacy sync evaluate. Kicks off async pipeline, returns last cached value.
   * Current invocation's result is cached for the NEXT call (tick-delayed).
   * Production call pattern in provider.ts is idempotent under this model.
   *
   * NEW callers should use evaluateAsync() for immediate results.
   */
  evaluate(ctx: SignalWireContext): SignalWireResult | null {
    const event = contextToEvent(ctx, this.sessionId)
    this.pipeline.process(event)
      .then(rs => { this.lastAsyncResult = this.toLegacy(rs) })
      .catch(() => { /* CN-09 */ })
    return this.lastAsyncResult
  }

  /** Preferred async API. */
  async evaluateAsync(ctx: SignalWireContext): Promise<SignalWireResult | null> {
    const event = contextToEvent(ctx, this.sessionId)
    const results = await this.pipeline.process(event)
    const legacy = this.toLegacy(results)
    this.lastAsyncResult = legacy
    return legacy
  }

  /** External wake-event evaluation (wake-listener.ts consumer). */
  async evaluateExternal(wakeEvent: WakeEvent): Promise<{ matched: CoreRule[]; results: EmitResult[] }> {
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
    const results = await this.pipeline.process(event)
    const firedIds = new Set(results.map(r => r.ruleId))
    return { matched: this.rules.filter(r => firedIds.has(r.id)), results }
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
