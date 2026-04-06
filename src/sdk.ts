import { createHash, randomBytes, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, chmodSync, mkdirSync, rmdirSync, statSync, readdirSync, unlinkSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ============================================================
// Live-reload keepalive config — ~/.claude/keepalive.json
// ============================================================
// Read on each tick. Allows runtime tuning without restart.
// File is optional — missing file = use SDK defaults.
// Example: {"enabled":true,"intervalSec":120,"idleTimeoutSec":null}
//   null or absent = SDK default (Infinity for idleTimeout)

const KEEPALIVE_CONFIG_PATH = join(homedir(), '.claude', 'keepalive.json')
let _kaConfigMtimeMs = 0
let _kaConfigCache: Record<string, unknown> | null = null

function readKeepaliveConfig(): Record<string, unknown> | null {
  try {
    const st = statSync(KEEPALIVE_CONFIG_PATH)
    if (st.mtimeMs === _kaConfigMtimeMs && _kaConfigCache) return _kaConfigCache
    _kaConfigMtimeMs = st.mtimeMs
    _kaConfigCache = JSON.parse(readFileSync(KEEPALIVE_CONFIG_PATH, 'utf8'))
    return _kaConfigCache
  } catch {
    return null  // file doesn't exist or parse error — use defaults
  }
}
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
  KeepaliveConfig,
  KeepaliveStats,
  KeepaliveTick,
  TokenStatusEvent,
} from './types.js'
import { AuthError, APIError, RateLimitError, ClaudeCodeSDKError } from './types.js'

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

// Retry — from src/services/api/withRetry.ts:55
const BASE_DELAY_MS = 300
const MAX_DELAY_MS = 5_000
const EXPIRY_BUFFER_MS = 300_000 // 5 min before actual expiry

// ── Proactive token rotation ──────────────────────────────────
// Refresh at 50% of token lifetime — gives maximum margin for retries.
// With ~11h tokens: first refresh at ~5.5h, leaving 5.5h for retries.
const PROACTIVE_REFRESH_RATIO = 0.50
// Escalation thresholds (fraction of lifetime remaining)
const TOKEN_WARNING_THRESHOLD = 0.25   // 25% left → WARNING
const TOKEN_CRITICAL_THRESHOLD = 0.10  // 10% left → CRITICAL
// Minimum time between proactive refresh attempts (prevents 429 storm)
const PROACTIVE_REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000 // 5 min floor
// When force=true (proactive rotation), only accept a disk token if it has at least
// this much remaining life. Prevents all PIDs from endlessly picking up an aging
// token without anyone actually refreshing it.
const PROACTIVE_FRESH_MIN_REMAINING_MS = 2 * 60 * 60 * 1000 // 2 hours
// Global cooldown after refresh 429 — exponential backoff across ALL processes
const REFRESH_COOLDOWN_FILE = join(homedir(), '.claude', '.refresh-cooldown')
// Maximum cooldown time (30 minutes)
const REFRESH_COOLDOWN_MAX_MS = 30 * 60 * 1000

// CC-compatible version for User-Agent and billing header.
// Must match an actual released Claude Code version.
// Updated when CC releases new versions. Checked by Anthropic for billing attribution.
const CC_COMPAT_VERSION = '2.1.90'

// ============================================================
// Filesystem lock for cross-process token refresh coordination
// ============================================================
const TOKEN_LOCK_DIR = join(homedir(), '.claude', '.token-refresh-lock')
const TOKEN_LOCK_STALE_MS = 30_000  // 30s stale timeout

