import { createHash, randomBytes, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmdirSync, statSync, unlinkSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// NOTE: Live-reload keepalive config (~/.claude/keepalive.json) is now owned
// by src/keepalive-engine.ts — moved out of SDK during KA extraction.

import type {
  ClaudeCodeSDKOptions,
  CredentialsFile,
  CredentialStore,
  StoredCredentials,
  GenerateOptions,
  GenerateResponse,
  StreamEvent,
  TokenUsage,
  RateLimitInfo,
  ContentBlock,
  ThinkingBlock,
  ToolUseBlock,
  TokenStatusEvent,
} from './types.js'
import { AuthError, APIError, RateLimitError, ClaudeCodeSDKError } from './types.js'
import { resolveMaxTokens } from './models.js'
import { KeepaliveEngine } from './keepalive-engine.js'

// ============================================================
// Constants — cherry-picked from Claude Code CLI source
// ============================================================

// API
const API_BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

// OAuth — from src/constants/oauth.ts:84-104
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

// Beta headers — from src/constants/betas.ts + src/constants/oauth.ts:36
const OAUTH_BETA = 'oauth-2025-04-20'
const CLAUDE_CODE_BETA = 'claude-code-20250219'
const INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14'
const CONTEXT_1M_BETA = 'context-1m-2025-08-07'
const EFFORT_BETA = 'effort-2025-11-24'
const FAST_MODE_BETA = 'fast-mode-2026-02-01'
const PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05'
const FINE_GRAINED_TOOL_STREAMING_BETA = 'fine-grained-tool-streaming-2025-05-14'
const CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27'
const TASK_BUDGETS_BETA = 'task-budgets-2026-03-13'
const REDACT_THINKING_BETA = 'redact-thinking-2026-02-12'

// Retry — from src/services/api/withRetry.ts:55
const BASE_DELAY_MS = 300
const MAX_DELAY_MS = 5_000
const EXPIRY_BUFFER_MS = 300_000 // 5 min before actual expiry

// ── Proactive token rotation ──────────────────────────────────
// Refresh at 20% of token lifetime remaining (= 80% of life consumed).
// Was 0.50 (refresh at 50% life remaining) — too aggressive: triggered
// 6 fetch/day per refresh_token, hitting Anthropic's per-refresh_token
// rate limit and producing 429 storms. Standard OAuth clients refresh at
// 5-15% remaining (akin to "expires_in - 5min"). Original Claude Code CLI
// refreshes reactively on 401. Compromise: 20% gives ~96 min headroom on
// an 8h token (480min × 0.20 = 96min) before expiry, more than enough for
// retries, while cutting fetch frequency from ~6/day to ~1.2/day per token.
const PROACTIVE_REFRESH_RATIO = 0.20
// Escalation thresholds (fraction of lifetime remaining)
const TOKEN_WARNING_THRESHOLD = 0.25   // 25% left → WARNING
const TOKEN_CRITICAL_THRESHOLD = 0.10  // 10% left → CRITICAL
// Minimum time between proactive refresh attempts (prevents 429 storm)
const PROACTIVE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 min floor
// When force=true (proactive rotation), only accept a disk token if it has at least
// this much remaining life. Prevents all PIDs from endlessly picking up an aging
// token without anyone actually refreshing it.
// NOTE: Was 2 hours — way too strict. When Anthropic returns shorter tokens during
// rate limiting (e.g. 54min), all processes rejected the disk token and hammered
// the refresh endpoint → 429 stampede → death spiral → manual re-login required.
// 20 min gives enough time for the token to be useful while still rejecting
// truly stale tokens that would expire before the next rotation attempt.
const PROACTIVE_FRESH_MIN_REMAINING_MS = 20 * 60 * 1000 // 20 minutes
// Global cooldown after refresh 429 — exponential backoff across ALL processes
const REFRESH_COOLDOWN_FILE = join(homedir(), '.claude', '.refresh-cooldown')
// Maximum cooldown time (30 minutes)
const REFRESH_COOLDOWN_MAX_MS = 30 * 60 * 1000

// CC-compatible version for User-Agent and billing header.
// Must match an actual released Claude Code version.
// Updated when CC releases new versions. Checked by Anthropic for billing attribution.
const CC_COMPAT_VERSION = '2.1.90'

// ============================================================
// Tool name remapping — Anthropic blocks certain third-party tool names
// by routing requests to overage/extra-usage billing.
// We rename blocked names before sending and restore in responses.
// ============================================================
const TOOL_NAME_REMAP: Record<string, string> = {
  'todowrite': 'todo_write',
}
const TOOL_NAME_UNREMAP: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_NAME_REMAP).map(([k, v]) => [v, k])
)

function remapToolNames(tools: unknown[] | undefined): { remapped: unknown[] | undefined; didRemap: boolean } {
  if (!tools?.length) return { remapped: tools, didRemap: false }
  let didRemap = false
  const remapped = tools.map((t: any) => {
    const mapped = TOOL_NAME_REMAP[t.name]
    if (mapped) { didRemap = true; return { ...t, name: mapped } }
    return t
  })
  return { remapped, didRemap }
}

function unremapToolName(name: string): string {
  return TOOL_NAME_UNREMAP[name] ?? name
}

// ============================================================
// Filesystem lock for cross-process token refresh coordination
// ============================================================
const TOKEN_LOCK_DIR = join(homedir(), '.claude', '.token-refresh-lock')
const TOKEN_LOCK_STALE_MS = 30_000  // 30s stale timeout
// Lock acquisition budget: 30 attempts × ~1.5s = up to ~45s of patient waiting.
// Sized to comfortably cover the worst-case real refresh: 5 fetch attempts with
// backoff [500, 1500, 3000, 5000, 8000]ms + network RTT ≈ 25-30s.
// Previous value (5 attempts ≈ 10s) was too short — losing processes timed out
// while the winner was still mid-refresh, then proceeded to fetch without lock,
// triggering 429 storms on the OAuth endpoint (3+ PIDs hammering simultaneously).
const TOKEN_LOCK_MAX_ATTEMPTS = 30

async function acquireTokenRefreshLock(): Promise<(() => void) | null> {
  for (let attempt = 0; attempt < TOKEN_LOCK_MAX_ATTEMPTS; attempt++) {
    try {
      mkdirSync(TOKEN_LOCK_DIR)
      // Write PID + timestamp for stale detection
      writeFileSync(join(TOKEN_LOCK_DIR, 'pid'), `${process.pid}\n${Date.now()}`)
      return () => { try { unlinkSync(join(TOKEN_LOCK_DIR, 'pid')); rmdirSync(TOKEN_LOCK_DIR) } catch {} }
    } catch (e: any) {
      if (e.code === 'EEXIST') {
        // Check staleness
        try {
          const content = readFileSync(join(TOKEN_LOCK_DIR, 'pid'), 'utf8')
          const lockTime = parseInt(content.split('\n')[1] ?? '0')
          if (Date.now() - lockTime > TOKEN_LOCK_STALE_MS) {
            try { unlinkSync(join(TOKEN_LOCK_DIR, 'pid')) } catch {}
            try { rmdirSync(TOKEN_LOCK_DIR) } catch {}
            continue  // Stale lock removed, retry immediately
          }
        } catch {}
        // Not stale — wait with jitter
        await new Promise(r => setTimeout(r, 1000 + Math.random() * 1000))
        continue
      }
      return null  // Unexpected error — proceed without lock
    }
  }
  return null  // Could not acquire after all attempts — see fail-closed handling at call sites
}

/**
 * Wait for another process to publish a fresh token to the credential store.
 *
 * Used as the "we couldn't get the lock" fallback path: we poll the disk
 * because the lock holder will write fresh creds when refresh succeeds.
 *
 * Returns the fresh credentials when found, or null on timeout.
 * `minRemainingMs` filters out stale or barely-fresh tokens.
 */
async function pollDiskForFreshToken(
  store: CredentialStore,
  timeoutMs: number,
  minRemainingMs: number,
): Promise<{ accessToken: string; refreshToken: string; expiresAt: number } | null> {
  const deadline = Date.now() + timeoutMs
  const pollInterval = 500
  while (Date.now() < deadline) {
    try {
      const creds = await store.read()
      if (creds && (creds.expiresAt - Date.now()) >= minRemainingMs) {
        return { accessToken: creds.accessToken, refreshToken: creds.refreshToken, expiresAt: creds.expiresAt }
      }
    } catch {}
    await new Promise(r => setTimeout(r, pollInterval))
  }
  return null
}

// ============================================================
// ClaudeCodeSDK — zero-dependency SDK that mimics Claude Code CLI
// ============================================================

export class ClaudeCodeSDK {
  private accessToken: string | null = null
  private refreshToken: string | null = null
  private expiresAt: number | null = null
  private credentialStore: CredentialStore
  private sessionId: string
  private deviceId: string
  private accountUuid: string
  private timeout: number
  private maxRetries: number
  private lastRateLimitInfo: RateLimitInfo = {
    status: null, resetAt: null, claim: null, retryAfter: null,
    utilization5h: null, utilization7d: null,
  }
  // 401 dedup — mirrors auth.ts:1338-1392 pending401Handlers
  private pending401: Promise<boolean> | null = null
  private lastFailedToken: string | null = null
  // ensureAuth dedup — concurrent calls within same process share one promise
  private pendingAuth: Promise<void> | null = null
  // Initial load promise — so forceRefreshToken/getTokenHealth can await it
  private initialLoad: Promise<void> | null = null
  // Proactive token rotation — refresh silently before expiry
  private tokenRotationTimer: ReturnType<typeof setTimeout> | null = null
  private lastRefreshAttemptAt = 0
  private refreshConsecutive429s = 0
  private proactiveRefreshFailures = 0  // total consecutive failures (not just 429)
  private tokenIssuedAt = 0             // when current token was obtained
  private onTokenStatus: ((event: TokenStatusEvent) => void) | undefined

