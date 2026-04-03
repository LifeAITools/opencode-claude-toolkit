import { createHash, randomBytes, randomUUID } from 'crypto'
import { readFileSync, writeFileSync, chmodSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
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

// Fingerprint — from src/utils/fingerprint.ts:8
const FINGERPRINT_SALT = '59cf53e54c78'

// Retry — from src/services/api/withRetry.ts:55
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 32_000
const EXPIRY_BUFFER_MS = 300_000 // 5 min before actual expiry

const SDK_VERSION = '0.1.0'

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
  private version: string
  private timeout: number
  private maxRetries: number
  private lastRateLimitInfo: RateLimitInfo = {
    status: null, resetAt: null, claim: null, retryAfter: null,
  }
  // 401 dedup — mirrors auth.ts:1338-1392 pending401Handlers
  private pending401: Promise<boolean> | null = null
  private lastFailedToken: string | null = null

  // Cache keepalive
  private keepaliveConfig: Required<Pick<KeepaliveConfig, 'enabled' | 'intervalMs' | 'idleTimeoutMs' | 'minTokens'>> & { onHeartbeat?: (stats: KeepaliveStats) => void }
  private keepaliveRegistry = new Map<string, { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number }>()
  private _pendingSnapshotModel = ''
  private _pendingSnapshotBody: Record<string, unknown> | null = null
  private _pendingSnapshotHeaders: Record<string, string> | null = null
  private keepaliveLastActivityAt = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private keepaliveAbortController: AbortController | null = null
  private keepaliveInFlight = false

  constructor(options: ClaudeCodeSDKOptions = {}) {
    this.sessionId = randomUUID()
    this.deviceId = options.deviceId ?? randomBytes(32).toString('hex')
    this.accountUuid = options.accountUuid ?? this.readAccountUuid()
    this.version = options.version ?? SDK_VERSION
    this.timeout = options.timeout ?? 600_000
    this.maxRetries = options.maxRetries ?? 3

    const ka = options.keepalive ?? {}
    this.keepaliveConfig = {
      enabled: ka.enabled ?? true,
      intervalMs: ka.intervalMs ?? 180_000,
      idleTimeoutMs: ka.idleTimeoutMs ?? 1_800_000,
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
    } else {
      this.credentialStore = new FileCredentialStore(
        options.credentialsPath ?? join(homedir(), '.claude', '.credentials.json'),
      )
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
      throw new ClaudeCodeSDKError('Network error', err)
    }

    clearTimeout(timeoutId)

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

          // message_start — extract initial usage
          if (type === 'message_start') {
            const msg = parsed.message as Record<string, unknown> | undefined
            const u = msg?.usage as Record<string, number> | undefined
            if (u) {
              usage = {
                inputTokens: u.input_tokens ?? 0,
                outputTokens: u.output_tokens ?? 0,
                cacheCreationInputTokens: u.cache_creation_input_tokens,
                cacheReadInputTokens: u.cache_read_input_tokens,
              }
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
    this.keepaliveLastActivityAt = Date.now()
    if (!this.keepaliveConfig.enabled) return

    // Register snapshot for this model
    const model = this._pendingSnapshotModel
    const body = this._pendingSnapshotBody
    const headers = this._pendingSnapshotHeaders
    if (model && body && headers) {
      const totalTokens = (usage.inputTokens ?? 0) + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
      if (totalTokens >= this.keepaliveConfig.minTokens) {
        this.keepaliveRegistry.set(model, { body, headers, model, inputTokens: totalTokens })
      }
      this._pendingSnapshotBody = null
      this._pendingSnapshotHeaders = null
    }

    if (this.keepaliveRegistry.size > 0) this.startKeepaliveTimer()
  }

  private startKeepaliveTimer(): void {
    if (this.keepaliveTimer) return
    const TICK_MS = Math.min(30_000, Math.max(5_000, Math.floor(this.keepaliveConfig.intervalMs / 6)))
    this.keepaliveTimer = setInterval(() => this.keepaliveTick(), TICK_MS)
    if (this.keepaliveTimer && typeof this.keepaliveTimer === 'object' && 'unref' in this.keepaliveTimer) {
      (this.keepaliveTimer as any).unref()
    }
  }

  private async keepaliveTick(): Promise<void> {
    if (this.keepaliveRegistry.size === 0 || this.keepaliveInFlight) return

    const idle = Date.now() - this.keepaliveLastActivityAt

    if (idle > this.keepaliveConfig.idleTimeoutMs) {
      this.stopKeepalive()
      return
    }

    // Pick heaviest model from registry
    let best: { body: Record<string, unknown>; headers: Record<string, string>; model: string; inputTokens: number } | null = null
    for (const entry of this.keepaliveRegistry.values()) {
      if (!best || entry.inputTokens > best.inputTokens) best = entry
    }
    if (!best) return

    if (idle < this.keepaliveConfig.intervalMs * 0.9) {
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
      this.keepaliveLastActivityAt = Date.now()

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
    } catch {
      // CN-01: errors never propagate
    } finally {
      this.keepaliveInFlight = false
      this.keepaliveAbortController = null
    }
  }

  public stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
    this.keepaliveAbortController?.abort()
    this.keepaliveRegistry.clear()
    this.keepaliveInFlight = false
  }

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
      'User-Agent': `claude-code/${this.version} (external, sdk)`,
      'X-Claude-Code-Session-Id': this.sessionId,
    }
  }

  /** Request body — mirrors paramsFromContext() in claude.ts:1699 */
  private buildRequestBody(options: GenerateOptions): Record<string, unknown> {
    // Build attribution header for system prompt — from constants/system.ts:73
    const fingerprint = this.computeFingerprint(options.messages)
    const attributionHeader = `x-anthropic-billing-header: cc_version=${this.version}.${fingerprint}; cc_entrypoint=cli;`

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

  /** Add cache_control markers to system + last message — mirrors addCacheBreakpoints() */
  private addCacheMarkers(body: Record<string, unknown>): void {
    // Claude supports up to 4 cache breakpoints per request.
    // Strategy: maximize cache reuse across keepalive → new message transitions.
    //
    // Breakpoint 1: system prompt (always stable)
    // Breakpoint 2: last tool (always stable — tools don't change in session)
    // Breakpoint 3: second-to-last message (stable when new message added)
    // Breakpoint 4: last message (changes on each new user input)
    //
    // Result: keepalive → all 4 hit. New message → breakpoints 1-3 hit, only 4 is write.

    const CC = { cache_control: { type: 'ephemeral' } }

    // Breakpoint 1: system prompt
    const sys = body.system
    if (typeof sys === 'string') {
      body.system = [{ type: 'text', text: sys, ...CC }]
    } else if (Array.isArray(sys)) {
      const blocks = sys as Record<string, unknown>[]
      if (blocks.length > 0) {
        blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], ...CC }
      }
    }

    // Breakpoint 2: last tool definition
    const tools = body.tools as Record<string, unknown>[] | undefined
    if (tools && tools.length > 0) {
      tools[tools.length - 1] = { ...tools[tools.length - 1], ...CC }
    }

    // Breakpoints 3 & 4: messages
    const messages = body.messages as { role: string; content: string | Record<string, unknown>[] }[]
    if (messages.length === 0) return

    const addCCToMessage = (msg: typeof messages[0]) => {
      if (typeof msg.content === 'string') {
        msg.content = [{ type: 'text', text: msg.content, ...CC }]
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const last = msg.content[msg.content.length - 1]
        msg.content[msg.content.length - 1] = { ...last, ...CC }
      }
    }

    // Breakpoint 3: second-to-last message (if exists) — stable across new messages
    if (messages.length >= 3) {
      addCCToMessage(messages[messages.length - 2])
    }

    // Breakpoint 4: last message — current turn
    addCCToMessage(messages[messages.length - 1])
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
    // Step 1: check in-memory cache
    if (this.accessToken && !this.isTokenExpired()) {
      return
    }

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
  }

  /** 5-minute buffer before actual expiry — from oauth/client.ts:344-353 */
  private isTokenExpired(): boolean {
    if (!this.expiresAt) return false
    return Date.now() + EXPIRY_BUFFER_MS >= this.expiresAt
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

    // Do the actual refresh
    await this.doTokenRefresh()
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

  /** POST to platform.claude.com/v1/oauth/token — from oauth/client.ts:146 */
  private async doTokenRefresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new AuthError('Token expired and no refresh token available.')
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

    if (!response.ok) {
      // Check 3: on error, check store — maybe another process fixed it
      const recovered = await this.credentialStore.read()
      if (recovered && !(Date.now() + EXPIRY_BUFFER_MS >= recovered.expiresAt)) {
        this.accessToken = recovered.accessToken
        this.refreshToken = recovered.refreshToken
        this.expiresAt = recovered.expiresAt
        return
      }
      throw new AuthError(`Token refresh failed: ${response.status} ${response.statusText}`)
    }

    const data = await response.json() as {
      access_token: string
      refresh_token?: string
      expires_in: number
    }

    this.accessToken = data.access_token
    this.refreshToken = data.refresh_token ?? this.refreshToken
    this.expiresAt = Date.now() + data.expires_in * 1000

    // Persist to store
    await this.credentialStore.write({
      accessToken: this.accessToken,
      refreshToken: this.refreshToken!,
      expiresAt: this.expiresAt,
    })
  }

  // ----------------------------------------------------------
  // Fingerprint — exact copy from src/utils/fingerprint.ts
  // ----------------------------------------------------------

  computeFingerprint(messages: { role: string; content: string | unknown[] }[]): string {
    const firstUser = messages.find(m => m.role === 'user')
    if (!firstUser) return this.hashFingerprint('000')

    let text = ''
    if (typeof firstUser.content === 'string') {
      text = firstUser.content
    } else if (Array.isArray(firstUser.content)) {
      const tb = firstUser.content.find((b: unknown) => (b as Record<string, string>).type === 'text') as { text: string } | undefined
      text = tb?.text ?? ''
    }

    const chars = [4, 7, 20].map(i => text[i] || '0').join('')
    return this.hashFingerprint(chars)
  }

  private hashFingerprint(chars: string): string {
    const input = `${FINGERPRINT_SALT}${chars}${this.version}`
    return createHash('sha256').update(input).digest('hex').slice(0, 3)
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

    return {
      status: headers.get('anthropic-ratelimit-unified-status'),
      resetAt: Number.isFinite(resetAt) ? resetAt : null,
      claim: headers.get('anthropic-ratelimit-unified-representative-claim'),
      retryAfter: retryRaw ? parseFloat(retryRaw) : null,
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
