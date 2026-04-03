/**
 * @life-ai-tools/claude-max-provider
 *
 * Vercel AI SDK v3 provider backed by ClaudeCodeSDK.
 * Implements LanguageModelV3 interface so opencode can use Claude Max/Pro
 * subscription directly — no proxy, no @ai-sdk/anthropic dependency.
 *
 * Usage in opencode plugin:
 *   config.provider['claude-max'].npm = '@life-ai-tools/claude-max-provider'
 *   // or via file:// path
 */

import { ClaudeCodeSDK } from '@life-ai-tools/claude-code-sdk'
import type { GenerateOptions, StreamEvent } from '@life-ai-tools/claude-code-sdk'

import { appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const DEBUG = process.env.CLAUDE_MAX_DEBUG === '1'
const LOG_FILE = join(homedir(), '.claude', 'claude-max-debug.log')
const STATS_FILE = join(homedir(), '.claude', 'claude-max-stats.log')

function logStats(line: string) {
  try { appendFileSync(STATS_FILE, line + '\n') } catch {}
}

function dbg(...args: any[]) {
  if (!DEBUG) return
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`) } catch {}
}

// ─── Types (subset of @ai-sdk/provider v3) ────────────────
// We inline these to avoid a dependency on @ai-sdk/provider

interface LanguageModelV3 {
  readonly specificationVersion: 'v3'
  readonly provider: string
  readonly modelId: string
  supportedUrls: Record<string, RegExp[]>
  doGenerate(options: any): Promise<any>
  doStream(options: any): Promise<any>
}

// ─── Prompt conversion: V3 → SDK ──────────────────────────

function convertPrompt(prompt: any[]): { system?: string; messages: any[] } {
  let system: string | undefined
  const messages: any[] = []

  // Debug: dump what opencode sends us
  for (const msg of prompt) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p.type === 'reasoning') {
          dbg('PROMPT reasoning part:', {
            textLen: p.text?.length,
            hasProviderMetadata: !!p.providerMetadata,
            providerMetadataKeys: p.providerMetadata ? Object.keys(p.providerMetadata) : [],
            hasProviderOptions: !!p.providerOptions,
            providerOptionsKeys: p.providerOptions ? Object.keys(p.providerOptions) : [],
            fullPart: JSON.stringify(p).slice(0, 500),
          })
        }
      }
    }
  }

  for (const msg of prompt) {
    if (msg.role === 'system') {
      system = typeof msg.content === 'string' ? msg.content : msg.content
      continue
    }

    if (msg.role === 'user') {
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      const content: any[] = []
      for (const p of parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text || '...' })
        // file parts: pass as base64 image if image/*
        if (p.type === 'file' && typeof p.mediaType === 'string' && p.mediaType.startsWith('image/')) {
          const data = typeof p.data === 'string' ? p.data
            : p.data instanceof Uint8Array ? Buffer.from(p.data).toString('base64')
            : String(p.data)
          content.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data } })
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '...' })
      messages.push({ role: 'user', content })
      continue
    }

    if (msg.role === 'assistant') {
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      const content: any[] = []
      for (const p of parts) {
        if (p.type === 'text' && p.text) content.push({ type: 'text', text: p.text })
        if (p.type === 'reasoning' && p.text) {
          // Only include thinking blocks if we have the signature (required by API)
          const sig = p.providerMetadata?.['claude-max']?.signature ?? p.providerOptions?.['claude-max']?.signature
          if (sig) {
            content.push({ type: 'thinking', thinking: p.text, signature: sig })
          }
          // Without signature: skip thinking block — API rejects it
        }
        if (p.type === 'tool-call') {
          content.push({
            type: 'tool_use',
            id: p.toolCallId,
            name: p.toolName,
            input: typeof p.input === 'string' ? JSON.parse(p.input) : p.input ?? {},
          })
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '...' })
      messages.push({ role: 'assistant', content })
      continue
    }

    if (msg.role === 'tool') {
      const parts = Array.isArray(msg.content) ? msg.content : [msg.content]
      const toolResults: any[] = []
      for (const p of parts) {
        if (p.type === 'tool-result') {
          let resultContent: string
          if (Array.isArray(p.output)) {
            // LanguageModelV3ToolResultOutput array
            resultContent = p.output.map((o: any) => {
              if (o.type === 'text' || o.type === 'error-text') return o.value
              if (o.type === 'json' || o.type === 'error-json') return JSON.stringify(o.value)
              return String(o.value ?? '')
            }).join('\n')
          } else if (typeof p.output === 'object' && p.output !== null) {
            if (p.output.type === 'text' || p.output.type === 'error-text') resultContent = p.output.value
            else if (p.output.type === 'json' || p.output.type === 'error-json') resultContent = JSON.stringify(p.output.value)
            else resultContent = JSON.stringify(p.output)
          } else {
            resultContent = String(p.output ?? '')
          }
          const isError = p.output?.type === 'error-text' || p.output?.type === 'error-json' || p.output?.type === 'execution-denied'
          toolResults.push({
            type: 'tool_result',
            tool_use_id: p.toolCallId,
            content: resultContent,
            ...(isError ? { is_error: true } : {}),
          })
        }
      }
      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults })
      }
      continue
    }
  }

  return { system, messages }
}

// ─── Tools conversion: V3 → SDK ──────────────────────────

function convertTools(tools?: any[]): any[] | undefined {
  if (!tools?.length) return undefined
  return tools
    .filter((t: any) => t.type === 'function')
    .map((t: any) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema ?? { type: 'object', properties: {} },
    }))
}

function convertToolChoice(tc?: any): any {
  if (!tc) return undefined
  if (tc.type === 'auto') return 'auto'
  if (tc.type === 'required') return 'any'
  if (tc.type === 'tool') return { type: 'tool', name: tc.toolName }
  return undefined
}

// ─── Usage conversion: SDK → V3 ──────────────────────────

function convertUsage(usage: any) {
  return {
    inputTokens: {
      total: usage?.inputTokens ?? 0,
      noCache: undefined,
      cacheRead: usage?.cacheReadInputTokens ?? undefined,
      cacheWrite: usage?.cacheCreationInputTokens ?? undefined,
    },
    outputTokens: {
      total: usage?.outputTokens ?? 0,
      text: undefined,
      reasoning: undefined,
    },
  }
}

function convertFinishReason(stopReason: string | null) {
  const map: Record<string, string> = {
    end_turn: 'stop',
    max_tokens: 'length',
    tool_use: 'tool-calls',
  }
  return {
    unified: map[stopReason ?? ''] ?? 'other',
    raw: stopReason ?? undefined,
  }
}

// ─── The LanguageModelV3 implementation ───────────────────

function createLanguageModel(sdk: ClaudeCodeSDK, modelId: string, providerId: string, keepalive?: CacheKeepalive): LanguageModelV3 {
  return {
    specificationVersion: 'v3' as const,
    provider: providerId,
    modelId,
    supportedUrls: {},

    async doGenerate(options: any) {
      dbg('doGenerate', { modelId, promptLen: options.prompt?.length, hasTools: !!options.tools?.length })
      const { system, messages } = convertPrompt(options.prompt)
      const tools = convertTools(options.tools)
      const toolChoice = convertToolChoice(options.toolChoice)

      const sdkOpts: any = {
        model: modelId,
        messages,
        maxTokens: options.maxOutputTokens ?? 16384,
        signal: options.abortSignal,
      }
      if (system) sdkOpts.system = system
      if (tools?.length) sdkOpts.tools = tools
      if (toolChoice) sdkOpts.toolChoice = toolChoice
      if (options.temperature !== undefined) sdkOpts.temperature = options.temperature
      if (options.stopSequences?.length) sdkOpts.stopSequences = options.stopSequences

      // Thinking config from providerOptions (effort variant) or default
      const po = options.providerOptions?.['claude-max'] ?? options.providerOptions ?? {}
      const thinking = po.thinking ?? po
      if (thinking?.type === 'enabled' && thinking?.budgetTokens) {
        sdkOpts.thinking = { type: 'enabled', budgetTokens: thinking.budgetTokens }
      } else {
        const is46 = modelId.includes('opus-4-6') || modelId.includes('sonnet-4-6')
        if (is46) sdkOpts.thinking = { type: 'enabled', budgetTokens: 10000 }
      }

      const response = await sdk.generate(sdkOpts)

      // Convert content blocks to V3 format
      const content: any[] = []
      for (const block of response.content) {
        if (block.type === 'text') {
          content.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking') {
          content.push({
            type: 'reasoning', text: (block as any).thinking,
            providerMetadata: (block as any).signature ? { 'claude-max': { signature: (block as any).signature } } : undefined,
          })
        } else if (block.type === 'tool_use') {
          content.push({
            type: 'tool-call',
            toolCallId: (block as any).id,
            toolName: (block as any).name,
            input: JSON.stringify((block as any).input ?? {}),
          })
        }
      }

      const u = response.usage
      logStats(`[${new Date().toISOString()}] model=${modelId} type=generate | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${response.stopReason}`)

      return {
        content,
        finishReason: convertFinishReason(response.stopReason),
        usage: convertUsage(response.usage),
        warnings: [],
        response: { id: undefined, timestamp: new Date(), modelId },
      }
    },

    async doStream(options: any) {
      const t0 = Date.now()
      dbg('doStream', { modelId, promptLen: options.prompt?.length, hasTools: !!options.tools?.length })
      const { system, messages } = convertPrompt(options.prompt)
      const tools = convertTools(options.tools)
      const toolChoice = convertToolChoice(options.toolChoice)

      const sdkOpts: any = {
        model: modelId,
        messages,
        maxTokens: options.maxOutputTokens ?? 16384,
        signal: options.abortSignal,
      }
      if (system) sdkOpts.system = system
      if (tools?.length) sdkOpts.tools = tools
      if (toolChoice) sdkOpts.toolChoice = toolChoice
      if (options.temperature !== undefined) sdkOpts.temperature = options.temperature
      if (options.stopSequences?.length) sdkOpts.stopSequences = options.stopSequences

      // Thinking config from providerOptions (effort variant) or default
      const po = options.providerOptions?.['claude-max'] ?? options.providerOptions ?? {}
      const thinking = po.thinking ?? po
      if (thinking?.type === 'enabled' && thinking?.budgetTokens) {
        sdkOpts.thinking = { type: 'enabled', budgetTokens: thinking.budgetTokens }
        dbg('doStream thinking from variant:', sdkOpts.thinking)
      } else {
        const is46 = modelId.includes('opus-4-6') || modelId.includes('sonnet-4-6')
        if (is46) sdkOpts.thinking = { type: 'enabled', budgetTokens: 10000 }
      }

      const sdkStream = sdk.stream(sdkOpts)

      // IDs for lifecycle events
      let textId = ''
      let reasoningId = ''
      let toolId = ''
      let textActive = false
      let reasoningActive = false
      let currentToolInput = ''
      let currentSignature: string | undefined

      const stream = new ReadableStream({
        async start(controller) {
          // First event must be stream-start
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'response-metadata', modelId })

          let firstEvent = true
          try {
            for await (const event of sdkStream) {
              if (firstEvent) {
                dbg(`doStream first event after ${Date.now() - t0}ms`, { type: event.type, modelId })
                firstEvent = false
              }
              switch (event.type) {
                case 'text_delta': {
                  if (!textActive) {
                    textId = `text-${Date.now()}`
                    controller.enqueue({ type: 'text-start', id: textId })
                    textActive = true
                  }
                  controller.enqueue({ type: 'text-delta', id: textId, delta: event.text })
                  break
                }

                case 'thinking_delta': {
                  if (!reasoningActive) {
                    reasoningId = `reasoning-${Date.now()}`
                    controller.enqueue({ type: 'reasoning-start', id: reasoningId })
                    reasoningActive = true
                  }
                  controller.enqueue({ type: 'reasoning-delta', id: reasoningId, delta: event.text })
                  break
                }

                case 'thinking_end': {
                  currentSignature = event.signature
                  if (reasoningActive) {
                    controller.enqueue({ type: 'reasoning-end', id: reasoningId, providerMetadata: currentSignature ? { 'claude-max': { signature: currentSignature } } : undefined })
                    reasoningActive = false
                  }
                  break
                }

                case 'tool_use_start': {
                  // Close any open text/reasoning
                  if (textActive) { controller.enqueue({ type: 'text-end', id: textId }); textActive = false }
                  if (reasoningActive) { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningActive = false }

                  toolId = event.id
                  currentToolInput = ''
                  controller.enqueue({
                    type: 'tool-input-start',
                    id: toolId,
                    toolName: event.name,
                  })
                  break
                }

                case 'tool_use_delta': {
                  const partial = event.partialInput ?? ''
                  if (partial) {
                    currentToolInput += partial
                    controller.enqueue({ type: 'tool-input-delta', id: toolId, delta: partial })
                  }
                  break
                }

                case 'tool_use_end': {
                  controller.enqueue({ type: 'tool-input-end', id: toolId })
                  // Emit complete tool-call
                  const inputStr = currentToolInput || JSON.stringify(event.input ?? {})
                  controller.enqueue({
                    type: 'tool-call',
                    toolCallId: event.id,
                    toolName: event.name,
                    input: inputStr,
                  })
                  toolId = ''
                  currentToolInput = ''
                  break
                }

                case 'message_stop': {
                  const dur = Date.now() - t0
                  const u = event.usage
                  logStats(`[${new Date().toISOString()}] model=${modelId} type=stream dur=${dur}ms | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${event.stopReason}`)
                  // Capture snapshot for keepalive
                  const totalInput = (u?.inputTokens ?? 0) + (u?.cacheReadInputTokens ?? 0) + (u?.cacheCreationInputTokens ?? 0)
                  if (keepalive && totalInput > 0) {
                    keepalive.capture(modelId, system, messages, tools, totalInput)
                  }
                  dbg(`doStream complete in ${dur}ms`, { modelId, stopReason: event.stopReason })
                  if (textActive) { controller.enqueue({ type: 'text-end', id: textId }); textActive = false }
                  if (reasoningActive) { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningActive = false }

                  controller.enqueue({
                    type: 'finish',
                    usage: convertUsage(event.usage),
                    finishReason: convertFinishReason(event.stopReason ?? null),
                  })
                  break
                }
              }
            }
          } catch (err) {
            controller.enqueue({ type: 'error', error: err })
          }

          controller.close()
        },
      })

      return { stream }
    },
  }
}

// ─── Provider factory ─────────────────────────────────────

export interface ClaudeMaxProviderOptions {
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
  credentialsPath?: string
}

// ─── Cache Keepalive ──────────────────────────────────────

const KEEPALIVE_ENABLED = process.env.CLAUDE_MAX_KEEPALIVE !== '0'
const KEEPALIVE_INTERVAL = (parseInt(process.env.CLAUDE_MAX_KEEPALIVE_INTERVAL ?? '240') || 240) * 1000
const KEEPALIVE_IDLE_TIMEOUT = (parseInt(process.env.CLAUDE_MAX_KEEPALIVE_IDLE ?? '1800') || 1800) * 1000
const KEEPALIVE_MIN_TOKENS = parseInt(process.env.CLAUDE_MAX_KEEPALIVE_MIN_TOKENS ?? '2000') || 2000

interface CacheSnapshot {
  model: string
  system?: string
  messages: any[]
  tools?: any[]
  inputTokens: number
  lastActivityAt: number
}

class CacheKeepalive {
  private snapshot: CacheSnapshot | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private sdk: ClaudeCodeSDK

  constructor(sdk: ClaudeCodeSDK) { this.sdk = sdk }

  capture(model: string, system: string | undefined, messages: any[], tools: any[] | undefined, inputTokens: number) {
    this.snapshot = { model, system, messages, tools, inputTokens, lastActivityAt: Date.now() }
    this.ensureTimer()
  }

  private ensureTimer() {
    if (this.timer || !KEEPALIVE_ENABLED) return
    this.timer = setInterval(() => this.tick(), KEEPALIVE_INTERVAL)
    // Unref so timer doesn't prevent process exit
    if (this.timer && typeof this.timer === 'object' && 'unref' in this.timer) {
      (this.timer as any).unref()
    }
    dbg('keepalive timer started', { interval: KEEPALIVE_INTERVAL / 1000 + 's', idleTimeout: KEEPALIVE_IDLE_TIMEOUT / 1000 + 's' })
  }

  private async tick() {
    if (!this.snapshot) return
    const idle = Date.now() - this.snapshot.lastActivityAt

    // Stop if idle too long
    if (idle > KEEPALIVE_IDLE_TIMEOUT) {
      dbg('keepalive stopped: idle timeout', { idle: Math.round(idle / 1000) + 's' })
      this.stop()
      return
    }

    // Skip if context too small
    if (this.snapshot.inputTokens < KEEPALIVE_MIN_TOKENS) {
      dbg('keepalive skip: context too small', { tokens: this.snapshot.inputTokens })
      return
    }

    // Only fire if actually idle (not during active request)
    if (idle < KEEPALIVE_INTERVAL * 0.8) {
      dbg('keepalive skip: recent activity', { idle: Math.round(idle / 1000) + 's' })
      return
    }

    dbg('keepalive firing', { model: this.snapshot.model, tokens: this.snapshot.inputTokens, idle: Math.round(idle / 1000) + 's' })

    try {
      const t0 = Date.now()
      const opts: any = {
        model: this.snapshot.model,
        messages: this.snapshot.messages,
        maxTokens: 1,
        thinking: { type: 'disabled' },
      }
      if (this.snapshot.system) opts.system = this.snapshot.system
      if (this.snapshot.tools?.length) opts.tools = this.snapshot.tools

      let usage: any
      for await (const event of this.sdk.stream(opts)) {
        if (event.type === 'message_stop') usage = event.usage
      }
      const dur = Date.now() - t0
      const u = usage ?? {}
      logStats(`[${new Date().toISOString()}] model=${this.snapshot.model} type=keepalive dur=${dur}ms | in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0} cacheRead=${u.cacheReadInputTokens ?? 0} cacheWrite=${u.cacheCreationInputTokens ?? 0} | idle=${Math.round(idle / 1000)}s`)
      dbg('keepalive done', { dur, cacheRead: u.cacheReadInputTokens ?? 0 })
    } catch (err) {
      dbg('keepalive error:', err instanceof Error ? err.message : String(err))
    }
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.snapshot = null
  }
}

export function createClaudeMax(options: ClaudeMaxProviderOptions = {}) {
  dbg('createClaudeMax called with:', { hasAccessToken: !!options.accessToken, credentialsPath: options.credentialsPath, allKeys: Object.keys(options) })
  const sdk = new ClaudeCodeSDK({
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    expiresAt: options.expiresAt,
    credentialsPath: options.credentialsPath,
  })

  const keepalive = new CacheKeepalive(sdk)

  // Cleanup on process exit
  process.on('exit', () => keepalive.stop())

  return {
    languageModel(modelId: string): LanguageModelV3 {
      dbg('languageModel requested:', modelId)
      return createLanguageModel(sdk, modelId, 'claude-max', keepalive)
    },
  }
}
