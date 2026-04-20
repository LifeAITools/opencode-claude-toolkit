/**
 * Signal-Wire: Dynamic Rule Engine for Claude Code (TypeScript port)
 *
 * A configurable rule engine that evaluates JSON rules against tool/prompt
 * events and triggers actions (hint injection, bash execution, TUI notification).
 *
 * Ported from Python: hooks/signal-wire.py
 * Rule format: hooks/config/signal-wire-rules.json
 *
 * STANDALONE — does not import from provider.ts or any external package.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { WakeEvent } from './wake-types'
import type { RuleV2, ActionV2, Severity, TrustLevel } from './wake-types'
import { EVENT_TYPES } from './wake-types'
import { dispatchActions, type ActionContext, type ActionResult } from './signal-wire-actions'
import { createAuditWriter, writeAuditEntry, type UnifiedAuditEntry } from './signal-wire-audit'

// ─── Constants ────────────────────────────────────────────

const DEBUG = process.env.SIGNAL_WIRE_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'signal-wire-debug.log')
const DEFAULT_EXEC_TIMEOUT_S = 15

// ─── Identity SSOT (so shared log file is greppable per-engine) ──
// Version is the "vLegacy" — deliberately not semver to mark it as the
// old in-package engine being phased out. See SIGNAL-WIRE-CORE-MIGRATION.md.
const LEGACY_VERSION = 'legacy-v1.x' as const
const LEGACY_BOOT_TIME: string = new Date().toISOString()
const LEGACY_ID = `sw-legacy ${LEGACY_VERSION}@${LEGACY_BOOT_TIME.slice(11, 19)} pid=${process.pid}`

let legacyBannerEmitted = false
function emitLegacyBanner(rulesCount: number, platform: string) {
  if (legacyBannerEmitted) return
  legacyBannerEmitted = true
  try {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [${LEGACY_ID}] LEGACY_BANNER online platform=${platform} rules=${rulesCount}\n`,
    )
  } catch {}
}

// ─── Logging (standalone — mirrors provider.ts dbg() pattern) ─

function dbg(...args: any[]) {
  if (!DEBUG) return
  try {
    // Every log line tagged with identity — matches [sw-legacy legacy-v1.x@...] prefix
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [${LEGACY_ID}] [signal-wire] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
    )
  } catch {}
}

// ─── Types ────────────────────────────────────────────────

type HookEvent = 'UserPromptSubmit' | 'PostToolUse' | 'Stop'

export interface RuleMatch {
  tool?: string
  exclude_tools?: string[]
  input_contains?: Record<string, any>
  input_regex?: string
  input_keywords?: string[]
  response_keywords?: string[]
  response_regex?: string
  prompt_keywords?: string[]
  prompt_regex?: string
}

export interface RuleAction {
  hint?: string
  exec?: string
  timeout?: number
}

export interface Rule {
  id: string
  enabled?: boolean
  description?: string
  events: HookEvent[]
  match?: RuleMatch
  action: RuleAction
  cooldown_tokens?: number
  cooldown_minutes?: number
  cooldown_namespace?: string
  platforms?: string[]  // e.g. ["claude-code"] — skip on other platforms
}

export interface SignalWireContext {
  event: HookEvent
  lastUserText: string
  lastToolName: string
  lastToolInput: string
  lastToolOutput: string
}

export interface SignalWireResult {
  ruleId: string
  hint: string
  execCmd?: string
}

export interface SignalWireConfig {
  serverUrl: string
  sessionId: string
  rulesPath?: string
  platform?: string  // 'opencode' | 'claude-code' — filters rules by platforms field
  maxRulesPerFire?: number  // max rules to fire per evaluate (default: 3)
}

// ─── v1→v2 Migration ─────────────────────────────────────

/**
 * Migrate v1 rule to v2 format (CR-04: auto-migration at load time).
 * v1: { action: { hint: "...", bash: "..." } }
 * v2: { actions: [{ type: "hint", text: "..." }, { type: "exec", command: "..." }] }
 * 
 * If rule already has `actions`, it's v2 — pass through.
 * Original `action` field preserved for backward compat.
 */
function migrateRule(rule: Rule): RuleV2 {
  const v2: RuleV2 = { ...rule } as RuleV2
  
  // Already v2 — has actions array
  if (v2.actions && v2.actions.length > 0) {
    return v2
  }
  
  // v1 migration: action → actions
  if (rule.action) {
    const actions: ActionV2[] = []
    if (rule.action.hint) {
      actions.push({ type: 'hint', text: rule.action.hint })
    }
    if (rule.action.bash) {
      actions.push({ type: 'exec', command: rule.action.bash })
    }
    if (actions.length > 0) {
      v2.actions = actions
    }
  }
  
  // Set defaults for v2 fields
  if (!v2.severity) v2.severity = 'info'
  if (!v2.trust_level) v2.trust_level = 'any'
  
  return v2
}

// ─── SignalWire class ─────────────────────────────────────