async function acquireTokenRefreshLock(): Promise<(() => void) | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
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
  return null  // Could not acquire after 5 attempts — proceed without lock (degraded)
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

  // Cache keepalive
  private keepaliveConfig: Required<Pick<KeepaliveConfig, 'enabled' | 'intervalMs' | 'idleTimeoutMs' | 'minTokens'>> & { onHeartbeat?: (stats: KeepaliveStats) => void; onTick?: (tick: KeepaliveTick) => void }
  private keepaliveRegistry = new Map<string, { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number }>()
  private _pendingSnapshotModel = ''
  private _pendingSnapshotBody: Record<string, unknown> | null = null
  private _pendingSnapshotHeaders: Record<string, string> | null = null
  private keepaliveLastActivityAt = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveAbortController: AbortController | null = null
  private keepaliveInFlight = false
  private keepaliveJitterMs = 0 // random offset to stagger keepalives across sessions
  // Timestamp of last successful cache write (real request or keepalive).
  // Used to compute exact remaining TTL for retry scheduling.
  private keepaliveCacheWrittenAt = 0
  private keepaliveRetryTimer: ReturnType<typeof setTimeout> | null = null
  // Track REAL activity (user requests) separately from keepalive fires.
  // Keepalive must NOT reset this — otherwise idle timeout never triggers.
  private keepaliveLastRealActivityAt = 0
  // No anchor persistence needed — Anthropic's cache automatically reads any matching prefix.
  // See addCacheMarkers() comment for details.
  private cacheAnchorMessageCount = 0

  constructor(options: ClaudeCodeSDKOptions = {}) {
    this.sessionId = randomUUID()
    this.deviceId = options.deviceId ?? randomBytes(32).toString('hex')


    this.accountUuid = options.accountUuid ?? this.readAccountUuid()
    this.timeout = options.timeout ?? 600_000
    this.maxRetries = options.maxRetries ?? 10

    this.onTokenStatus = options.onTokenStatus

    const ka = options.keepalive ?? {}
    this.keepaliveConfig = {
      enabled: ka.enabled ?? true,
      // Fire keepalive at ~120s (2 min), giving ~180s margin before 5-min cache TTL.
      // With tick every 20s, that's up to 9 retry opportunities if API is temporarily busy.
      intervalMs: ka.intervalMs ?? 120_000,
      idleTimeoutMs: ka.idleTimeoutMs ?? Infinity,  // keep alive as long as process runs
      minTokens: ka.minTokens ?? 2000,
      onHeartbeat: ka.onHeartbeat,
      onTick: ka.onTick,
    }

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
    await this.ensureAuth()
    const body = this.buildRequestBody(options)
    const headers = this.buildHeaders(options)

    // Snapshot for keepalive registry (deep clone to avoid mutation)
    this._pendingSnapshotModel = options.model
    this._pendingSnapshotBody = JSON.parse(JSON.stringify(body))
    this._pendingSnapshotHeaders = { ...headers }
    // Abort any in-flight keepalive before real request
    this.keepaliveAbortController?.abort()
    this.keepaliveInFlight = false

    let lastError: unknown
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      if (options.signal?.aborted) throw new ClaudeCodeSDKError('Aborted')

      try {
        yield* this.doStreamRequest(body, headers, options.signal)
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
    try {
      const { appendFileSync } = require('fs')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] API_START pid=${process.pid} model=${body.model} msgs=${(body.messages as unknown[])?.length ?? 0}\n`)
    } catch {}

    let response: Response
    try {
      response = await fetch(`${API_BASE_URL}/v1/messages?beta=true`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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

    try {
      const { appendFileSync } = require('fs')
      appendFileSync(join(homedir(), '.claude', 'claude-max-debug.log'),
        `[${new Date().toISOString()}] API_RESPONSE pid=${process.pid} status=${response.status} ttfb=${Date.now()-t0}ms\n`)
    } catch {}

    // Parse rate limit headers from response
    this.lastRateLimitInfo = this.parseRateLimitHeaders(response.headers)

    if (!response.ok) {
      let errorBody = ''
      try { errorBody = await response.text() } catch { /* */ }
      const requestId = response.headers.get('request-id')

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
              blocks.set(index, { type: 'tool_use', id: block.id, name: block.name, input: '' })
              yield { type: 'tool_use_start', id: block.id, name: block.name }
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
          if (type === 'message_stop') {
            yield { type: 'message_stop', usage, stopReason }
            this.onStreamComplete(usage)
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
  // Cache keepalive — keeps prompt cache warm between real requests
  // ----------------------------------------------------------

  private onStreamComplete(usage: TokenUsage): void {
    const now = Date.now()
    this.keepaliveLastActivityAt = now
    this.keepaliveLastRealActivityAt = now  // only REAL requests set this
    this.keepaliveCacheWrittenAt = now      // cache is fresh right now
    if (!this.keepaliveConfig.enabled) return

    // Register snapshot for this model — ONLY if it's the heaviest context seen.
    // Multiple conversations share one SDK instance (main chat + subagents).
    // Subagent calls have tiny contexts (1-5 msgs) that would overwrite the main
    // conversation's large context (hundreds of msgs), causing keepalive to fire
    // with the wrong (small) prefix and letting the main conversation's cache expire.
    // Fix: never downgrade — only overwrite if new snapshot has MORE tokens.
    const model = this._pendingSnapshotModel
    const body = this._pendingSnapshotBody
    const headers = this._pendingSnapshotHeaders
    if (model && body && headers) {
      const totalTokens = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
      const existing = this.keepaliveRegistry.get(model)
      if (totalTokens >= this.keepaliveConfig.minTokens && (!existing || totalTokens >= existing.inputTokens)) {
        this.keepaliveRegistry.set(model, { body, headers, model, inputTokens: totalTokens })
      }


      // Write snapshot metadata for debugging (rotate: keep last 24h)
      this.writeSnapshotDebug(model, body, usage)

      this._pendingSnapshotBody = null
      this._pendingSnapshotHeaders = null
    }

    if (this.keepaliveRegistry.size > 0) this.startKeepaliveTimer()
  }

  // Snapshot TTL in minutes. Set via CLAUDE_SDK_SNAPSHOT_TTL_MIN env var. Default: 1440 (24h).
  private static readonly SNAPSHOT_TTL_MS = (parseInt(process.env.CLAUDE_SDK_SNAPSHOT_TTL_MIN ?? '1440', 10) || 1440) * 60 * 1000
  // Full body dump for debugging. Set CLAUDE_SDK_DUMP_BODY=1 to enable.
  private static readonly DUMP_BODY = process.env.CLAUDE_SDK_DUMP_BODY === '1'
  private snapshotCallCount = 0

  private writeSnapshotDebug(model: string, body: Record<string, unknown>, usage: TokenUsage): void {
    try {
      const snapshotDir = join(homedir(), '.claude', 'snapshots')
      mkdirSync(snapshotDir, { recursive: true })

      // Rotate: delete files older than configured TTL
      try {
        const cutoff = Date.now() - ClaudeCodeSDK.SNAPSHOT_TTL_MS
        for (const f of readdirSync(snapshotDir)) {
          const fpath = join(snapshotDir, f)
          const st = statSync(fpath)
          if (st.mtimeMs < cutoff) unlinkSync(fpath)
        }
      } catch { /* rotation best-effort */ }

      this.snapshotCallCount++
      const msgs = body.messages as { role: string; content: unknown }[]
      const sys = body.system
      const tools = body.tools as unknown[] | undefined

      const sysStr = typeof sys === 'string' ? sys : JSON.stringify(sys)
      const sysHash = createHash('md5').update(sysStr).digest('hex').slice(0, 8)

      const meta: Record<string, unknown> = {
        ts: new Date().toISOString(),
        pid: process.pid,
        callNum: this.snapshotCallCount,
        model,
        anchor: this.cacheAnchorMessageCount,
        messages: msgs?.length ?? 0,
        tools: tools?.length ?? 0,
        sysHash,
        sysLen: sysStr.length,
        usage: {
          input: usage.inputTokens ?? 0,
          cacheRead: usage.cacheReadInputTokens ?? 0,
          cacheWrite: usage.cacheCreationInputTokens ?? 0,
        },
        firstMsg: msgs?.[0] ? {
          role: msgs[0].role,
          contentLen: JSON.stringify(msgs[0].content).length,
          contentHash: createHash('md5').update(JSON.stringify(msgs[0].content)).digest('hex').slice(0, 8),
        } : null,
        lastMsg: msgs?.length ? {
          role: msgs[msgs.length - 1].role,
          contentLen: JSON.stringify(msgs[msgs.length - 1].content).length,
        } : null,
        anchorMsg: this.cacheAnchorMessageCount > 0 && msgs?.[this.cacheAnchorMessageCount - 1]
          ? { role: msgs[this.cacheAnchorMessageCount - 1].role, contentLen: JSON.stringify(msgs[this.cacheAnchorMessageCount - 1].content).length }
          : null,
        toolsHash: tools?.length ? createHash('md5').update(
          JSON.stringify((tools as { name?: string }[]).map(t => t.name ?? '').join(','))
        ).digest('hex').slice(0, 8) : null,
      }

      const filename = `${process.pid}-${Date.now()}.json`
      writeFileSync(join(snapshotDir, filename), JSON.stringify(meta, null, 2) + '\n')

      // Full raw body dump — the EXACT payload sent to Anthropic API.
      // First 3 calls of each process + whenever DUMP_BODY env is set.
      if (ClaudeCodeSDK.DUMP_BODY || this.snapshotCallCount <= 3) {
        const dumpDir = join(snapshotDir, 'bodies')
        mkdirSync(dumpDir, { recursive: true })
        const dumpFile = `${process.pid}-call${this.snapshotCallCount}-${Date.now()}.json`
        writeFileSync(join(dumpDir, dumpFile), JSON.stringify(body, null, 2) + '\n')
      }
    } catch { /* debug logging must never crash */ }
  }

  private startKeepaliveTimer(): void {
    if (this.keepaliveTimer) return
    const TICK_MS = Math.min(30_000, Math.max(5_000, Math.floor(this.keepaliveConfig.intervalMs / 6)))
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), TICK_MS)
    if (this.keepaliveTimer && typeof this.keepaliveTimer === 'object' && 'unref' in this.keepaliveTimer) {
      (this.keepaliveTimer as any).unref()
    }
  }

  // Anthropic cache TTL — API silently downgrades our ttl:'1h' to 5 minutes
  // (ephemeral_1h_input_tokens=0 in response). We're not on the 1h allowlist.
  // Keep sending ttl:'1h' in case they enable it later — no harm, falls back to 5min.
  private static readonly CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes (server-enforced)

  private async keepaliveTick(): Promise<void> {
    if (this.keepaliveRegistry.size === 0 || this.keepaliveInFlight) return

    // Live-reload config from ~/.claude/keepalive.json (mtime-cached, cheap)
    const liveConfig = readKeepaliveConfig()
    if (liveConfig) {
      if (liveConfig.enabled === false) {
        this.keepaliveRegistry.clear()
        this.stopKeepalive()
        return
      }
      if (typeof liveConfig.intervalSec === 'number' && liveConfig.intervalSec > 0)
        this.keepaliveConfig.intervalMs = liveConfig.intervalSec * 1000
      if (typeof liveConfig.idleTimeoutSec === 'number' && liveConfig.idleTimeoutSec > 0)
        this.keepaliveConfig.idleTimeoutMs = liveConfig.idleTimeoutSec * 1000
      else if (liveConfig.idleTimeoutSec === null || liveConfig.idleTimeoutSec === 0)
        this.keepaliveConfig.idleTimeoutMs = Infinity
      if (typeof liveConfig.minTokens === 'number')
        this.keepaliveConfig.minTokens = liveConfig.minTokens
    }

    // Idle timeout (from config or live override). Default: Infinity = never stop.
    const realIdle = Date.now() - this.keepaliveLastRealActivityAt
    if (this.keepaliveConfig.idleTimeoutMs !== Infinity && realIdle > this.keepaliveConfig.idleTimeoutMs) {
      this.keepaliveRegistry.clear()
      this.stopKeepalive()
      return
    }

    // Pick heaviest model from registry
    let best: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number } | null = null
    for (const entry of this.keepaliveRegistry.values()) {
      if (!best || entry.inputTokens > best.inputTokens) best = entry
    }
    if (!best) return

    // Use keepaliveLastActivityAt (updated by both real and KA) for fire timing
    const idle = Date.now() - this.keepaliveLastActivityAt

    // Add jitter to prevent multiple sessions from firing keepalives simultaneously.
    // Without jitter, all sessions that go idle together (lunch break) fire at the
    // exact same moment, causing API bursts and OAuth token refresh 429s.
    if (!this.keepaliveJitterMs) {
      this.keepaliveJitterMs = Math.floor(Math.random() * 30_000) // 0-30s random offset
    }
    if (idle < this.keepaliveConfig.intervalMs * 0.9 + this.keepaliveJitterMs) {
      this.keepaliveConfig.onTick?.({
        idleMs: idle,
        nextFireMs: Math.max(0, this.keepaliveConfig.intervalMs - idle),
        model: best.model,
        tokens: best.inputTokens,
      })
      return
    }

    // Fire keepalive for heaviest model
    this.keepaliveInFlight = true

    try {
      await this.ensureAuth()

      const body = JSON.parse(JSON.stringify(best.body))
      const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
      body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1

      const headers = { ...best.headers, Authorization: `Bearer ${this.accessToken}` }

      const controller = new AbortController()
      this.keepaliveAbortController = controller

      const t0 = Date.now()
      let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

      for await (const event of this.doStreamRequest(body, headers, controller.signal)) {
        if (event.type === 'message_stop') usage = event.usage
      }

      const durationMs = Date.now() - t0
      // Update fire timer (for spacing keepalives) but NOT realActivityAt
      this.keepaliveLastActivityAt = Date.now()
      this.keepaliveCacheWrittenAt = Date.now() // cache refreshed



      this.keepaliveConfig.onHeartbeat?.({
        usage,
        durationMs,
        idleMs: idle,
        model: best.model,
        rateLimit: {
          status: this.lastRateLimitInfo.status,
          claim: this.lastRateLimitInfo.claim,
          resetAt: this.lastRateLimitInfo.resetAt,
        },
      })
    } catch (err: unknown) {
      // Distinguish transient errors (retry) from permanent ones (give up).
      const status = (err as { status?: number })?.status
      const isTransient = !status || status === 503 || status === 529 || status >= 500

      if (isTransient) {
        // Start dedicated retry chain with exact timing from cache write timestamp.
        this.keepaliveRetryChain(best)
      } else {
        // Permanent: 429 rate limit, 401 auth — give up.
        this.keepaliveRegistry.clear()
        this.stopKeepalive()
      }
    } finally {
      this.keepaliveInFlight = false
      this.keepaliveAbortController = null
    }
  }

  // Retry backoff: start fast (2s), ramp to 20s max. 13 attempts fit in ~180s margin.
  // Fire at ~120s, cache expires at 300s → 180s window for retries.
  private static readonly KEEPALIVE_RETRY_DELAYS = [2, 3, 5, 7, 10, 12, 15, 17, 20, 20, 20, 20, 20]

  /**
   * Dedicated retry chain for transient keepalive failures.
   * Uses setTimeout with exact delays from a fixed timestamp — no drift, no timer reuse.
   * Checks remaining cache TTL before each attempt to avoid wasting a request on expired cache.
   */
  private keepaliveRetryChain(
    entry: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number },
    attemptIndex = 0,
  ): void {
    if (attemptIndex >= ClaudeCodeSDK.KEEPALIVE_RETRY_DELAYS.length) {
      // Exhausted all retries — give up
      this.keepaliveRegistry.clear()
      this.stopKeepalive()
      return
    }

    // Check remaining TTL from exact cache write timestamp — not from interval timer
    const cacheAge = Date.now() - this.keepaliveCacheWrittenAt
    const ttlRemaining = ClaudeCodeSDK.CACHE_TTL_MS - cacheAge
    const nextDelay = ClaudeCodeSDK.KEEPALIVE_RETRY_DELAYS[attemptIndex]! * 1000

    // Need at least the delay + 5s safety for the request itself
    if (ttlRemaining < nextDelay + 5000) {
      // Not enough time — cache will expire before we can retry. Give up cleanly.
      this.keepaliveRegistry.clear()
      this.stopKeepalive()
      return
    }

    // Schedule retry with exact delay
    this.keepaliveRetryTimer = setTimeout(async () => {
      this.keepaliveRetryTimer = null

      // Re-check: if a real request happened since we started retrying, stop.
      if (this.keepaliveLastRealActivityAt > this.keepaliveCacheWrittenAt) {
        // Real request wrote fresh cache — no need for keepalive retry
        return
      }

      // Re-check remaining TTL right before firing (time passed during delay)
      const ageNow = Date.now() - this.keepaliveCacheWrittenAt
      if (ageNow > ClaudeCodeSDK.CACHE_TTL_MS - 5000) {
        this.keepaliveRegistry.clear()
        this.stopKeepalive()
        return
      }

      // Fire the retry
      this.keepaliveInFlight = true
      try {
        await this.ensureAuth()
        const body = JSON.parse(JSON.stringify(entry.body))
        const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
        body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1
        const headers = { ...entry.headers, Authorization: `Bearer ${this.accessToken}` }

        const controller = new AbortController()
        this.keepaliveAbortController = controller

        for await (const event of this.doStreamRequest(body, headers, controller.signal)) {
          // Drain stream — we only care about cache refresh, not response content
          void event
        }

        // Success! Cache refreshed.
        this.keepaliveLastActivityAt = Date.now()
        this.keepaliveCacheWrittenAt = Date.now()
      } catch (err: unknown) {
        const status = (err as { status?: number })?.status
        const isTransient = !status || status === 503 || status === 529 || status >= 500

        if (isTransient) {
          // Try next delay in the sequence
          this.keepaliveInFlight = false
          this.keepaliveAbortController = null
          this.keepaliveRetryChain(entry, attemptIndex + 1)
          return
        } else {
          // Permanent failure — stop
          this.keepaliveRegistry.clear()
          this.stopKeepalive()
        }
      } finally {
        this.keepaliveInFlight = false
        this.keepaliveAbortController = null
      }
    }, nextDelay)
  }

  public stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    if (this.keepaliveRetryTimer) {
      clearTimeout(this.keepaliveRetryTimer)
      this.keepaliveRetryTimer = null
    }
    if (this.tokenRotationTimer) {
      clearTimeout(this.tokenRotationTimer)
      this.tokenRotationTimer = null
    }
    this.keepaliveAbortController?.abort()
    this.keepaliveRegistry.clear()
    this.keepaliveInFlight = false
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
      'User-Agent': `claude-code/${CC_COMPAT_VERSION}`,
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
    let system: unknown = undefined
    if (typeof options.system === 'string') {
      system = attributionHeader + '\n' + options.system
    } else if (Array.isArray(options.system)) {
      system = [{ type: 'text', text: attributionHeader }, ...options.system]
    } else {
      system = attributionHeader
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages: options.messages,
      max_tokens: options.maxTokens ?? 16384,
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
      body.tools = options.tools
      if (options.toolChoice) {
        body.tool_choice = typeof options.toolChoice === 'string'
          ? { type: options.toolChoice }
          : options.toolChoice
      }
    }

    // Prompt caching — add cache_control to last content block of last message
    // Mirrors addCacheBreakpoints() in claude.ts:3063-3211
    if (options.caching !== false) {
      this.addCacheMarkers(body)
    }

    // Thinking — mirrors claude.ts:1604-1630
    // 4.6 models use adaptive thinking by default
    const model = options.model.toLowerCase()
    const is46Model = model.includes('opus-4-6') || model.includes('sonnet-4-6')
    const thinkingDisabled = options.thinking?.type === 'disabled'

    if (!thinkingDisabled && is46Model) {
      // Sonnet/Opus 4.6 use adaptive thinking — thinking.ts:120
      body.thinking = { type: 'adaptive' }
    } else if (options.thinking?.type === 'enabled') {
      body.thinking = {
        type: 'enabled',
        budget_tokens: options.thinking.budgetTokens,
      }
    }
    // When disabled or omitted for non-4.6: don't send thinking field

    // Temperature only when thinking is disabled — claude.ts:1691-1695
    const hasThinking = !thinkingDisabled && (is46Model || options.thinking?.type === 'enabled')
    if (!hasThinking && options.temperature !== undefined) {
      body.temperature = options.temperature
    }

    if (options.topP !== undefined) {
      body.top_p = options.topP
    }

    // Effort — goes into output_config.effort (from utils/effort.ts + claude.ts:1563)
    if (options.effort && is46Model) {
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
    // Step 1: check in-memory cache
    if (this.accessToken && !this.isTokenExpired()) return

    // Step 2: check store — another process may have refreshed
    // Mirrors invalidateOAuthCacheIfDiskChanged() from auth.ts:1313
    if (this.credentialStore.hasChanged) {
      const changed = await this.credentialStore.hasChanged()
      if (changed) {
        await this.loadFromStore()
        if (this.accessToken && !this.isTokenExpired()) return
      }
    }

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

    try {
      // Post-lock check: another process may have refreshed while we waited for lock
      if (release) {
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
      }

      await this.doTokenRefresh(true)  // force=true: actually call token endpoint, don't just re-read
      this.proactiveRefreshFailures = 0
      this.refreshConsecutive429s = 0
      this.clearRefreshCooldown()
      this.tokenIssuedAt = Date.now()
      this.dbg(`proactive rotation SUCCESS — new token expires at ${new Date(this.expiresAt!).toISOString()}`)
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

    try {
      // Check 3: post-lock re-read (someone else refreshed while we waited for lock)
      if (release) {
        const postLockCreds = await this.credentialStore.read()
        if (postLockCreds && !(Date.now() + EXPIRY_BUFFER_MS >= postLockCreds.expiresAt)) {
          this.accessToken = postLockCreds.accessToken
          this.refreshToken = postLockCreds.refreshToken
          this.expiresAt = postLockCreds.expiresAt
          return
        }
      }

      // Actually refresh (under lock)
      await this.doTokenRefresh()
    } finally {
      if (release) release()
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

      // Still same bad token — force refresh
      await this.doTokenRefresh()
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

      // On 429/5xx: wait and retry — another process may succeed first
      if ((response.status === 429 || response.status >= 500) && attempt < MAX_REFRESH_RETRIES - 1) {
        const delay = REFRESH_DELAYS[attempt] ?? 8000
        const jitter = Math.random() * delay * 0.5
        this.dbg(`TOKEN_REFRESH_RETRY status=${response.status} attempt=${attempt + 1}/${MAX_REFRESH_RETRIES} delay=${Math.round(delay + jitter)}ms`)
        // On 429: set cross-process cooldown so other PIDs back off too
        if (response.status === 429) {
          const cooldownMs = Math.min(
            (delay + jitter) * 3, // 3x the retry delay
            REFRESH_COOLDOWN_MAX_MS,
          )
          this.setRefreshCooldown(cooldownMs)
        }
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
    if (Object.keys(allRLHeaders).length > 0 && this.keepaliveConfig?.onTick) {
      // Log via onTick as a side-channel for header discovery
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

  constructor(private path: string) {}

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