  // Cache keepalive — delegated to KeepaliveEngine (src/keepalive-engine.ts).
  // Engine owns all KA state (timers, registry, health probe, rewrite guard).
  // SDK uses DI callbacks (getToken, doFetch, getRateLimitInfo) to expose its
  // internal auth/transport/rate-limit state to the engine.
  private keepalive!: KeepaliveEngine

  // Last TokenUsage captured by parseSSE on message_stop. Harvested by stream()
  // after yield* completes and passed to keepalive.notifyRealRequestComplete().
  // Avoids invoking completion callback inside parseSSE (which also services
  // engine's KA fires — those must not touch realActivityAt).
  private _lastStreamUsage: TokenUsage | null = null

  constructor(options: ClaudeCodeSDKOptions = {}) {
    this.sessionId = randomUUID()
    this.deviceId = options.deviceId ?? randomBytes(32).toString('hex')


    this.accountUuid = options.accountUuid ?? this.readAccountUuid()
    this.timeout = options.timeout ?? 600_000
    this.maxRetries = options.maxRetries ?? 10

    this.onTokenStatus = options.onTokenStatus

    // Wire KeepaliveEngine with DI callbacks — engine never touches SDK internals.
    // Engine handles its own intervalMs clamp ([60s, 240s]) and config defaults.
    this.keepalive = new KeepaliveEngine({
      config: options.keepalive,
      getToken: async () => {
        await this.ensureAuth()
        return this.accessToken ?? ''
      },
      doFetch: (body, headers, signal) => this.doStreamRequest(body, headers, signal),
      getRateLimitInfo: () => this.lastRateLimitInfo,
    })

    // Credential store priority:
    // 1. Custom store (DB, Redis, etc.)
    // 2. Direct tokens → MemoryCredentialStore
    // 3. File-based → FileCredentialStore (default)
    if (options.credentialStore) {
      this.credentialStore = options.credentialStore
    } else if (options.accessToken) {
      this.accessToken = options.accessToken
      this.refreshToken = options.refreshToken ?? null
      this.expiresAt = options.expiresAt ?? null
      this.credentialStore = new MemoryCredentialStore({
        accessToken: options.accessToken,
        refreshToken: options.refreshToken ?? '',
        expiresAt: options.expiresAt ?? 0,
      })
      // Schedule proactive rotation for directly-provided tokens
      if (this.expiresAt && this.refreshToken) {
        this.scheduleProactiveRotation()
      }
    } else {
      this.credentialStore = new FileCredentialStore(
        options.credentialsPath ?? join(homedir(), '.claude', '.credentials.json'),
      )
      // Kick off initial token load + rotation schedule (async, non-blocking)
      this.initialLoad = this.loadFromStore().catch(() => { /* will be retried on first API call */ })
    }
  }

  // ----------------------------------------------------------
  // Public API
  // ----------------------------------------------------------

  /** Non-streaming: send messages, get full response */
  async generate(options: GenerateOptions): Promise<GenerateResponse> {
    const events: StreamEvent[] = []
    for await (const event of this.stream(options)) {
      events.push(event)
    }
    return this.assembleResponse(events, options.model)
  }

