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

// ─── Constants ────────────────────────────────────────────

const DEBUG = process.env.SIGNAL_WIRE_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'signal-wire-debug.log')
const DEFAULT_EXEC_TIMEOUT_S = 15

// ─── Logging (standalone — mirrors provider.ts dbg() pattern) ─

function dbg(...args: any[]) {
  if (!DEBUG) return
  try {
    appendFileSync(
      LOG_FILE,
      `[${new Date().toISOString()}] [signal-wire] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`,
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

// ─── SignalWire class ─────────────────────────────────────

export class SignalWire {
  private readonly rules: readonly Rule[]
  private readonly serverUrl: string
  private readonly platform: string
  private readonly maxRulesPerFire: number
  private sessionId: string
  private sessionIdResolved = false
  private readonly cooldownMap: Map<string, number> = new Map()
  private contextPosition: number = 0

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

    // Resolve session ID early — gives async fetch time to complete before first fire
    if (!this.sessionIdResolved) this.resolveSessionId()

    dbg(`init: ${this.rules.length} rules loaded (platform=${this.platform}), server=${this.serverUrl}, session=${this.sessionId}`)
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

        // Skip disabled
        if (rule.enabled === false) continue

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
    if (this.sessionIdResolved || !this.serverUrl) return
    this.sessionIdResolved = true // Only try once
    // Query server for most recent session matching our CWD — fire-and-forget
    const cwd = process.cwd()
    fetch(`${this.serverUrl}/session`)
      .then(res => res.json())
      .then((sessions: any[]) => {
        if (!sessions?.length) return
        // Filter by directory (CWD) and sort by most recently updated
        const matching = sessions
          .filter((s: any) => s.directory === cwd && !s.parentID) // exclude subagent sessions
          .sort((a: any, b: any) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
        if (matching.length) {
          this.sessionId = matching[0].id
          dbg(`signal-wire: resolved sessionId=${this.sessionId} (cwd=${cwd}, matched ${matching.length} sessions)`)
        }
      })
      .catch(() => {}) // Silent — non-critical
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
        dbg(`TUI POST skipped: no sessionId after retry`)
        return
      }

      const label = ids.join('+')
      const formatted = this.formatTuiMessage(ids, hint)
      const url = `${this.serverUrl}/session/${this.sessionId}/message`
      const body = JSON.stringify({
        noReply: true,
        parts: [
          {
            type: 'text',
            text: formatted,
            synthetic: true,
          },
        ],
      })

      // Fire-and-forget — never await, never block
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
        .then(res => {
          dbg(`TUI POST ${label}: ${res.status}`)
        })
        .catch((e: any) => {
          dbg(`TUI POST ${label} failed:`, e.message)
        })
    } catch (e: any) {
      dbg('notifyTui error:', e.message)
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
}