export class SignalWire {
  private readonly rules: readonly Rule[]
  readonly rulesV2: readonly RuleV2[] = []  // v2 migrated rules
  private readonly serverUrl: string
  private readonly platform: string
  private readonly maxRulesPerFire: number
  private sessionId: string
  private sessionIdResolved = false
  private readonly cooldownMap: Map<string, number> = new Map()
  private contextPosition: number = 0
  private sdkClient: any = null
  /** Runtime-disabled rule IDs (session-local, DB-05: never modifies rules file) */
  private disabledRules = new Set<string>()

  constructor(config: SignalWireConfig) {
    this.serverUrl = config.serverUrl
    this.sessionId = config.sessionId
    this.platform = config.platform ?? 'opencode'
    this.maxRulesPerFire = config.maxRulesPerFire ?? 3
    // If sessionId is unknown, try to resolve from server on first TUI POST
    this.sessionIdResolved = !!config.sessionId && config.sessionId !== '?' && config.sessionId !== 'unknown'

    let rules: Rule[] = []
    if (config.rulesPath) {
      rules = this.loadRules(config.rulesPath)
    }
    // Filter out rules for other platforms
    rules = rules.filter(r => !r.platforms || r.platforms.includes(this.platform))
    // Freeze — rules never change after construction
    this.rules = Object.freeze(rules)
    // Migrate all rules to v2 format (CR-04)
    this.rulesV2 = Object.freeze(this.rules.map(r => migrateRule(r)))

    // Resolve session ID early — gives async fetch time to complete before first fire
    if (!this.sessionIdResolved) this.resolveSessionId()

    // Emit identity banner so shared log file clearly shows this Legacy engine is the writer
    emitLegacyBanner(this.rules.length, this.platform)
    dbg(`init: ${this.rules.length} rules loaded (platform=${this.platform}), server=${this.serverUrl}, session=${this.sessionId}`)
  }

  setSdkClient(client: any): void {
    this.sdkClient = client
    // Retry resolution if it was skipped due to missing sdkClient (validation F5 fix)
    if (!this.sessionIdResolved) this.resolveSessionId()
  }

  // ─── Runtime rule toggle (REQ-06, AC-20-24) ───────────

  /** Toggle a rule's enabled state for this session. Returns true if rule exists. */
  toggleRule(ruleId: string, enabled: boolean): boolean {
    const exists = this.rules.some(r => r.id === ruleId)
    if (!exists) return false
    if (enabled) {
      this.disabledRules.delete(ruleId)
    } else {
      this.disabledRules.add(ruleId)
    }
    dbg(`toggleRule: ${ruleId} → ${enabled ? 'enabled' : 'disabled'}`)
    return true
  }

  /** List all rules with their enabled/disabled status */
  listRules(): Array<{ id: string; description: string; enabled: boolean; events: string[] }> {
    return this.rules.map(r => ({
      id: r.id,
      description: r.description ?? '',
      enabled: !this.disabledRules.has(r.id) && r.enabled !== false,
      events: r.events,
    }))
  }

  /** Check if a rule is enabled (both file-level and runtime toggle) */
  isRuleEnabled(ruleId: string): boolean {
    return !this.disabledRules.has(ruleId)
  }

  // ─── Rule loading ───────────────────────────────────────

  loadRules(path: string): Rule[] {
    try {
      if (!existsSync(path)) {
        dbg(`rules file not found: ${path}`)
        return []
      }
      const raw = readFileSync(path, 'utf8')
      const parsed = JSON.parse(raw)
      const rules: Rule[] = parsed.rules ?? []
      dbg(`loaded ${rules.length} rules from ${path}`)
      return rules
    } catch (e: any) {
      dbg(`failed to load rules from ${path}:`, e.message)
      return []
    }
  }

  // ─── Token tracking ─────────────────────────────────────