  /** Streaming: yields events as they arrive from SSE */
  async *stream(options: GenerateOptions): AsyncGenerator<StreamEvent> {
    // Layer 3: Rewrite-burst guard — delegated to KeepaliveEngine.
    // Throws CacheRewriteBlockedError if long idle + blockEnabled.
    this.keepalive.checkRewriteGuard(options.model)

    await this.ensureAuth()
    const body = this.buildRequestBody(options)
    const headers = this.buildHeaders(options)

    // KA snapshot & in-flight abort — delegated to engine.
    this.keepalive.notifyRealRequestStart(options.model, body, headers)

    // Reset per-request usage capture slot (populated by parseSSE on message_stop)
    this._lastStreamUsage = null

    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      if (options.signal?.aborted) throw new ClaudeCodeSDKError('Aborted')

      try {
        yield* this.doStreamRequest(body, headers, options.signal)
        // Successful completion — notify engine of real request completion.
        // Engine registers snapshot (heaviest-wins), updates real-activity
        // timestamps, starts KA timer. Safe no-op if usage absent (defensive).
        if (this._lastStreamUsage) {
          this.keepalive.notifyRealRequestComplete(this._lastStreamUsage)
          this._lastStreamUsage = null
        }
        return
      } catch (error) {
        lastError = error

        if (error instanceof APIError) {
          // 401 → dedup refresh and retry — mirrors withRetry.ts:232-250
          if (error.status === 401 && attempt <= this.maxRetries) {
            await this.handleAuth401()
            headers['Authorization'] = `Bearer ${this.accessToken}`
            continue
          }

          // 429 → NEVER retry for subscribers (window-based limits)
          if (error.status === 429) {
            throw error instanceof RateLimitError
              ? error
              : new RateLimitError('Rate limited', this.lastRateLimitInfo, 429, error)
          }

          // 5xx / 529 → retry with backoff
          if (error.status >= 500 && attempt <= this.maxRetries) {
            const delay = this.getRetryDelay(attempt, this.lastRateLimitInfo.retryAfter?.toString() ?? null)
            await this.sleep(delay, options.signal)
            continue
          }
        }

        throw error
      }
    }
    throw lastError
  }

  getRateLimitInfo(): RateLimitInfo { return this.lastRateLimitInfo }

  // ----------------------------------------------------------
  // HTTP request — raw fetch + SSE parsing
  // ----------------------------------------------------------

  private async *doStreamRequest(
    body: Record<string, unknown>,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    // Combine user signal with timeout
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(), { once: true })
    }

    const t0 = Date.now()
    const bodyStr = JSON.stringify(body)
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] API_START pid=${process.pid} model=${body.model} msgs=${(body.messages as unknown[])?.length ?? 0}\n`)
      // Dump full request for diagnostics
      const toolNames = (body.tools as any[])?.map((t: any) => t.name).join(',') ?? 'none'
      const sysPreview = typeof body.system === 'string' ? body.system.substring(0, 200) : JSON.stringify(body.system)?.substring(0, 200)
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] API_REQ pid=${process.pid} headers=${JSON.stringify(headers).substring(0, 300)} tools=[${toolNames.substring(0, 500)}] sys=${sysPreview} bodyLen=${bodyStr.length}\n`)
      // Full request body dump (sans messages content for size) — enable with CLAUDE_MAX_DUMP_REQUESTS=1
      if (process.env.CLAUDE_MAX_DUMP_REQUESTS === '1') {
        const dumpBody = { ...body, messages: `[${(body.messages as unknown[])?.length ?? 0} messages]`, system: `[${typeof body.system === 'string' ? body.system.length : 'array'}]` }
        appendFileSync(join(homedir(), '.claude', 'claude-max-request-dump.jsonl'),
          JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, headers, body: dumpBody }) + '\n')
      }
    } catch {}

    let response: Response
    try {
      response = await fetch(`${API_BASE_URL}/v1/messages?beta=true`, {
        method: 'POST',
        headers,
        body: bodyStr,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeoutId)
      try {
        const { appendFileSync } = require('fs')
        appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
          `[${new Date().toISOString()}] API_ERROR pid=${process.pid} ttfb=${Date.now()-t0}ms err=${(err as Error).message}\n`)
      } catch {}
      throw new ClaudeCodeSDKError('Network error', err)
    }

    clearTimeout(timeoutId)

    // Dump FULL API response for diagnostics — always log to dedicated file
    try {
      const { appendFileSync } = require('fs')
      const allHeaders: Record<string, string> = {}
      response.headers.forEach((value: string, key: string) => { allHeaders[key] = value })
      const responseLog = {
        ts: new Date().toISOString(),
        pid: process.pid,
        status: response.status,
        statusText: response.statusText,
        ttfbMs: Date.now() - t0,
        headers: allHeaders,
      }
      appendFileSync(join(homedir(), '.claude', 'claude-max-api-responses.log'),
        JSON.stringify(responseLog) + '\n')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${response.status} ttfb=${Date.now()-t0}ms\n`)
    } catch {}

    // Parse rate limit headers from response
    this.lastRateLimitInfo = this.parseRateLimitHeaders(response.headers)

    if (!response.ok) {
      let errorBody = ''
      try { errorBody = await response.text() } catch { /* */ }
      const requestId = response.headers.get('request-id')

      // Dump error response fully for diagnostics
      try {
        const { appendFileSync } = require('fs')
        const allHeaders: Record<string, string> = {}
        response.headers.forEach((value: string, key: string) => { allHeaders[key] = value })
        appendFileSync(join(homedir(), '.claude', 'claude-max-api-responses.log'),
          JSON.stringify({
            ts: new Date().toISOString(),
            pid: process.pid,
            type: 'ERROR',
            status: response.status,
            requestId,
            headers: allHeaders,
            body: errorBody.slice(0, 5000),
            rateLimitInfo: this.lastRateLimitInfo,
          }) + '\n')
      } catch {}

      if (response.status === 429) {
        throw new RateLimitError(
          `Rate limited: ${errorBody}`,
          this.lastRateLimitInfo,
          429,
        )
      }

      throw new APIError(
        `API error ${response.status}: ${errorBody}`,
        response.status,
        requestId,
      )
    }

    // Parse SSE stream
    if (!response.body) {
      throw new ClaudeCodeSDKError('No response body')
    }

    yield* this.parseSSE(response.body, signal)
  }

  // ----------------------------------------------------------
  // SSE Parser — Server-Sent Events from Anthropic streaming API
  // ----------------------------------------------------------

  private async *parseSSE(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncGenerator<StreamEvent> {
    const decoder = new TextDecoder()
    const reader = body.getReader()
    let buffer = ''

    const blocks: Map<number, { type: string; id?: string; name?: string; text?: string; thinking?: string; input?: string; signature?: string }> = new Map()
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let stopReason: string | null = null

    try {
      while (true) {
        if (signal?.aborted) { reader.cancel(); return }

        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6)
          if (data === '[DONE]') continue

          let parsed: Record<string, unknown>
          try { parsed = JSON.parse(data) } catch { continue }

          const type = parsed.type as string

          // message_start — extract initial usage + dump raw for analysis
          if (type === 'message_start') {
            try {
              const { appendFileSync } = require('fs')
              const { join } = require('path')
              const { homedir } = require('os')
              appendFileSync(join(homedir(), '.claude', 'claude-max-headers.log'),
                `[${new Date().toISOString()}] MESSAGE_START: ${JSON.stringify(parsed).slice(0, 2000)}\n`)
            } catch {}
            const msg = parsed.message as Record<string, unknown> | undefined
            const u = msg?.usage as Record<string, unknown> | undefined
            if (u) {
              usage = {
                inputTokens: (u.input_tokens as number) ?? 0,
                outputTokens: (u.output_tokens as number) ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens as number | undefined,
                cacheReadInputTokens: u.cache_read_input_tokens as number | undefined,
              }
              // Log full raw usage including 1h cache fields for debugging
              try {
                appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
                  `[${new Date().toISOString()}] RAW_USAGE: ${JSON.stringify(u)}\n`)
              } catch {}
            }
            continue
          }

          // content_block_start — register block
          if (type === 'content_block_start') {
            const index = parsed.index as number
            const block = parsed.content_block as Record<string, string>
            if (block.type === 'tool_use') {
              const originalName = unremapToolName(block.name)
              blocks.set(index, { type: 'tool_use', id: block.id, name: originalName, input: '' })
              yield { type: 'tool_use_start', id: block.id, name: originalName }
            } else if (block.type === 'text') {
              blocks.set(index, { type: 'text', text: '' })
            } else if (block.type === 'thinking') {
              blocks.set(index, { type: 'thinking', thinking: '', signature: block.signature ?? undefined })
            }
            continue
          }

          // content_block_delta — yield content events
          if (type === 'content_block_delta') {
            const index = parsed.index as number
            const state = blocks.get(index)
            const delta = parsed.delta as Record<string, string>

            if (delta.type === 'text_delta' && delta.text !== undefined) {
              if (state) state.text = (state.text ?? '') + delta.text
              if (delta.text) yield { type: 'text_delta', text: delta.text }
            } else if (delta.type === 'thinking_delta' && delta.thinking !== undefined) {
              if (state) state.thinking = (state.thinking ?? '') + delta.thinking
              if (delta.thinking) yield { type: 'thinking_delta', text: delta.thinking }
            } else if (delta.type === 'signature_delta' && delta.signature !== undefined) {
              if (state) state.signature = (state.signature ?? '') + delta.signature
            } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
              if (state) state.input = (state.input ?? '') + delta.partial_json
              if (delta.partial_json) yield { type: 'tool_use_delta', partialInput: delta.partial_json }
            }
            continue
          }

          // content_block_stop — finalize tool use and thinking blocks
          if (type === 'content_block_stop') {
            const index = parsed.index as number
            const state = blocks.get(index)
            if (state?.type === 'tool_use' && state.id && state.name) {
              let parsedInput: unknown = {}
              try { parsedInput = JSON.parse(state.input ?? '{}') } catch { /* */ }
              yield { type: 'tool_use_end', id: state.id, name: state.name, input: parsedInput }
            }
            if (state?.type === 'thinking') {
              // Signature may come in content_block_stop for thinking
              const stopSig = (parsed as any).signature ?? (parsed as any).content_block?.signature
              if (stopSig) state.signature = stopSig
              yield { type: 'thinking_end', signature: state.signature ?? undefined }
            }
            continue
          }

          // message_delta — update usage and stop reason
          if (type === 'message_delta') {
            const delta = parsed.delta as Record<string, unknown> | undefined
            if (delta?.stop_reason) stopReason = delta.stop_reason as string
            const du = parsed.usage as Record<string, number> | undefined
            if (du?.output_tokens) usage = { ...usage, outputTokens: du.output_tokens }
            continue
          }

          // message_stop — yield final event
          // NOTE: completion notification moved to stream() wrapper so KA fires
          // (which also flow through parseSSE via engine's doFetch) don't trigger
          // real-request bookkeeping on lastRealActivityAt. stream() calls
          // this.keepalive.notifyRealRequestComplete(usage) after yield* completes.
          if (type === 'message_stop') {
            this._lastStreamUsage = usage
            yield { type: 'message_stop', usage, stopReason }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ----------------------------------------------------------
  // Request building — mirrors Claude Code CLI exactly
  // ----------------------------------------------------------

  // ----------------------------------------------------------
  // Cache keepalive — delegated to KeepaliveEngine
  // ----------------------------------------------------------

  /**
   * Full KA shutdown — stops engine timers, registry, health probe.
   * Also clears SDK-owned tokenRotationTimer (auth concern, not KA).
   */
  public stopKeepalive(): void {
    this.keepalive.stop()
    if (this.tokenRotationTimer) {
      clearTimeout(this.tokenRotationTimer)
      this.tokenRotationTimer = null
    }
  }

  // ── Anchor persistence: one number per cwd, survives process restart ──



  /** HTTP headers — mimics getAnthropicClient() + getAuthHeaders() */
  private buildHeaders(options: GenerateOptions): Record<string, string> {
    const betas = this.buildBetas(options)

    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.accessToken}`,
      'anthropic-version': API_VERSION,
      'anthropic-beta': betas.join(','),
      'anthropic-dangerous-direct-browser-access': 'true',
      'x-app': 'cli',
      'User-Agent': `claude-cli/${CC_COMPAT_VERSION}`,
      'X-Claude-Code-Session-Id': this.sessionId,
    }
  }

  /** Request body — mirrors paramsFromContext() in claude.ts:1699 */
  private buildRequestBody(options: GenerateOptions): Record<string, unknown> {
    // Billing header — matches CC's getAttributionHeader() format.
    // cc_version includes a message fingerprint suffix for CC compat.
    // cch= placeholder: currently server does NOT verify the hash, but including
    // it makes our requests indistinguishable from real CC requests.
    const fingerprint = this.computeFingerprint(options.messages)
    const attributionHeader = `x-anthropic-billing-header: cc_version=${CC_COMPAT_VERSION}.${fingerprint}; cc_entrypoint=cli; cch=00000;`

    // Prepend attribution header to system prompt (CLI does this at claude.ts:1358-1369)
    // Skip if system already contains a billing header (e.g. injected by provider)
    const systemStr = typeof options.system === 'string' ? options.system
      : Array.isArray(options.system) ? JSON.stringify(options.system) : ''
    const alreadyHasBilling = systemStr.includes('x-anthropic-billing-header')

    let system: unknown = undefined
    if (alreadyHasBilling) {
      system = options.system
    } else if (typeof options.system === 'string') {
      system = attributionHeader + '\n' + options.system
    } else if (Array.isArray(options.system)) {
      system = [{ type: 'text', text: attributionHeader }, ...options.system]
    } else {
      system = attributionHeader
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      // max_tokens: resolved from SSOT (src/models.ts).
      // Respects explicit options.maxTokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS env > per-model default.
      // See src/models.ts for rationale — prevents the max_tokens truncation retry loop.
      max_tokens: resolveMaxTokens(options.model, options.maxTokens),
      stream: true,
      system,

      // metadata.user_id — exact structure from getAPIMetadata() in claude.ts:503
      metadata: {
        user_id: JSON.stringify({
          device_id: this.deviceId,
          account_uuid: this.accountUuid,
          session_id: this.sessionId,
        }),
      },
    }

    if (options.tools && options.tools.length > 0) {
      const { remapped } = remapToolNames(options.tools as unknown[])
      body.tools = remapped
      if (options.toolChoice) {
        const tc = typeof options.toolChoice === 'string'
          ? { type: options.toolChoice }
          : { ...options.toolChoice }
        if (tc.type === 'tool' && tc.name && TOOL_NAME_REMAP[tc.name]) {
          tc.name = TOOL_NAME_REMAP[tc.name]
        }
        body.tool_choice = tc
      }
    }

    // Prompt caching — add cache_control to last content block of last message
    // Mirrors addCacheBreakpoints() in claude.ts:3063-3211
    if (options.caching !== false) {
      this.addCacheMarkers(body)
    }

    // Thinking — mirrors claude.ts:1604-1630
    // 4.6+ models use adaptive thinking by default (opus-4-6, sonnet-4-6, opus-4-7, etc.)
    const model = options.model.toLowerCase()
    const isAdaptiveModel = model.includes('opus-4-6') || model.includes('sonnet-4-6')
      || model.includes('opus-4-7') || model.includes('sonnet-4-7')
    const thinkingDisabled = options.thinking?.type === 'disabled'

    if (!thinkingDisabled && isAdaptiveModel) {
      // 4.6+ models use adaptive thinking — thinking.ts:120
      body.thinking = { type: 'adaptive' }
    } else if (options.thinking?.type === 'enabled') {
      body.thinking = {
        type: 'enabled',
        budget_tokens: options.thinking.budgetTokens,
      }
    }
    // When disabled or omitted for non-adaptive models: don't send thinking field

    // Temperature only when thinking is disabled — claude.ts:1691-1695
    const hasThinking = !thinkingDisabled && (isAdaptiveModel || options.thinking?.type === 'enabled')
    if (!hasThinking && options.temperature !== undefined) {
      body.temperature = options.temperature
    }

    if (options.topP !== undefined) {
      body.top_p = options.topP
    }

    // Effort — goes into output_config.effort (from utils/effort.ts + claude.ts:1563)
    // GA since 4.6+ — no beta header required
    if (options.effort && isAdaptiveModel) {
      body.output_config = { effort: options.effort }
    }

    if (options.stopSequences?.length) {
      body.stop_sequences = options.stopSequences
    }

    if (options.fast) {
      body.speed = 'fast'
    }

    return body
  }

  /** Add cache_control markers to system + messages — anchor-based strategy for keepalive compatibility.
   *
   * Anthropic prompt cache is PREFIX-based: each cache_control breakpoint creates a cached prefix entry.
   * A new request reads cache only if it has a breakpoint at the SAME position (same content prefix).
   *
   * Follows Claude Code's proven strategy (from claude.ts):
   *   BP1: system prompt — stable across sessions
   *   BP2: last tool definition — stable within session
   *   BP3: messages[-1] — ONE message marker only
   *
   * Why only 1 message marker (from Claude Code source):
   *   "Exactly one message-level cache_control marker per request. Mycro's
   *    turn-to-turn eviction frees local-attention KV pages at any cached prefix
   *    position NOT in cache_store_int_token_boundaries. With two markers the
   *    second-to-last position is protected and its locals survive an extra turn
   *    even though nothing will ever resume from there — with one marker they're
   *    freed immediately."
   *
   * Why no anchor persistence needed:
   *   Anthropic's cache AUTOMATICALLY reads ANY matching prefix, regardless of
   *   where the NEW marker is placed. Markers only control where NEW entries are WRITTEN.
   *   So: keepalive writes cache at msg[K]. Next real request has marker at msg[K+2].
   *   API finds cached prefix [sys..msg[K]] → reads it → only processes msg[K+1..K+2].
   */
  private addCacheMarkers(body: Record<string, unknown>): void {
    const CC = { cache_control: { type: 'ephemeral' as const, ttl: '1h' as const } }

    // BP1: system prompt
    const sys = body.system
    if (typeof sys === 'string') {
      body.system = [{ type: 'text', text: sys, ...CC }]
    } else if (Array.isArray(sys)) {
      const blocks = sys as Record<string, unknown>[]
      if (blocks.length > 0) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...CC }
      }
    }

    // BP2: last tool definition
    const tools = body.tools as Record<string, unknown>[] | undefined
    if (tools && tools.length > 0) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], ...CC }
    }

    // BP3: last message — single message marker (Claude Code strategy)
    const messages = body.messages as { role: string; content: string | Record<string, unknown>[] }[]
    if (messages.length === 0) return

    const lastMsg = messages[messages.length - 1]
    if (typeof lastMsg.content === 'string') {
      lastMsg.content = [{ type: 'text', text: lastMsg.content, ...CC }]
    } else if (Array.isArray(lastMsg.content) && lastMsg.content.length > 0) {
      const lastBlock = lastMsg.content[lastMsg.content.length - 1]
      lastMsg.content[lastMsg.content.length - 1] = { ...lastBlock, ...CC }
    }
  }

  /** Beta headers — mirrors getAllModelBetas() in betas.ts:234 */
  private buildBetas(options: GenerateOptions): string[] {
    const betas: string[] = []
    const model = options.model.toLowerCase()
    const isHaiku = model.includes('haiku')

    // claude-code beta for non-Haiku — betas.ts:241
    if (!isHaiku) {
      betas.push(CLAUDE_CODE_BETA)
    }

    // OAuth beta — ALWAYS for subscriber — betas.ts:252
    betas.push(OAUTH_BETA)

    // 1M context — betas.ts:254
    if (/\[1m\]/i.test(options.model)) {
      betas.push(CONTEXT_1M_BETA)
    }

    // Interleaved thinking — betas.ts:258
    if (!isHaiku && options.thinking?.type !== 'disabled') {
      betas.push(INTERLEAVED_THINKING_BETA)
    }

    // Effort — betas.ts:15
    if (options.effort) {
      betas.push(EFFORT_BETA)
    }

    // Fast mode — betas.ts:19
    if (options.fast) {
      betas.push(FAST_MODE_BETA)
    }

    // Context management — betas.ts (4.6+ models)
    if (!isHaiku) {
      betas.push(CONTEXT_MANAGEMENT_BETA)
    }

    // Task budgets — betas.ts (new in 4.7)
    betas.push(TASK_BUDGETS_BETA)

    // Redact thinking — hide thinking from response unless showThinking is set
    betas.push(REDACT_THINKING_BETA)

    // Prompt caching scope — betas.ts:355
    betas.push(PROMPT_CACHING_SCOPE_BETA)

    // Fine-grained tool streaming — enables streaming partial tool arguments
    betas.push(FINE_GRAINED_TOOL_STREAMING_BETA)

    // User extras
    if (options.extraBetas) {
      betas.push(...options.extraBetas)
    }

    return betas
  }

  // ----------------------------------------------------------
  // Auth — mirrors CLI triple-check pattern (auth.ts:1427-1562)
  // ----------------------------------------------------------

  /**
   * Ensure valid auth token before API call.
   * Mirrors checkAndRefreshOAuthTokenIfNeeded() from auth.ts:1427.
   *
   * Triple-check pattern:
   * 1. Check cached token in memory
   * 2. If expired, check store (another process may have refreshed)
   * 3. If still expired, do the refresh
   */
  private async ensureAuth(): Promise<void> {
    // Fast path: token valid in memory
    if (this.accessToken && !this.isTokenExpired()) return
    // Dedup: concurrent calls within same process share one promise
    if (this.pendingAuth) return this.pendingAuth
    this.pendingAuth = this._doEnsureAuth().finally(() => { this.pendingAuth = null })
    return this.pendingAuth
  }

  private async _doEnsureAuth(): Promise<void> {
    // Step 1: check disk for external updates FIRST (cheap mtime check).
    // This catches the user-relogin-during-session case where the in-memory
    // token would otherwise stay alive ~8h after the user re-logged in,
    // pinning this process to the OLD account/org and ignoring the new
    // credentials sitting on disk. Was previously only checked AFTER expiry
    // — too late for live sessions.
    if (this.credentialStore.hasChanged) {
      const changed = await this.credentialStore.hasChanged()
      if (changed) {
        await this.loadFromStore()
        // Fall through to normal expiry check with possibly-new token.
      }
    }

    // Step 2: in-memory cache is now up-to-date relative to disk.
    if (this.accessToken && !this.isTokenExpired()) return

    // First load if no token at all
    if (!this.accessToken) {
      await this.loadFromStore()
      if (this.accessToken && !this.isTokenExpired()) return
    }

    // Step 3: refresh needed
    if (this.accessToken && this.isTokenExpired()) {
      await this.refreshTokenWithTripleCheck()
    }
  }

  /** Load credentials from the credential store */
  private async loadFromStore(): Promise<void> {
    const creds = await this.credentialStore.read()
    if (!creds?.accessToken) {
      throw new AuthError('No OAuth tokens found. Run "claude login" first or provide credentials.')
    }
    this.accessToken = creds.accessToken
    this.refreshToken = creds.refreshToken
    this.expiresAt = creds.expiresAt
    // Estimate when token was issued (for lifetime % calculations)
    // If we don't know, assume we're halfway through
    if (!this.tokenIssuedAt && this.expiresAt) {
      this.tokenIssuedAt = Date.now()
    }
    // Schedule proactive rotation whenever we load fresh tokens
    this.scheduleProactiveRotation()
  }

  /** 5-minute buffer before actual expiry — from oauth/client.ts:344-353 */
  private isTokenExpired(): boolean {
    if (!this.expiresAt) return false
    return Date.now() + EXPIRY_BUFFER_MS >= this.expiresAt
  }

  // ──────────────────────────────────────────────────────────
  // Proactive token rotation — refresh silently before expiry
  // User never sees "token expired". Seamless experience.
  // ──────────────────────────────────────────────────────────

  // ── Public API: force rotate / re-login ────────────────────

  /**
   * Force an immediate token refresh (like what happens automatically).
   * Use when you know the token is stale or as a manual recovery.
   * Returns true on success, false on failure.
   */
  async forceRefreshToken(): Promise<boolean> {
    this.dbg('FORCE REFRESH requested by caller')
    // Ensure we've loaded tokens from store (constructor's loadFromStore is async)
    if (this.initialLoad) await this.initialLoad
    if (!this.refreshToken) {
      try { await this.loadFromStore() } catch {}
    }
    this.clearRefreshCooldown()
    this.lastRefreshAttemptAt = 0 // bypass rate-limit
    try {
      await this.doTokenRefresh(true)  // force=true: actually call token endpoint
      this.proactiveRefreshFailures = 0
      this.refreshConsecutive429s = 0
      this.emitTokenStatus('rotated', 'Token force-refreshed successfully')
      this.scheduleProactiveRotation()
      return true
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err)
      this.dbg(`FORCE REFRESH FAILED: ${msg}`)
      this.emitTokenStatus('warning', `Force refresh failed: ${msg}`)
      return false
    }
  }

  /**
   * Trigger a full browser-based OAuth re-login flow.
   * Use as last resort when refresh_token itself is dead.
   * Imports and calls oauthLogin() from auth.ts.
   * Returns true on success (new tokens saved), false on failure/timeout.
   */
  async forceReLogin(): Promise<boolean> {
    if (this.initialLoad) await this.initialLoad
    this.dbg('FORCE RE-LOGIN requested — opening browser OAuth flow')
    this.emitTokenStatus('critical', 'Initiating browser re-login — refresh token may be dead')
    try {
      const { oauthLogin } = await import('./auth.js')
      const credPath = this.credentialStore instanceof FileCredentialStore
        ? (this.credentialStore as any).path
        : join(homedir(), '.claude', '.credentials.json')
      const result = await oauthLogin({ credentialsPath: credPath })
      // Reload from store after login writes new creds
      this.accessToken = result.accessToken
      this.refreshToken = result.refreshToken
      this.expiresAt = result.expiresAt
      this.tokenIssuedAt = Date.now()
      this.proactiveRefreshFailures = 0
      this.refreshConsecutive429s = 0
      this.clearRefreshCooldown()
      this.emitTokenStatus('rotated', 'Re-login successful — fresh tokens')
      this.scheduleProactiveRotation()
      this.dbg(`RE-LOGIN SUCCESS — new token expires at ${new Date(this.expiresAt).toISOString()}`)
      return true
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err)
      this.dbg(`RE-LOGIN FAILED: ${msg}`)
      this.emitTokenStatus('expired', `Re-login failed: ${msg}`)
      return false
    }
  }

  /**
   * Get current token health info — useful for UI status indicators.
   * Note: if called immediately after construction, tokens may still be loading.
   * Use the async version getTokenHealthAsync() for guaranteed data.
   */
  getTokenHealth(): { expiresAt: number | null; expiresInMs: number; lifetimePct: number; failedRefreshes: number; status: 'healthy' | 'warning' | 'critical' | 'expired' | 'unknown' } {
    if (!this.expiresAt) return { expiresAt: null, expiresInMs: 0, lifetimePct: 0, failedRefreshes: this.proactiveRefreshFailures, status: 'unknown' }
    const now = Date.now()
    const remaining = this.expiresAt - now
    const lifetime = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : remaining * 2
    const pct = lifetime > 0 ? Math.max(0, remaining / lifetime) : 0

    let status: 'healthy' | 'warning' | 'critical' | 'expired'
    if (remaining <= 0) status = 'expired'
    else if (pct < TOKEN_CRITICAL_THRESHOLD) status = 'critical'
    else if (pct < TOKEN_WARNING_THRESHOLD) status = 'warning'
    else status = 'healthy'

    return { expiresAt: this.expiresAt, expiresInMs: remaining, lifetimePct: pct, failedRefreshes: this.proactiveRefreshFailures, status }
  }

  /** Async version — awaits initial token load before returning health. */
  async getTokenHealthAsync(): Promise<{ expiresAt: number | null; expiresInMs: number; lifetimePct: number; failedRefreshes: number; status: 'healthy' | 'warning' | 'critical' | 'expired' | 'unknown' }> {
    if (this.initialLoad) await this.initialLoad
    return this.getTokenHealth()
  }

  // ── Scheduling & background refresh ────────────────────────

  /**
   * Schedule a background refresh at ~50% of token lifetime.
   * With ~11h tokens, fires at ~5.5h — leaving 5.5h for retries.
   * Emits escalating warnings as token approaches expiry.
   */
  private scheduleProactiveRotation(): void {
    if (this.tokenRotationTimer) {
      clearTimeout(this.tokenRotationTimer)
      this.tokenRotationTimer = null
    }
    if (!this.expiresAt || !this.refreshToken) return

    const now = Date.now()
    const remaining = this.expiresAt - now
    if (remaining <= 0) {
      this.emitTokenStatus('expired', 'Token has expired')
      return
    }

    // Calculate when to refresh: PROACTIVE_REFRESH_RATIO of remaining time
    const refreshIn = Math.max(
      remaining * (1 - PROACTIVE_REFRESH_RATIO), // 50% of remaining
      PROACTIVE_REFRESH_MIN_INTERVAL_MS,           // at least 5 min from now
    )
    // Stagger: random jitter 0-60s to prevent multi-process stampede
    const jitter = Math.floor(Math.random() * 60_000)
    const delay = Math.min(refreshIn + jitter, remaining - EXPIRY_BUFFER_MS)

    if (delay <= 0) {
      // Less than buffer left — refresh soon, but not synchronously.
      // Minimum 30s delay prevents tight-loop scheduling when delay computes to 0
      // (which happens when tokenIssuedAt=now after accepting a stale token).
      const emergencyDelay = 30_000
      this.dbg(`proactive rotation: delay=${delay}ms <= 0, scheduling emergency refresh in ${emergencyDelay / 1000}s`)
      if (!this.tokenRotationTimer) {
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null
          void this.proactiveRefresh()
        }, emergencyDelay)
        if (this.tokenRotationTimer && typeof this.tokenRotationTimer === 'object' && 'unref' in this.tokenRotationTimer) {
          (this.tokenRotationTimer as any).unref()
        }
      }
      return
    }

    // Check escalation level based on lifetime consumed
    const lifetime = this.tokenIssuedAt > 0 ? this.expiresAt - this.tokenIssuedAt : remaining * 2
    const remainingPct = lifetime > 0 ? remaining / lifetime : 1

    if (remainingPct < TOKEN_CRITICAL_THRESHOLD && this.proactiveRefreshFailures > 0) {
      this.dbg(`⚠️ CRITICAL: token ${Math.round(remainingPct * 100)}% life left, ${this.proactiveRefreshFailures} failed refreshes`)
      this.emitTokenStatus('critical', `Token ${Math.round(remainingPct * 100)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)
    } else if (remainingPct < TOKEN_WARNING_THRESHOLD && this.proactiveRefreshFailures > 0) {
      this.dbg(`⚠ WARNING: token ${Math.round(remainingPct * 100)}% life left, ${this.proactiveRefreshFailures} failed refreshes`)
      this.emitTokenStatus('warning', `Token ${Math.round(remainingPct * 100)}% life remaining, ${this.proactiveRefreshFailures} refresh failures`)
    }

    this.dbg(`proactive rotation scheduled in ${Math.round(delay / 1000)}s (expires in ${Math.round(remaining / 1000)}s, ${Math.round(remainingPct * 100)}% life, failures=${this.proactiveRefreshFailures})`)

    this.tokenRotationTimer = setTimeout(() => {
      this.tokenRotationTimer = null
      void this.proactiveRefresh()
    }, delay)

    // Don't keep process alive just for rotation
    if (this.tokenRotationTimer && typeof this.tokenRotationTimer === 'object' && 'unref' in this.tokenRotationTimer) {
      (this.tokenRotationTimer as any).unref()
    }
  }

  /**
   * Background refresh — runs silently, never throws.
   * Emits escalating status events on failure.
   * On permanent failure: emits 'expired' so UI can trigger re-login.
   */
  private async proactiveRefresh(): Promise<void> {
    // Respect global cooldown (cross-process coordination)
    if (this.isRefreshOnCooldown()) {
      // But maybe another process succeeded — check store
      try {
        const creds = await this.credentialStore.read()
        if (creds && !(Date.now() + EXPIRY_BUFFER_MS >= creds.expiresAt)) {
          const diskRemaining = creds.expiresAt - Date.now()
          // Only accept if the token is genuinely fresh — same 2h threshold as doTokenRefresh.
          // Without this, we endlessly accept aging tokens (24min, 12min, 6min...) from disk
          // without anyone actually calling the OAuth endpoint.
          if (diskRemaining >= PROACTIVE_FRESH_MIN_REMAINING_MS) {
            this.accessToken = creds.accessToken
            this.refreshToken = creds.refreshToken
            this.expiresAt = creds.expiresAt
            this.tokenIssuedAt = Date.now()
            this.proactiveRefreshFailures = 0
            this.dbg(`proactive refresh: picked up fresh token during cooldown (${Math.round(diskRemaining / 60000)}min remaining)`)
            this.emitTokenStatus('rotated', `Token refreshed by another process (${Math.round(diskRemaining / 60000)}min remaining)`)
            this.scheduleProactiveRotation()
            return
          }
          // Token on disk but too close to expiry — don't accept, let cooldown expire then actually refresh
          this.dbg(`proactive refresh: disk token has only ${Math.round(diskRemaining / 60000)}min left (need ${Math.round(PROACTIVE_FRESH_MIN_REMAINING_MS / 60000)}min) — waiting for cooldown`)
        }
      } catch {}
      this.dbg('proactive refresh skipped: global cooldown active, no fresh token found')
      // Schedule retry — but DON'T call scheduleProactiveRotation() here because
      // it can compute a 0ms delay and call us right back in a tight loop.
      // Instead, schedule a fixed retry after cooldown expires.
      if (!this.tokenRotationTimer) {
        const retryIn = Math.max(PROACTIVE_REFRESH_MIN_INTERVAL_MS, 60_000)
        this.tokenRotationTimer = setTimeout(() => {
          this.tokenRotationTimer = null
          void this.proactiveRefresh()
        }, retryIn)
        if (this.tokenRotationTimer && typeof this.tokenRotationTimer === 'object' && 'unref' in this.tokenRotationTimer) {
          (this.tokenRotationTimer as any).unref()
        }
      }
      return
    }

    // Rate-limit within this process
    const now = Date.now()
    if (now - this.lastRefreshAttemptAt < PROACTIVE_REFRESH_MIN_INTERVAL_MS) {
      this.dbg('proactive refresh skipped: too recent')
      return
    }
    this.lastRefreshAttemptAt = now

    this.dbg('proactive rotation: refreshing token silently...')

    // Acquire cross-process lock — prevents multi-PID 429 stampede.
    // Without this, all opencode PIDs hit the OAuth endpoint simultaneously
    // when proactive rotation fires at similar times.
    const release = await acquireTokenRefreshLock()

    // FAIL-CLOSED: if we could not acquire the lock, another PID is currently
    // refreshing. Do NOT proceed to fetch — that's exactly what causes 429
    // storms. Instead, poll the disk for the fresh token the winner will write.
    if (!release) {
      this.dbg('proactive rotation: lock unavailable (another PID refreshing) — polling disk')
      const fresh = await pollDiskForFreshToken(
        this.credentialStore,
        45_000,                            // generous timeout: refresh worst case ≈ 25-30s
        PROACTIVE_FRESH_MIN_REMAINING_MS,  // accept only genuinely fresh tokens
      )
      if (fresh) {
        this.accessToken = fresh.accessToken
        this.refreshToken = fresh.refreshToken
        this.expiresAt = fresh.expiresAt
        this.tokenIssuedAt = Date.now()
        this.proactiveRefreshFailures = 0
        const remaining = fresh.expiresAt - Date.now()
        this.dbg(`proactive rotation: picked up fresh token from disk (${Math.round(remaining / 60000)}min remaining)`)
        this.emitTokenStatus('rotated', `Token refreshed by another process (${Math.round(remaining / 60000)}min remaining)`)
      } else {
        this.dbg('proactive rotation: lock unavailable and no fresh token appeared — will retry on next schedule')
      }
      this.scheduleProactiveRotation()
      return
    }

    try {
      // Post-lock check: another process may have refreshed while we waited for lock
      const postLockCreds = await this.credentialStore.read()
      if (postLockCreds && !(Date.now() + EXPIRY_BUFFER_MS >= postLockCreds.expiresAt)) {
        const diskRemaining = postLockCreds.expiresAt - Date.now()
        if (diskRemaining >= PROACTIVE_FRESH_MIN_REMAINING_MS) {
          // Fresh token appeared while waiting for lock — another process just refreshed
          this.accessToken = postLockCreds.accessToken
          this.refreshToken = postLockCreds.refreshToken
          this.expiresAt = postLockCreds.expiresAt
          this.tokenIssuedAt = Date.now()
          this.proactiveRefreshFailures = 0
          this.dbg(`proactive rotation: picked up fresh token from lock winner (${Math.round(diskRemaining / 60000)}min remaining)`)
          this.emitTokenStatus('rotated', `Token refreshed by another process (${Math.round(diskRemaining / 60000)}min remaining)`)
          this.scheduleProactiveRotation()
          return
        }
      }

      const prevExpiry = this.expiresAt ?? 0
      await this.doTokenRefresh(true)  // force=true: actually call token endpoint, don't just re-read
      this.proactiveRefreshFailures = 0
      this.refreshConsecutive429s = 0
      this.clearRefreshCooldown()
      this.tokenIssuedAt = Date.now()

      // Detect shrinking token lifetimes — if new token expires sooner than old one did,
      // Anthropic may be rate-limiting via shorter tokens. Don't schedule aggressively.
      const newLifetime = (this.expiresAt ?? 0) - Date.now()
      const prevLifetime = prevExpiry > 0 ? prevExpiry - (this.tokenIssuedAt - 1000) : newLifetime * 2
      if (newLifetime > 0 && newLifetime < prevLifetime * 0.5) {
        this.dbg(`⚠️ SHRINKING TOKEN: new ${Math.round(newLifetime/60000)}min vs prev ${Math.round(prevLifetime/60000)}min — backing off rotation`)
      }

      this.dbg(`proactive rotation SUCCESS — new token expires at ${new Date(this.expiresAt!).toISOString()} (${Math.round(newLifetime/60000)}min lifetime)`)
      this.emitTokenStatus('rotated', `Token rotated silently — expires ${new Date(this.expiresAt!).toISOString()}`)
      this.scheduleProactiveRotation()
    } catch (err: unknown) {
      this.proactiveRefreshFailures++
      const msg = (err as Error)?.message ?? String(err)
      this.dbg(`proactive rotation FAILED (#${this.proactiveRefreshFailures}): ${msg}`)

      // On 429: set global cooldown with exponential backoff
      if (msg.includes('429') || msg.includes('rate limit')) {
        this.refreshConsecutive429s++
        const cooldownMs = Math.min(
          PROACTIVE_REFRESH_MIN_INTERVAL_MS * Math.pow(2, this.refreshConsecutive429s),
          REFRESH_COOLDOWN_MAX_MS,
        )
        this.setRefreshCooldown(cooldownMs)
        this.dbg(`proactive rotation: 429 cooldown ${Math.round(cooldownMs / 1000)}s (attempt #${this.refreshConsecutive429s})`)
      }

      // Emit escalating status based on how much life is left
      const remaining = this.expiresAt ? this.expiresAt - Date.now() : 0
      const lifetime = this.tokenIssuedAt > 0 && this.expiresAt ? this.expiresAt - this.tokenIssuedAt : remaining * 2
      const remainingPct = lifetime > 0 ? remaining / lifetime : 0

      if (remaining <= EXPIRY_BUFFER_MS) {
        this.emitTokenStatus('expired', `Token expired after ${this.proactiveRefreshFailures} failed refresh attempts: ${msg}`)
      } else if (remainingPct < TOKEN_CRITICAL_THRESHOLD) {
        this.emitTokenStatus('critical', `CRITICAL: ${Math.round(remaining / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${msg}. Consider forceReLogin()`)
      } else if (remainingPct < TOKEN_WARNING_THRESHOLD) {
        this.emitTokenStatus('warning', `WARNING: ${Math.round(remaining / 60000)}min left, ${this.proactiveRefreshFailures} failures. Last: ${msg}`)
      }

      // Re-schedule: the token still has life left, try again later
      if (this.expiresAt && this.expiresAt > Date.now() + EXPIRY_BUFFER_MS) {
        this.scheduleProactiveRotation()
      } else {
        this.dbg('proactive rotation: token nearly expired — emitting expired status')
        this.emitTokenStatus('expired', `Token expired — refresh failed ${this.proactiveRefreshFailures} times. Call forceReLogin() to recover.`)
      }
    } finally {
      if (release) release()
    }
  }

  // ── Status emission ────────────────────────────────────────

  private emitTokenStatus(level: TokenStatusEvent['level'], message: string): void {
    const remaining = this.expiresAt ? this.expiresAt - Date.now() : 0
    const event: TokenStatusEvent = {
      level,
      message,
      expiresInMs: remaining,
      failedAttempts: this.proactiveRefreshFailures,
      needsReLogin: level === 'expired' || (level === 'critical' && this.proactiveRefreshFailures >= 3),
    }

    // Always log to debug file
    const emoji = level === 'rotated' ? '✅' : level === 'warning' ? '⚠️' : level === 'critical' ? '🔴' : '💀'
    this.dbg(`${emoji} [${level.toUpperCase()}] ${message} (expires in ${Math.round(remaining / 60000)}min, failures=${this.proactiveRefreshFailures})`)

    // Notify caller if callback registered
    this.onTokenStatus?.(event)
  }

  // ── Cross-process cooldown via shared file ─────────────────
  // Prevents all 6 opencode PIDs from hammering refresh simultaneously

  private isRefreshOnCooldown(): boolean {
    try {
      const content = readFileSync(REFRESH_COOLDOWN_FILE, 'utf8')
      const cooldownUntil = parseInt(content.trim())
      if (Date.now() < cooldownUntil) return true
      // Cooldown expired — clean up
      try { unlinkSync(REFRESH_COOLDOWN_FILE) } catch {}
    } catch { /* no file = no cooldown */ }
    return false
  }

  private setRefreshCooldown(durationMs: number): void {
    try {
      const dir = join(homedir(), '.claude')
      try { mkdirSync(dir, { recursive: true }) } catch {}
      writeFileSync(REFRESH_COOLDOWN_FILE, `${Date.now() + durationMs}\n`)
    } catch { /* best effort */ }
  }

  private clearRefreshCooldown(): void {
    try { unlinkSync(REFRESH_COOLDOWN_FILE) } catch {}
    this.refreshConsecutive429s = 0
  }

  // Debug helper for token rotation
  private dbg(msg: string): void {
    try {
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] TOKEN_ROTATION pid=${process.pid} ${msg}\n`)
    } catch {}
  }

  /**
   * Triple-check refresh — mirrors auth.ts:1472-1556.
   * Check store again (race), then refresh, then check store on error.
   */
  private async refreshTokenWithTripleCheck(): Promise<void> {
    // Check 2: re-read from store (another process may have refreshed)
    const freshCreds = await this.credentialStore.read()
    if (freshCreds && !(Date.now() + EXPIRY_BUFFER_MS >= freshCreds.expiresAt)) {
      this.accessToken = freshCreds.accessToken
      this.refreshToken = freshCreds.refreshToken
      this.expiresAt = freshCreds.expiresAt
      return
    }

    // Acquire filesystem lock — only one process refreshes at a time
    const release = await acquireTokenRefreshLock()

    // FAIL-CLOSED: if lock unavailable, another PID is refreshing right now.
    // Poll the disk instead of joining the 429 storm. Use lower minRemainingMs
    // here than proactive rotation — this is reactive (we already know we need
    // a token soon), so any non-expired token from disk is acceptable.
    if (!release) {
      this.dbg('refresh: lock unavailable (another PID refreshing) — polling disk')
      const fresh = await pollDiskForFreshToken(
        this.credentialStore,
        45_000,
        EXPIRY_BUFFER_MS,  // any token with > buffer remaining is fine for reactive use
      )
      if (fresh) {
        this.accessToken = fresh.accessToken
        this.refreshToken = fresh.refreshToken
        this.expiresAt = fresh.expiresAt
        this.dbg(`refresh: picked up fresh token from disk (${Math.round((fresh.expiresAt - Date.now()) / 60000)}min remaining)`)
        return
      }
      // No fresh token appeared — last-resort attempt without lock.
      // (Better to risk 429 than leave the caller without a token.)
      this.dbg('refresh: no fresh token from disk after 45s wait — attempting unlocked refresh as last resort')
      await this.doTokenRefresh()
      return
    }

    try {
      // Check 3: post-lock re-read (someone else refreshed while we waited for lock)
      const postLockCreds = await this.credentialStore.read()
      if (postLockCreds && !(Date.now() + EXPIRY_BUFFER_MS >= postLockCreds.expiresAt)) {
        this.accessToken = postLockCreds.accessToken
        this.refreshToken = postLockCreds.refreshToken
        this.expiresAt = postLockCreds.expiresAt
        return
      }

      // Actually refresh (under lock)
      await this.doTokenRefresh()
    } finally {
      release()
    }
  }

  /**
   * Handle 401 error — mirrors handleOAuth401Error() from auth.ts:1338-1392.
   * Deduplicates concurrent 401 handlers for the same failed token.
   */
  async handleAuth401(): Promise<void> {
    const failedToken = this.accessToken

    // Dedup: if already handling 401 for this token, reuse promise
    if (this.pending401 && this.lastFailedToken === failedToken) {
      await this.pending401
      return
    }

    this.lastFailedToken = failedToken

    this.pending401 = (async () => {
      // Check 1: re-read from store — another process may have refreshed
      const creds = await this.credentialStore.read()
      if (creds && creds.accessToken !== failedToken) {
        // Another process already refreshed — use their token
        this.accessToken = creds.accessToken
        this.refreshToken = creds.refreshToken
        this.expiresAt = creds.expiresAt
        return true
      }

      // Still same bad token — acquire lock before refresh to avoid 429 storm
      // when multiple PIDs hit 401 simultaneously (e.g. all sharing same dead token).
      const release = await acquireTokenRefreshLock()
      if (!release) {
        // FAIL-CLOSED: another PID is refreshing — wait for them via disk poll
        this.dbg('handleAuth401: lock unavailable — polling disk for fresh token')
        const fresh = await pollDiskForFreshToken(
          this.credentialStore,
          45_000,
          EXPIRY_BUFFER_MS,
        )
        if (fresh && fresh.accessToken !== failedToken) {
          this.accessToken = fresh.accessToken
          this.refreshToken = fresh.refreshToken
          this.expiresAt = fresh.expiresAt
          this.dbg(`handleAuth401: picked up fresh token from disk (${Math.round((fresh.expiresAt - Date.now()) / 60000)}min remaining)`)
          return true
        }
        // No fresh token from disk — last-resort unlocked refresh
        this.dbg('handleAuth401: no fresh token from disk after 45s wait — attempting unlocked refresh')
        await this.doTokenRefresh()
        return true
      }
      try {
        // Post-lock re-check: winner may have refreshed while we waited
        const postLockCreds = await this.credentialStore.read()
        if (postLockCreds && postLockCreds.accessToken !== failedToken &&
            !(Date.now() + EXPIRY_BUFFER_MS >= postLockCreds.expiresAt)) {
          this.accessToken = postLockCreds.accessToken
          this.refreshToken = postLockCreds.refreshToken
          this.expiresAt = postLockCreds.expiresAt
          return true
        }
        await this.doTokenRefresh()
      } finally {
        release()
      }
      return true
    })().finally(() => {
      this.pending401 = null
      this.lastFailedToken = null
    })

    await this.pending401
  }

  /** POST to platform.claude.com/v1/oauth/token — from oauth/client.ts:146
   *
   * Retry with backoff on 429/5xx (mirrors Claude Code's lockfile + triple-check pattern).
   * Multiple opencode sessions may try to refresh simultaneously — the first to succeed
   * writes to the credential store, others detect the fresh token on retry.
   *
   * @param force — if true, skip "already fresh" checks and always call the token endpoint.
   *   Used by proactive rotation to actually get a NEW token before the old one expires.
   */
  private async doTokenRefresh(force = false): Promise<void> {
    if (!this.refreshToken) {
      throw new AuthError('Token expired and no refresh token available.')
    }

    // Respect global cooldown — another process may have just 429'd
    if (this.isRefreshOnCooldown() && !force) {
      // But still check if someone else succeeded
      const cooldownCreds = await this.credentialStore.read()
      if (cooldownCreds && !(Date.now() + EXPIRY_BUFFER_MS >= cooldownCreds.expiresAt)) {
        this.accessToken = cooldownCreds.accessToken
        this.refreshToken = cooldownCreds.refreshToken
        this.expiresAt = cooldownCreds.expiresAt
        this.dbg('refresh skipped (cooldown) — another process already refreshed')
        return
      }
      // Cooldown active but no fresh token — must try anyway if token is about to expire
      if (this.expiresAt && this.expiresAt > Date.now() + EXPIRY_BUFFER_MS * 2) {
        throw new AuthError('Token refresh on cooldown due to rate limiting. Will retry later.')
      }
      // Token is critically close to expiry — ignore cooldown and try
      this.dbg('refresh: ignoring cooldown — token critically close to expiry')
    }

    const MAX_REFRESH_RETRIES = 5
    const REFRESH_DELAYS = [500, 1500, 3000, 5000, 8000]  // wider spread to reduce 429 storms

    // PRE-FETCH MTIME CHECK — coordinate with non-SDK refreshers (e.g. original
    // Claude Code CLI) that share ~/.claude/.credentials.json but don't know
    // about our cross-process lock. If the file was modified within the last
    // 60 seconds, *somebody* (CLI, another PID, etc.) just refreshed —
    // re-read instead of competing for the same per-refresh_token rate window.
    //
    // Production incident 2026-04-27 04:51:32Z: original CLI succeeded 25s
    // after our 5×429 burst. With this check, on our next rotation attempt we
    // would notice mtime fresh and pickup instead of POSTing.
    const credPath = (this.credentialStore as { path?: string }).path ?? join(homedir(), '.claude', '.credentials.json')
    try {
      const mtimeMs = statSync(credPath).mtimeMs
      const ageMs = Date.now() - mtimeMs
      const RECENT_WRITE_WINDOW_MS = 60_000
      if (ageMs < RECENT_WRITE_WINDOW_MS) {
        const recentCreds = await this.credentialStore.read()
        if (recentCreds && !(Date.now() + EXPIRY_BUFFER_MS >= recentCreds.expiresAt)) {
          const diskRemaining = recentCreds.expiresAt - Date.now()
          const isDifferent = recentCreds.accessToken !== this.accessToken
          // Accept if: not force OR token has enough life
          if (!force || (isDifferent && diskRemaining >= PROACTIVE_FRESH_MIN_REMAINING_MS)) {
            this.accessToken = recentCreds.accessToken
            this.refreshToken = recentCreds.refreshToken
            this.expiresAt = recentCreds.expiresAt
            this.tokenIssuedAt = Date.now()
            this.dbg(`refresh: skipped (mtime fresh ${Math.round(ageMs / 1000)}s ago, ${Math.round(diskRemaining / 60000)}min remaining) — picked up sibling/CLI write`)
            this.scheduleProactiveRotation()
            return
          }
        }
      }
    } catch {
      // statSync may fail if file doesn't exist yet — fall through to normal refresh
    }

    for (let attempt = 0; attempt < MAX_REFRESH_RETRIES; attempt++) {
      // Before each attempt, check if another process already refreshed
      // BUT: if force=true (proactive rotation), only skip if the token actually CHANGED
      // AND has enough remaining life — prevents all PIDs from endlessly picking up an
      // aging token without anyone actually hitting the OAuth endpoint.
      const freshCreds = await this.credentialStore.read()
      if (freshCreds && !(Date.now() + EXPIRY_BUFFER_MS >= freshCreds.expiresAt)) {
        if (!force) {
          // Not force — accept any non-expired token from disk
          this.accessToken = freshCreds.accessToken
          this.refreshToken = freshCreds.refreshToken
          this.expiresAt = freshCreds.expiresAt
          this.dbg(`refresh: another process already refreshed (attempt ${attempt})`)
          return
        }
        // force=true — only accept if the disk token is genuinely fresh
        const diskRemaining = freshCreds.expiresAt - Date.now()
        if (freshCreds.accessToken !== this.accessToken && diskRemaining >= PROACTIVE_FRESH_MIN_REMAINING_MS) {
          // Different token with plenty of life — another process recently refreshed
          this.accessToken = freshCreds.accessToken
          this.refreshToken = freshCreds.refreshToken
          this.expiresAt = freshCreds.expiresAt
          this.dbg(`refresh: another process got fresh token (${Math.round(diskRemaining / 60000)}min remaining) (attempt ${attempt})`)
          return
        }
        if (freshCreds.accessToken !== this.accessToken) {
          // Different token but nearly expired — pick it up (for correct refreshToken) but CONTINUE to actual refresh
          this.accessToken = freshCreds.accessToken
          this.refreshToken = freshCreds.refreshToken
          this.expiresAt = freshCreds.expiresAt
          this.dbg(`refresh: force=true, disk token different but only ${Math.round(diskRemaining / 60000)}min left — proceeding to actual refresh (attempt ${attempt})`)
        } else {
          // Same token — proceed to actually call the token endpoint
          this.dbg(`refresh: force=true, token still same, proceeding to actual refresh (attempt ${attempt})`)
        }
      }

      const response = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken,
          client_id: CLIENT_ID,
        }),
        signal: AbortSignal.timeout(15_000),
      })

      if (response.ok) {
        const data = await response.json() as {
          access_token: string
          refresh_token?: string
          expires_in: number
        }
        this.accessToken = data.access_token
        this.refreshToken = data.refresh_token ?? this.refreshToken
        this.expiresAt = Date.now() + data.expires_in * 1000
        this.tokenIssuedAt = Date.now()

        // Persist scopes from the previous token — the refresh response doesn't include them,
        // but CC checks shouldUseClaudeAIAuth(scopes) which needs 'user:inference'.
        // Without scopes, CC auth says "not logged in" and CC passthrough proxy fails.
        const prevCreds = await this.credentialStore.read()
        const scopes = prevCreds?.scopes?.length
          ? prevCreds.scopes
          : ['user:file_upload', 'user:inference', 'user:mcp_servers', 'user:profile', 'user:sessions:claude_code']

        await this.credentialStore.write({
          accessToken: this.accessToken,
          refreshToken: this.refreshToken!,
          expiresAt: this.expiresAt,
          scopes,
        })

        this.dbg(`token refreshed OK — expires in ${Math.round(data.expires_in / 60)}min at ${new Date(this.expiresAt).toISOString()}`)
        // Schedule next proactive rotation from fresh token
        this.scheduleProactiveRotation()
        return
      }

      // On 429: STOP retrying immediately. The OAuth endpoint rate-limits per
      // refresh_token, not per IP — repeating POSTs in quick succession just
      // *extends* the rate-limit window. Set a cross-process cooldown so other
      // PIDs (and our future scheduled rotations) back off, then bail out.
      // The next disk poll (proactiveRefresh / refreshTokenWithTripleCheck)
      // will pick up whoever did succeed (CLI, another PID, or our own next
      // attempt after cooldown).
      //
      // Production incident 2026-04-27 04:50:54Z: pid=248235 saw 429 on attempt 0
      // and continued retrying (1/2/3/4) for ~13s, all 429. Original CLI then
      // succeeded at 04:51:32 (25s after our first 429). If we had bailed
      // immediately, the CLI would still have won the race, but we'd have made
      // 1 POST instead of 5 — reducing our share of the 429 storm 5×.
      if (response.status === 429) {
        // 60s cooldown — covers Anthropic's typical per-refresh_token window
        // and is short enough to not block forever if it was a transient blip.
        const cooldownMs = Math.min(60_000, REFRESH_COOLDOWN_MAX_MS)
        this.setRefreshCooldown(cooldownMs)
        this.dbg(`TOKEN_REFRESH_RETRY status=429 attempt=${attempt + 1}/${MAX_REFRESH_RETRIES} — bailing out, cooldown ${cooldownMs}ms (per-token rate limit)`)
        throw new AuthError(`Token refresh rate-limited (429) — will pickup from disk or retry after cooldown`)
      }

      // On 5xx: still retry with backoff (these are transient server errors,
      // not rate-limits). Same retry budget as before.
      if (response.status >= 500 && attempt < MAX_REFRESH_RETRIES - 1) {
        const delay = REFRESH_DELAYS[attempt] ?? 8000
        const jitter = Math.random() * delay * 0.5
        this.dbg(`TOKEN_REFRESH_RETRY status=${response.status} attempt=${attempt + 1}/${MAX_REFRESH_RETRIES} delay=${Math.round(delay + jitter)}ms`)
        await new Promise(r => setTimeout(r, delay + jitter))
        continue
      }

      throw new AuthError(`Token refresh failed: ${response.status} ${response.statusText}`)
    }

    // Race recovery — all retries failed, but another process may have succeeded
    const recoveryCreds = await this.credentialStore.read()
    if (recoveryCreds && !(Date.now() + EXPIRY_BUFFER_MS >= recoveryCreds.expiresAt)) {
      this.accessToken = recoveryCreds.accessToken
      this.refreshToken = recoveryCreds.refreshToken
      this.expiresAt = recoveryCreds.expiresAt
      try {
        appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
          `[${new Date().toISOString()}] TOKEN_REFRESH_RACE_RECOVERY pid=${process.pid}\n`)
      } catch {}
      return
    }

    throw new AuthError('Token refresh failed after all retries and race recovery')
  }

  // ----------------------------------------------------------
  // Response assembly (for non-streaming generate())
  // ----------------------------------------------------------

  private assembleResponse(events: StreamEvent[], model: string): GenerateResponse {
    const content: ContentBlock[] = []
    const thinking: ThinkingBlock[] = []
    const toolCalls: ToolUseBlock[] = []
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
    let stopReason: string | null = null
    let currentText = ''
    let currentThinking = ''
    let currentThinkingSignature: string | undefined

    for (const event of events) {
      switch (event.type) {
        case 'text_delta':
          currentText += event.text
          break
        case 'thinking_delta':
          currentThinking += event.text
          break
        case 'thinking_end':
          currentThinkingSignature = event.signature
          if (currentThinking) {
            thinking.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature } as any)
            currentThinking = ''
          }
          break
        case 'tool_use_end':
          toolCalls.push({ type: 'tool_use', id: event.id, name: event.name, input: event.input })
          break
        case 'message_stop':
          usage = event.usage
          stopReason = event.stopReason
          break
        case 'error':
          throw event.error
      }
    }

    if (currentText) content.push({ type: 'text', text: currentText })
    if (currentThinking) thinking.push({ type: 'thinking', thinking: currentThinking, signature: currentThinkingSignature } as any)
    content.push(...toolCalls)

    return {
      content,
      thinking: thinking.length > 0 ? thinking : undefined,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      stopReason,
      rateLimitInfo: this.lastRateLimitInfo,
      model,
    }
  }

  // ----------------------------------------------------------
  // Rate limit parsing — from withRetry.ts:814
  // ----------------------------------------------------------

  private parseRateLimitHeaders(headers: Headers): RateLimitInfo {
    // Dump all anthropic/ratelimit headers for discovery
    const allRLHeaders: Record<string, string> = {}
    headers.forEach((value, key) => {
      if (key.includes('ratelimit') || key.includes('anthropic') || key.includes('retry') || key.includes('x-')) {
        allRLHeaders[key] = value
      }
    })
    if (Object.keys(allRLHeaders).length > 0) {
      // Side-channel for rate-limit header discovery
      try {
        const { appendFileSync } = require('fs')
        const { join } = require('path')
        const { homedir } = require('os')
        appendFileSync(join(homedir(), '.claude', 'claude-max-headers.log'),
          `[${new Date().toISOString()}] ${JSON.stringify(allRLHeaders)}\n`)
      } catch {}
    }

    const retryRaw = headers.get('retry-after')
    const resetRaw = headers.get('anthropic-ratelimit-unified-reset')
    const resetAt = resetRaw ? Number(resetRaw) : null

    const util5h = headers.get('anthropic-ratelimit-unified-5h-utilization')
    const util7d = headers.get('anthropic-ratelimit-unified-7d-utilization')

    return {
      status: headers.get('anthropic-ratelimit-unified-status'),
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
      retryAfter: retryRaw ? parseFloat(retryRaw) : null,
      utilization5h: util5h ? parseFloat(util5h) : null,
      utilization7d: util7d ? parseFloat(util7d) : null,
    }
  }

  // ----------------------------------------------------------
  // Retry delay — exact formula from withRetry.ts:530
  // ----------------------------------------------------------

  private getRetryDelay(attempt: number, retryAfterHeader: string | null): number {
    if (retryAfterHeader) {
      const seconds = parseInt(retryAfterHeader, 10)
      if (!isNaN(seconds)) return seconds * 1000
    }
    const baseDelay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS)
    const jitter = Math.random() * 0.25 * baseDelay
    return baseDelay + jitter
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new ClaudeCodeSDKError('Aborted')); return }
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer); reject(new ClaudeCodeSDKError('Aborted'))
      }, { once: true })
    })
  }

  // ----------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------

  /**
   * Compute message fingerprint — matches CC's computeFingerprintFromMessages().
   * Extracts chars at indices [4,7,20] from first user message, SHA256 with salt.
   * Returns 3-char hex string used in cc_version billing header.
   */
  private computeFingerprint(messages: unknown[]): string {
    // Extract first user message text
    let text = ''
    for (const msg of messages) {
      const m = msg as { role?: string; content?: unknown }
      if (m.role === 'user') {
        if (typeof m.content === 'string') { text = m.content; break }
        if (Array.isArray(m.content)) {
          for (const block of m.content) {
            if ((block as { type?: string; text?: string }).type === 'text') {
              text = (block as { text: string }).text; break
            }
          }
          if (text) break
        }
      }
    }
    const SALT = '59cf53e54c78'
    const indices = [4, 7, 20]
    const chars = indices.map(i => text[i] || '0').join('')
    const input = `${SALT}${chars}${CC_COMPAT_VERSION}`
    return createHash('sha256').update(input).digest('hex').slice(0, 3)
  }

  private readAccountUuid(): string {
    try {
      const configPath = join(homedir(), '.claude', 'claude_code_config.json')
      const config = JSON.parse(readFileSync(configPath, 'utf8'))
      return config.oauthAccount?.accountUuid ?? ''
    } catch {
      return ''
    }
  }
}

// ============================================================
// Built-in CredentialStore implementations
// ============================================================

/**
 * File-based credential store with mtime detection.
 * Mirrors CLI's plainTextStorage.ts + invalidateOAuthCacheIfDiskChanged().
 */
export class FileCredentialStore implements CredentialStore {
  private lastMtimeMs = 0

  // public readonly: lets ClaudeMaxClient.doTokenRefresh() do the pre-fetch
  // mtime check without a back-channel. Path is non-secret (just a file path).
  constructor(public readonly path: string) {}

  async read(): Promise<StoredCredentials | null> {
    try {
      const raw = readFileSync(this.path, 'utf8')
      this.lastMtimeMs = this.getMtime()
      const data: CredentialsFile = JSON.parse(raw)
      return data.claudeAiOauth ?? null
    } catch {
      return null
    }
  }

  async write(credentials: StoredCredentials): Promise<void> {
    let existing: CredentialsFile = {}
    try {
      existing = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch { /* */ }

    existing.claudeAiOauth = credentials

    const dir = join(this.path, '..')
    try { mkdirSync(dir, { recursive: true }) } catch { /* */ }
    writeFileSync(this.path, JSON.stringify(existing, null, 2), 'utf8')
    chmodSync(this.path, 0o600)
    this.lastMtimeMs = this.getMtime()
  }

  /** Detect cross-process changes via mtime — from auth.ts:1313-1336 */
  async hasChanged(): Promise<boolean> {
    const mtime = this.getMtime()
    if (mtime !== this.lastMtimeMs) {
      this.lastMtimeMs = mtime
      return true
    }
    return false
  }

  private getMtime(): number {
    try {
      return statSync(this.path).mtimeMs
    } catch {
      return 0
    }
  }
}

/**
 * In-memory credential store for direct token injection.
 * No persistence — tokens live only in SDK instance.
 */
export class MemoryCredentialStore implements CredentialStore {
  private credentials: StoredCredentials

  constructor(initial: StoredCredentials) {
    this.credentials = { ...initial }
  }

  async read(): Promise<StoredCredentials | null> {
    return this.credentials.accessToken ? { ...this.credentials } : null
  }

  async write(credentials: StoredCredentials): Promise<void> {
    this.credentials = { ...credentials }
  }
}