  /**
   * Track context position for cooldown bucket calculations.
   *
   * Uses the CURRENT PROMPT SIZE (input + cacheRead + cacheCreation) as the
   * context position — this represents where the agent is in its ~200K context
   * window. Unlike cumulative counting, this maps to something real:
   *
   *   Session start:  ~33K  (system + tools prefix)
   *   Mid-session:    ~100K (growing conversation)
   *   Near limit:     ~180K (approaching compaction)
   *   After compact:  ~50K  (context reset → rules can re-fire)
   *
   * Cooldown buckets divide the context window into zones. A rule with
   * cooldown_tokens=50K fires at 0-50K, 50-100K, 100-150K, 150-200K —
   * roughly 4 times per context lifecycle. After compaction, zone 0-50K
   * is re-entered and rules fire again (correct: agent lost memory).
   */
  trackTokens(usage: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }): void {
    try {
      // Context position = total prompt size for this API call
      const promptSize =
        (usage.inputTokens ?? 0) +
        (usage.cacheReadInputTokens ?? 0) +
        (usage.cacheCreationInputTokens ?? 0)

      const prev = this.contextPosition

      // Detect compaction: context drops by >40% → agent lost memory → reset cooldowns
      // so rules re-fire to re-prime the agent after compaction.
      if (prev > 0 && promptSize > 0 && promptSize < prev * 0.6) {
        this.cooldownMap.clear()
        dbg(`compaction detected: ${prev}→${promptSize} (${((1 - promptSize/prev) * 100).toFixed(0)}% drop) — all cooldowns reset`)
      }

      if (promptSize > 0) {
        this.contextPosition = promptSize
      }
      dbg(`trackTokens: promptSize=${promptSize} contextPosition=${prev}→${this.contextPosition}`)
    } catch (e: any) {
      dbg('trackTokens error:', e.message)
    }
  }

  getContextPosition(): number {
    return this.contextPosition
  }

  // ─── Evaluation ─────────────────────────────────────────

  /** Evaluate all matching rules (up to maxRulesPerFire). Returns combined result or null. */
  evaluate(context: SignalWireContext): SignalWireResult | null {
    try {
      const results: SignalWireResult[] = []

      for (const rule of this.rules) {
        if (results.length >= this.maxRulesPerFire) break

        // Skip disabled (file-level or runtime toggle — REQ-06)
        if (rule.enabled === false) continue
        if (this.disabledRules.has(rule.id)) continue

        // Event filter
        if (!rule.events.includes(context.event)) continue

        // Pattern match
        if (!this.matchRule(rule, context)) continue

        // Cooldown check
        if (!this.checkCooldown(rule)) continue

        // Rule fires — build result
        const hint = this.substituteVars(rule.action.hint ?? '', rule, context)

        // Mark cooldown
        this.markCooldown(rule)

        // Fire-and-forget exec (no hint for exec-only rules)
        if (rule.action.exec) {
          const cmd = this.substituteVars(rule.action.exec, rule, context)
          this.execFireAndForget(cmd, rule)
        }

        // Only collect hint-bearing rules for injection
        if (hint) {
          results.push({
            ruleId: rule.id,
            hint,
            execCmd: rule.action.exec ? this.substituteVars(rule.action.exec, rule, context) : undefined,
          })
        }

        dbg(`rule fired: ${rule.id} → ${hint.replace(/\n/g, ' ').slice(0, 120)}`)
      }

      if (results.length === 0) return null

      // Combine all fired hints with signal-wire tags
      const ids = results.map(r => r.ruleId)
      const combined = results
        .map(r => `⚡ signal-wire: ${r.ruleId}\n${r.hint}`)
        .join('\n\n')

      // Fire-and-forget TUI notification (combined)
      this.notifyTui(ids, combined)

      return {
        ruleId: ids.join('+'),
        hint: combined,
      }
    } catch (e: any) {
      dbg('evaluate error:', e.message)
      return null
    }
  }

  // ─── Pattern matching ───────────────────────────────────

  private matchRule(rule: Rule, ctx: SignalWireContext): boolean {
    try {
      const match = rule.match
      if (!match || Object.keys(match).length === 0) return true

      // exclude_tools — skip if tool name is in the exclusion list
      if (match.exclude_tools && match.exclude_tools.length > 0) {
        if (match.exclude_tools.includes(ctx.lastToolName)) return false
      }

      // tool regex
      if (match.tool) {
        try {
          if (!new RegExp(match.tool).test(ctx.lastToolName)) return false
        } catch (e: any) {
          dbg(`invalid regex in rule ${rule.id}.tool:`, e.message)
          return false
        }
      }

      // input_contains — deep dict subset match
      if (match.input_contains) {
        try {
          const inputObj = ctx.lastToolInput ? JSON.parse(ctx.lastToolInput) : {}
          if (!this.deepMatch(inputObj, match.input_contains)) return false
        } catch {
          // If input isn't valid JSON, match against string representation
          if (!this.deepMatch(ctx.lastToolInput, match.input_contains)) return false
        }
      }

      // input_regex
      if (match.input_regex) {
        try {
          if (!new RegExp(match.input_regex).test(ctx.lastToolInput)) return false
        } catch (e: any) {
          dbg(`invalid regex in rule ${rule.id}.input_regex:`, e.message)
          return false
        }
      }

      // input_keywords — any keyword found (case-insensitive substring)
      if (match.input_keywords && match.input_keywords.length > 0) {
        const inputLower = ctx.lastToolInput.toLowerCase()
        if (!match.input_keywords.some(kw => inputLower.includes(kw.toLowerCase()))) return false
      }

      // response_keywords
      if (match.response_keywords && match.response_keywords.length > 0) {
        const outputLower = ctx.lastToolOutput.toLowerCase()
        if (!match.response_keywords.some(kw => outputLower.includes(kw.toLowerCase()))) return false
      }

      // response_regex
      if (match.response_regex) {
        try {
          if (!new RegExp(match.response_regex).test(ctx.lastToolOutput)) return false
        } catch (e: any) {
          dbg(`invalid regex in rule ${rule.id}.response_regex:`, e.message)
          return false
        }
      }

      // prompt_keywords — match against user prompt text
      if (match.prompt_keywords && match.prompt_keywords.length > 0) {
        const promptLower = ctx.lastUserText.toLowerCase()
        if (!match.prompt_keywords.some(kw => promptLower.includes(kw.toLowerCase()))) return false
      }

      // prompt_regex
      if (match.prompt_regex) {
        try {
          if (!new RegExp(match.prompt_regex).test(ctx.lastUserText)) return false
        } catch (e: any) {
          dbg(`invalid regex in rule ${rule.id}.prompt_regex:`, e.message)
          return false
        }
      }

      return true
    } catch (e: any) {
      dbg(`matchRule error for ${rule.id}:`, e.message)
      return false
    }
  }

  // ─── Deep match (recursive subset) ─────────────────────

  private deepMatch(data: any, pattern: any): boolean {
    if (pattern === null || pattern === undefined) return data === pattern

    if (typeof pattern === 'object' && !Array.isArray(pattern)) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
      return Object.entries(pattern).every(
        ([k, v]) => k in data && this.deepMatch(data[k], v),
      )
    }

    if (typeof pattern === 'string' && typeof data === 'string') {
      return data.toLowerCase().includes(pattern.toLowerCase())
    }

    return data === pattern
  }

  // ─── Token-bucket cooldown ──────────────────────────────

  private checkCooldown(rule: Rule): boolean {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0
      const cooldownMinutes = rule.cooldown_minutes ?? 0

      if (cooldownTokens <= 0 && cooldownMinutes <= 0) return true

      if (cooldownTokens > 0) {
        // Context-position based: bucket = floor(contextPosition / cooldown_tokens)
        // contextPosition = current prompt size (~33K start, grows to ~200K, drops on compaction)
        // This divides the context window into zones. A rule with cooldown_tokens=50K
        // fires in zones: [0-50K], [50-100K], [100-150K], [150-200K] — roughly 4 times.
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens)
        const ns = rule.cooldown_namespace ?? rule.id
        const lastBucket = this.cooldownMap.get(ns)

        if (lastBucket !== undefined && currentBucket <= lastBucket) {
          dbg(`cooldown active: ${rule.id} (ns:${ns}, pos:${this.contextPosition}, cd:${Math.floor(cooldownTokens / 1000)}k, bucket:${currentBucket})`)
          return false
        }
        return true
      }

      if (cooldownMinutes > 0) {
        // Time-based: store timestamp of last fire
        const ns = rule.cooldown_namespace ?? rule.id
        const key = `${ns}_time`
        const lastFired = this.cooldownMap.get(key)
        const now = Date.now()

        if (lastFired !== undefined && (now - lastFired) < cooldownMinutes * 60 * 1000) {
          dbg(`cooldown active (time): ${rule.id} (ns:${ns}, cd:${cooldownMinutes}m)`)
          return false
        }
        return true
      }

      return true
    } catch (e: any) {
      dbg('checkCooldown error:', e.message)
      return true // On error, allow rule to fire
    }
  }

  private markCooldown(rule: Rule): void {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0
      const cooldownMinutes = rule.cooldown_minutes ?? 0

      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens)
        const ns = rule.cooldown_namespace ?? rule.id
        this.cooldownMap.set(ns, currentBucket)
        dbg(`cooldown marked: ${rule.id} (ns:${ns}, bucket:${currentBucket}, pos:${this.contextPosition})`)
      } else if (cooldownMinutes > 0) {
        const ns = rule.cooldown_namespace ?? rule.id
        this.cooldownMap.set(`${ns}_time`, Date.now())
      }
    } catch (e: any) {
      dbg('markCooldown error:', e.message)
    }
  }

  // ─── Variable substitution ──────────────────────────────

  private substituteVars(template: string, rule: Rule, ctx: SignalWireContext): string {
    if (!template) return template
    return template
      .replace(/\{tool_name\}/g, ctx.lastToolName)
      .replace(/\{session_id\}/g, this.sessionId)
      .replace(/\{cwd\}/g, process.cwd())
      .replace(/\{rule_id\}/g, rule.id)
  }

  // ─── TUI notification (fire-and-forget) ─────────────────

  private resolveSessionId(): void {
    if (this.sessionIdResolved) return
    if (!this.sdkClient) return  // Do NOT set sessionIdResolved — allow retry via setSdkClient()
    this.sessionIdResolved = true  // Only set AFTER confirming we CAN attempt resolution
    const cwd = process.cwd()
    this.sdkClient.session.list()
      .then(({ data: sessions }: any) => {
        if (!Array.isArray(sessions)) return
        const matching = sessions
          .filter((s: any) => s.directory === cwd && !s.parentID)
          .sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        if (matching.length) {
          this.sessionId = matching[0].id
          dbg(`signal-wire: resolved sessionId=${this.sessionId} (cwd=${cwd}, matched ${matching.length} sessions)`)
        }
      })
      .catch((e: any) => dbg('resolveSessionId error:', e?.message))
  }

  /** Format TUI message with flashlight box for visual distinction */
  private formatTuiMessage(ids: string[], hint: string): string {
    const header = ids.length === 1
      ? `⚡ signal-wire: ${ids[0]}`
      : `⚡ signal-wire: ${ids.join(' + ')}`
    const width = Math.max(header.length + 2, 40)
    const bar = '━'.repeat(width)
    return `${bar}\n${header}\n${bar}\n${hint}\n${bar}`
  }

  private notifyTui(ids: string | string[], hint: string): void {
    const idArr = Array.isArray(ids) ? ids : [ids]
    try {
      if (!this.sessionId || this.sessionId === '?' || this.sessionId === 'unknown') {
        // Session ID not resolved yet — retry after 2s (resolution is in-flight from constructor)
        setTimeout(() => this.doTuiPost(idArr, hint), 2000)
        return
      }
      this.doTuiPost(idArr, hint)
    } catch (e: any) {
      dbg('notifyTui error:', e.message)
    }
  }

  private doTuiPost(ids: string[], hint: string): void {
    try {
      if (!this.sessionId || this.sessionId === '?' || this.sessionId === 'unknown') {
        dbg('TUI POST skipped: no sessionId after retry')
        return
      }
      if (!this.sdkClient) { dbg('TUI POST skipped: no sdkClient'); return }

      const label = ids.join('+')
      const formatted = this.formatTuiMessage(ids, hint)

      // Fire-and-forget via sdkClient — never await, never block
      this.sdkClient.session.prompt({
        path: { id: this.sessionId },
        body: {
          noReply: true,
          parts: [{ type: 'text', text: formatted, synthetic: true }],
        },
      })
        .then(() => dbg(`TUI POST ${label}: ok`))
        .catch((e: any) => dbg(`TUI POST ${label} failed:`, e?.message))
    } catch (e: any) {
      dbg('notifyTui error:', e?.message)
    }
  }

  // ─── Exec action (fire-and-forget) ──────────────────────

  private execFireAndForget(cmd: string, rule: Rule): void {
    try {
      const timeout = (rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S) * 1000

      // Bun.spawn — fire and forget
      if (typeof Bun !== 'undefined' && Bun.spawn) {
        const proc = Bun.spawn(['bash', '-c', cmd], {
          env: {
            ...process.env,
            SIGNAL_WIRE_ACTIVE: '1',
            SIGNAL_WIRE_SESSION_ID: this.sessionId,
            SIGNAL_WIRE_CWD: process.cwd(),
            SIGNAL_WIRE_RULE_ID: rule.id,
          },
          stdout: 'ignore',
          stderr: 'pipe',
        })

        // Timeout kill (non-blocking)
        const timer = setTimeout(() => {
          try {
            proc.kill()
            dbg(`exec timeout (${rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S}s) for rule ${rule.id}`)
          } catch {}
        }, timeout)

        // Clean up timer when process exits
        proc.exited
          .then((code: number) => {
            clearTimeout(timer)
            if (code !== 0) {
              dbg(`exec failed (${code}) for rule ${rule.id}`)
            } else {
              dbg(`exec ok for rule ${rule.id}`)
            }
          })
          .catch((e: any) => {
            clearTimeout(timer)
            dbg(`exec error for rule ${rule.id}:`, e.message)
          })
      } else {
        // Node.js fallback — child_process spawn
        const { spawn } = require('child_process')
        const proc = spawn('bash', ['-c', cmd], {
          env: {
            ...process.env,
            SIGNAL_WIRE_ACTIVE: '1',
            SIGNAL_WIRE_SESSION_ID: this.sessionId,
            SIGNAL_WIRE_CWD: process.cwd(),
            SIGNAL_WIRE_RULE_ID: rule.id,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
          detached: false,
        })

        const timer = setTimeout(() => {
          try {
            proc.kill()
            dbg(`exec timeout (${rule.action.timeout ?? DEFAULT_EXEC_TIMEOUT_S}s) for rule ${rule.id}`)
          } catch {}
        }, timeout)

        proc.on('close', (code: number | null) => {
          clearTimeout(timer)
          if (code !== 0) {
            dbg(`exec failed (${code}) for rule ${rule.id}`)
          } else {
            dbg(`exec ok for rule ${rule.id}`)
          }
        })

        proc.on('error', (e: any) => {
          clearTimeout(timer)
          dbg(`exec error for rule ${rule.id}:`, e.message)
        })
      }

      dbg(`exec spawned for rule ${rule.id}: ${cmd.slice(0, 120)}`)
    } catch (e: any) {
      dbg(`execFireAndForget error for rule ${rule.id}:`, e.message)
    }
  }

  // ─── v2 Evaluation: Hook Entry Point (ARCH-01: reactive) ──────

  /**
   * Evaluate hook context against v2 rules with unified action dispatch.
   * Returns v1-compatible result (for backward compat) AND v2 action results.
   * Token-based cooldown stays here (ARCH-02: reactive subsystem).
   */
  async evaluateHookV2(context: SignalWireContext): Promise<{
    v1Result: SignalWireResult | null
    v2Results: ActionResult[]
    blocked: boolean
  }> {
    try {
      const matched = this.matchRulesV2(context)
      if (matched.length === 0) return { v1Result: null, v2Results: [], blocked: false }

      const results: ActionResult[] = []
      let blocked = false
      let hintText = ''

      for (const rule of matched) {
        // Trust level check (CR-05)
        if (rule.trust_level === 'plugin_only' && this.isProjectRule(rule)) {
          dbg(`trust: skipping ${rule.id} (plugin_only but from project)`)
          continue
        }

        // Token-based cooldown (ARCH-02: reactive subsystem)
        if (!this.checkCooldownV2(rule)) continue

        const actions = rule.actions ?? []
        if (actions.length === 0) continue

        // Mark cooldown BEFORE dispatching (prevents re-fire during async)
        this.markCooldownV2(rule)

        const ctx: ActionContext = {
          serverUrl: this.serverUrl,
          sessionId: this.sessionId,
          ruleId: rule.id,
          severity: rule.severity ?? 'info',
          event: context.event,
          variables: this.buildVariables(context, rule),
          auditWriter: createAuditWriter(this.sessionId),
          sdkClient: this.sdkClient,
        }

        const actionResults = await dispatchActions(actions, ctx)
        results.push(...actionResults)

        // Check for block
        const blockResult = actionResults.find(r => r.type === 'block' && r.success)
        if (blockResult) blocked = true

        // Collect hints for v1 compat
        const hintResults = actionResults.filter(r => r.type === 'hint' && r.hintText)
        if (hintResults.length > 0) {
          hintText += (hintText ? '\n' : '') + hintResults.map(r => r.hintText).join('\n')
        }
      }

      // Build v1-compatible result
      const v1Result = hintText
        ? { ruleId: matched[0].id, hint: hintText } as SignalWireResult
        : null

      return { v1Result, v2Results: results, blocked }
    } catch (e: any) {
      dbg('evaluateHookV2 error:', e?.message)
      return { v1Result: null, v2Results: [], blocked: false }
    }
  }

  /** Convenience wrapper: calls evaluateHookV2 and returns v1-shaped result (CN-03) */
  async evaluateHook(context: SignalWireContext): Promise<SignalWireResult | null> {
    const { v1Result } = await this.evaluateHookV2(context)
    return v1Result
  }

  // ─── v2 Evaluation: External Entry Point (ARCH-01: proactive) ──

  /**
   * Evaluate an external event against rules (ARCH-01: proactive entry point).
   * Uses time-based rate limiting (ARCH-02: proactive subsystem).
   */
  async evaluateExternal(event: WakeEvent): Promise<{
    matched: boolean
    actionsExecuted: ActionResult[]
    wakeTriggered: boolean
  }> {
    try {
      const matched = this.matchExternalRules(event)
      if (matched.length === 0) {
        dbg(`evaluateExternal: no rules match event ${event.type} from ${event.source}`)
        return { matched: false, actionsExecuted: [], wakeTriggered: false }
      }

      const allResults: ActionResult[] = []
      let wakeTriggered = false

      for (const rule of matched) {
        // Trust level check (CR-05)
        if (rule.trust_level === 'plugin_only' && this.isProjectRule(rule)) continue

        const actions = rule.actions ?? []
        if (actions.length === 0) continue

        const ctx: ActionContext = {
          serverUrl: this.serverUrl,
          sessionId: this.sessionId,
          ruleId: rule.id,
          severity: rule.severity ?? 'info',
          event: EVENT_TYPES.EXTERNAL_EVENT,
          eventSource: event.source,
          eventType: event.type,
          variables: this.buildExternalVariables(event, rule),
          wakeEvent: event,
          auditWriter: createAuditWriter(this.sessionId),
          sdkClient: this.sdkClient,
        }

        const actionResults = await dispatchActions(actions, ctx)
        allResults.push(...actionResults)

        if (actionResults.some(r => r.type === 'wake' && r.wakeTriggered)) {
          wakeTriggered = true
        }
      }

      return { matched: true, actionsExecuted: allResults, wakeTriggered }
    } catch (e: any) {
      dbg('evaluateExternal error:', e?.message)
      return { matched: false, actionsExecuted: [], wakeTriggered: false }
    }
  }

  // ─── v2 Rule Matching ──────────────────────────────────────────

  /** Match v2 rules against hook context (mirrors v1 matchRule logic) */
  private matchRulesV2(context: SignalWireContext): RuleV2[] {
    return this.rulesV2.filter(rule => {
      if (rule.enabled === false) return false
      if (!rule.events.includes(context.event as any)) return false
      if (rule.platforms && !rule.platforms.includes(this.platform)) return false

      // Match conditions (same logic categories as v1 matchRule)
      if (rule.match) {
        if (rule.match.tool && context.lastToolName) {
          try {
            if (!new RegExp(rule.match.tool, 'i').test(context.lastToolName)) return false
          } catch { return false }
        }
        if (rule.match.input_regex && context.lastToolInput) {
          try {
            if (!new RegExp(rule.match.input_regex, 'i').test(context.lastToolInput)) return false
          } catch { return false }
        }
        if (rule.match.response_regex && context.lastToolOutput) {
          try {
            if (!new RegExp(rule.match.response_regex, 'i').test(context.lastToolOutput)) return false
          } catch { return false }
        }
        if (rule.match.keywords) {
          const combined = `${context.lastUserText} ${context.lastToolInput} ${context.lastToolOutput}`.toLowerCase()
          if (!rule.match.keywords.some(kw => combined.includes(kw.toLowerCase()))) return false
        }
      }

      return true
    })
  }

  /** Match v2 rules against external event */
  private matchExternalRules(event: WakeEvent): RuleV2[] {
    return this.rulesV2.filter(rule => {
      if (rule.enabled === false) return false

      // Must listen to external event types
      const externalEvents = [EVENT_TYPES.EXTERNAL_EVENT, EVENT_TYPES.WEBHOOK_EVENT, EVENT_TYPES.TIMER_EVENT]
      if (!rule.events.some(e => externalEvents.includes(e as any))) return false

      if (rule.platforms && !rule.platforms.includes(this.platform)) return false

      // Match event source + type
      if (rule.event_source_match) {
        if (rule.event_source_match.source && !event.source.includes(rule.event_source_match.source)) return false
        if (rule.event_source_match.type && event.type !== rule.event_source_match.type) return false
      }

      return true
    })
  }

  // ─── v2 Variable Builders ──────────────────────────────────────

  /** Build interpolation variables from hook context */
  private buildVariables(context: SignalWireContext, rule: RuleV2): Record<string, string> {
    return {
      tool_name: context.lastToolName ?? '',
      tool_input: context.lastToolInput?.slice(0, 500) ?? '',
      tool_output: context.lastToolOutput?.slice(0, 500) ?? '',
      user_text: context.lastUserText?.slice(0, 500) ?? '',
      session_id: this.sessionId,
      rule_id: rule.id,
      severity: rule.severity ?? 'info',
      event: context.event,
      cwd: process.cwd(),
      agent_id: process.env.AGENT_ID ?? '',
      agent_type: process.env.AGENT_TYPE ?? '',
    }
  }

  /** Build interpolation variables from external event */
  private buildExternalVariables(event: WakeEvent, rule: RuleV2): Record<string, string> {
    return {
      event_source: event.source,
      event_type: event.type,
      event_id: event.eventId,
      target_member: event.targetMemberId,
      session_id: this.sessionId,
      rule_id: rule.id,
      severity: rule.severity ?? 'info',
      priority: event.priority,
      cwd: process.cwd(),
    }
  }

  // ─── v2 Cooldown (reuses v1 bucket logic — ARCH-02) ────────────

  /**
   * Check cooldown for v2 rule. Same bucket logic as v1 checkCooldown.
   * Uses 'v2:' namespace prefix to avoid collision with v1 cooldowns.
   */
  private checkCooldownV2(rule: RuleV2): boolean {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0
      const cooldownMinutes = rule.cooldown_minutes ?? 0

      if (cooldownTokens <= 0 && cooldownMinutes <= 0) return true

      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens)
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`
        const lastBucket = this.cooldownMap.get(ns)

        if (lastBucket !== undefined && currentBucket <= lastBucket) {
          dbg(`cooldown v2 active: ${rule.id} (ns:${ns}, pos:${this.contextPosition}, bucket:${currentBucket})`)
          return false
        }
        return true
      }

      if (cooldownMinutes > 0) {
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`
        const key = `${ns}_time`
        const lastFired = this.cooldownMap.get(key)
        const now = Date.now()

        if (lastFired !== undefined && (now - lastFired) < cooldownMinutes * 60 * 1000) {
          dbg(`cooldown v2 active (time): ${rule.id} (ns:${ns}, cd:${cooldownMinutes}m)`)
          return false
        }
        return true
      }

      return true
    } catch (e: any) {
      dbg('checkCooldownV2 error:', e?.message)
      return true // On error, allow rule to fire
    }
  }

  /** Mark cooldown for v2 rule after firing */
  private markCooldownV2(rule: RuleV2): void {
    try {
      const cooldownTokens = rule.cooldown_tokens ?? 0
      const cooldownMinutes = rule.cooldown_minutes ?? 0

      if (cooldownTokens > 0) {
        const currentBucket = Math.floor(this.contextPosition / cooldownTokens)
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`
        this.cooldownMap.set(ns, currentBucket)
        dbg(`cooldown v2 marked: ${rule.id} (ns:${ns}, bucket:${currentBucket})`)
      } else if (cooldownMinutes > 0) {
        const ns = `v2:${rule.cooldown_namespace ?? rule.id}`
        this.cooldownMap.set(`${ns}_time`, Date.now())
      }
    } catch (e: any) {
      dbg('markCooldownV2 error:', e?.message)
    }
  }

  // ─── v2 Trust Level (CR-05) ────────────────────────────────────

  /**
   * Check if rule is from project dir (for trust level).
   * Rules from plugin dir = plugin_only OK.
   * Rules from project .claude/ = project-level.
   * TODO: track rule source path during loading (Task 8/9).
   */
  private isProjectRule(_rule: RuleV2): boolean {
    // For now: assume all rules are plugin-level (loaded from plugin config)
    // Will be updated when rule source tracking is added
    return false
  }
}

// ─── Wake Event Formatting (REQ-16) ─────────────────────────────────

/**
 * Format a wake event as a <system-reminder> block for LLM processing.
 * Templates vary by event type to give the agent clear action guidance.
 *
 * @param event - The WakeEvent to format
 * @returns Formatted string suitable for injection as a user message
 */
export function formatWakeEvent(event: WakeEvent): string {
  const header = `<system-reminder type="wake" source="${esc(event.source)}" priority="${event.priority}" event-id="${esc(event.eventId)}">`
  const footer = `</system-reminder>`

  const body = getEventTemplate(event)

  return `${header}\n${body}\n${footer}`
}

function getEventTemplate(event: WakeEvent): string {
  const p = event.payload as Record<string, any>

  switch (event.type) {
    case 'task_assigned':
      return [
        `## Wake: New Task Assigned`,
        ``,
        `### Task Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : '',
        `- **Title:** ${p.title ?? 'Unknown'}`,
        p.description ? `- **Description:** ${p.description}` : '',
        p.list || p.listName ? `- **List:** ${p.list ?? p.listName}` : '',
        p.priority ? `- **Priority:** ${p.priority}` : '',
        p.assigned_by || p.actorId ? `- **Assigned by:** ${p.assigned_by ?? p.actorId}` : '',
        p.due || p.dueDate ? `- **Due:** ${p.due ?? p.dueDate}` : '',
        ``,
        `### How to Work on This`,
        `1. Accept: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}", status: "started"})\``,
        `2. Read full task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}"})\``,
        `3. Do the work described above`,
        `4. When done: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}", status: "done"})\``,
        `5. Add result: \`synqtask_todo_comments({action: "add_result", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}", text: "Done: <summary>"})\``,
      ].filter(Boolean).join('\n')

    case 'channel_message': {
      // Webhook adapter sends camelCase: channelId, senderId, senderName
      const chId = p.channel_id ?? p.channelId ?? ''
      const sendId = p.sender_id ?? p.senderId ?? ''
      const sendName = p.sender_name ?? p.senderName ?? ''
      const isDirect = p.is_direct ?? p.isDirect ?? false
      return [
        `## Wake: New Channel Message`,
        ``,
        `### Message Details`,
        chId ? `- **Channel ID:** \`${chId}\`` : '',
        p.channel_name ?? p.channelName ? `- **Channel:** ${p.channel_name ?? p.channelName}` : '',
        sendName ? `- **From:** ${sendName}` : '',
        isDirect ? `- **Type:** Direct message to you` : `- **Type:** Channel broadcast`,
        ``,
        `### Message`,
        p.text ? `> ${p.text}` : '> (no text)',
        ``,
        `### ⚡ ACTION REQUIRED: Reply in channel`,
        `You MUST reply using this exact tool call:`,
        `\`\`\``,
        `synqtask_todo_channels({action: "send", channel_id: "${chId}", text: "YOUR REPLY HERE"})`,
        `\`\`\``,
        sendId ? `Or DM sender: \`synqtask_todo_channels({action: "create_dm", member_b: "${sendId}"})\` then send` : '',
      ].filter(Boolean).join('\n')
    }

    case 'delegation_received':
      return [
        `## Wake: Task Delegated to You`,
        ``,
        `### Delegation Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : '',
        `- **Title:** ${p.title ?? 'Unknown'}`,
        p.delegator || p.delegated_by ? `- **Delegated by:** ${p.delegator ?? p.delegated_by}` : '',
        p.delegator_id ? `- **Delegator ID:** \`${p.delegator_id}\`` : '',
        p.notes ? `- **Notes:** ${p.notes}` : '',
        ``,
        `### How to Handle`,
        `1. Accept: \`synqtask_todo_tasks({action: "accept_delegation", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}"})\``,
        `2. Read task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}"})\``,
        `3. Do the work`,
        `4. Complete: \`synqtask_todo_tasks({action: "set_status", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}", status: "done"})\``,
      ].filter(Boolean).join('\n')

    case 'comment_added':
      return [
        `## Wake: New Comment on Task`,
        ``,
        `### Comment Details`,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : '',
        p.task_title ? `- **Task:** ${p.task_title}` : '',
        p.commenter || p.actorId ? `- **From:** ${p.commenter ?? p.actorId}` : '',
        p.commenter_id ? `- **Commenter ID:** \`${p.commenter_id}\`` : '',
        ``,
        `### Comment`,
        p.text ? `> ${p.text}` : '> (no text)',
        ``,
        `### How to Reply`,
        `Reply: \`synqtask_todo_comments({action: "add", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}", text: "YOUR REPLY"})\``,
        `View all: \`synqtask_todo_comments({action: "list", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}"})\``,
      ].filter(Boolean).join('\n')

    case 'status_changed':
      return [
        `## Wake: Task Status Changed`,
        ``,
        p.task_id || p.entityId ? `- **Task ID:** \`${p.task_id ?? p.entityId}\`` : '',
        p.title ? `- **Task:** ${p.title}` : '',
        p.changes?.status ? `- **Status:** ${p.changes.status.from ?? '?'} → ${p.changes.status.to ?? '?'}` : '',
        p.actorId ? `- **Changed by:** ${p.actorId}` : '',
        ``,
        `View task: \`synqtask_todo_tasks({action: "show", task_id: "${p.task_id ?? p.entityId ?? 'TASK_ID'}"})\``,
      ].filter(Boolean).join('\n')

    case 'webhook_event':
      return [
        `## Wake: External Event`,
        ``,
        `- **Source:** ${event.source}`,
        p.webhook_type ? `- **Type:** ${p.webhook_type}` : '',
        ``,
        `### Payload`,
        '```json',
        JSON.stringify(p, null, 2),
        '```',
        ``,
        `Review and take appropriate action.`,
      ].join('\n')

    default:
      return [
        `## Wake: ${event.type}`,
        ``,
        `- **Source:** ${event.source}`,
        `- **Priority:** ${event.priority}`,
        `- **Event ID:** ${event.eventId}`,
        ``,
        `### Payload`,
        '```json',
        JSON.stringify(p, null, 2),
        '```',
        ``,
        `Review and respond as appropriate.`,
      ].join('\n')
  }
}

/** Escape XML-unsafe characters in attribute values */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export { migrateRule }
