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

const DEBUG = process.env.CLAUDE_MAX_DEBUG !== '0'
const LOG_FILE = join(homedir(), '.claude', 'claude-max-debug.log')
const STATS_FILE = join(homedir(), '.claude', 'claude-max-stats.log')
const STATS_JSONL = join(homedir(), '.claude', 'claude-max-stats.jsonl')

const PID = process.pid
const SESSION = process.env.OPENCODE_SESSION_SLUG ?? process.env.OPENCODE_SESSION_ID?.slice(0, 12) ?? '?'

function logStats(line: string, structured?: Record<string, unknown>) {
  try { appendFileSync(STATS_FILE, `${line} pid=${PID} ses=${SESSION}\n`) } catch {}
  if (structured) {
    try { appendFileSync(STATS_JSONL, JSON.stringify({ ts: new Date().toISOString(), pid: PID, ses: SESSION, ...structured }) + '\n') } catch {}
  }
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
      // MUST deep-copy — addCacheMarkers mutates message content in-place,
      // and opencode passes content arrays by reference. Without copy,
      // cache_control markers leak into opencode's internal state, causing
      // cache misses on session restart (content differs by baked-in markers).
      system = typeof msg.content === 'string' ? msg.content : JSON.parse(JSON.stringify(msg.content))
      // Strip opencode's billing header from system prompt — it contains a non-deterministic
      // version number (cc_version=0.1.0.XXX) that changes on every process restart,
      // invalidating the entire cache prefix. The LLM doesn't need this header.
      if (typeof system === 'string') {
        system = system.replace(/x-anthropic-billing-header:[^\n]*\n?/g, '').trim() || undefined
      } else if (Array.isArray(system)) {
        for (const block of system as { type: string; text?: string }[]) {
          if (block.type === 'text' && block.text) {
            block.text = block.text.replace(/x-anthropic-billing-header:[^\n]*\n?/g, '').trim()
          }
        }
        // Remove empty text blocks
        system = (system as { type: string; text?: string }[]).filter(b => b.type !== 'text' || (b.text && b.text.length > 0))
        if ((system as unknown[]).length === 0) system = undefined
      }
      continue
    }

    if (msg.role === 'user') {
      const parts = Array.isArray(msg.content) ? msg.content : [{ type: 'text', text: msg.content }]
      const content: any[] = []
      for (const p of parts) {
        if (p.type === 'text') content.push({ type: 'text', text: p.text || '...' })
        // file parts: convert to Anthropic content blocks based on mediaType
        if (p.type === 'file' && typeof p.mediaType === 'string') {
          // Check if data is a URL (string URL or URL object)
          const isUrl = p.data instanceof URL || (typeof p.data === 'string' && (p.data.startsWith('http://') || p.data.startsWith('https://')))
          if (isUrl) {
            const url = typeof p.data === 'string' ? p.data : p.data.toString()
            if (p.mediaType.startsWith('image/')) {
              content.push({ type: 'image', source: { type: 'url', url } } as any)
              dbg('Converted file part to image URL block:', p.mediaType, url)
            } else if (p.mediaType === 'application/pdf') {
              content.push({ type: 'document', source: { type: 'url', url } } as any)
              dbg('Converted file part to document URL block:', url)
            }
            continue
          }
          // Inline data: base64 string, Uint8Array, or ArrayBuffer
          const data = typeof p.data === 'string' ? p.data
            : p.data instanceof Uint8Array ? Buffer.from(p.data).toString('base64')
            : p.data instanceof ArrayBuffer ? Buffer.from(p.data).toString('base64')
            : null
          if (!data) {
            dbg('Skipping file part: could not convert data to base64, type:', typeof p.data)
            continue
          }
          if (p.mediaType.startsWith('image/')) {
            // image/* → Anthropic image content block
            // Anthropic requires specific MIME type — "image/*" wildcard is invalid, default to jpeg
            const mediaType = p.mediaType === 'image/*' ? 'image/jpeg' : p.mediaType
            content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } })
            dbg('Converted file part to image block:', mediaType, `${data.length} chars base64`)
          } else if (p.mediaType === 'application/pdf') {
            // PDF → Anthropic document content block
            content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } })
            dbg('Converted file part to document block:', `${data.length} chars base64`)
          } else {
            // Unsupported mediaType — skip silently (don't crash)
            dbg('Skipping file part with unsupported mediaType:', p.mediaType)
          }
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
  // Total input = base + cacheRead + cacheWrite (full prompt size)
  const baseIn = usage?.inputTokens ?? 0
  const cacheRead = usage?.cacheReadInputTokens ?? 0
  const cacheWrite = usage?.cacheCreationInputTokens ?? 0
  const totalIn = baseIn + cacheRead + cacheWrite

  return {
    inputTokens: {
      total: totalIn,
      noCache: baseIn,
      cacheRead: cacheRead || undefined,
      cacheWrite: cacheWrite || undefined,
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

function createLanguageModel(sdk: ClaudeCodeSDK, modelId: string, providerId: string): LanguageModelV3 {
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
      const rl = sdk.getRateLimitInfo()
      const rlStr = rl.status ? ` | quota=${rl.status} claim=${rl.claim ?? '?'} util5h=${rl.utilization5h ?? '?'} util7d=${rl.utilization7d ?? '?'}` : ''
      logStats(`[${new Date().toISOString()}] model=${modelId} type=generate | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${response.stopReason}${rlStr}`, {
        type: 'generate', model: modelId, dur: 0, stop: response.stopReason,
        usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheCreationInputTokens ?? 0 },
        rateLimit: rl.status ? { status: rl.status, claim: rl.claim, resetAt: rl.resetAt, util5h: rl.utilization5h, util7d: rl.utilization7d } : undefined,
      })

      return {
        content,
        finishReason: convertFinishReason(response.stopReason),
        usage: convertUsage(response.usage),
        providerMetadata: {
          'claude-max': {
            cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
          },
          anthropic: {
            cacheCreationInputTokens: u?.cacheCreationInputTokens ?? 0,
            cacheReadInputTokens: u?.cacheReadInputTokens ?? 0,
          },
        },
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
                  const rl = sdk.getRateLimitInfo()
                  const rlStr = rl.status ? ` | quota=${rl.status} claim=${rl.claim ?? '?'} util5h=${rl.utilization5h ?? '?'} util7d=${rl.utilization7d ?? '?'}` : ''
                  logStats(`[${new Date().toISOString()}] model=${modelId} type=stream dur=${dur}ms | in=${u?.inputTokens ?? 0} out=${u?.outputTokens ?? 0} cacheRead=${u?.cacheReadInputTokens ?? 0} cacheWrite=${u?.cacheCreationInputTokens ?? 0} | stop=${event.stopReason}${rlStr}`, {
                    type: 'stream', model: modelId, dur, stop: event.stopReason,
                    usage: { in: u?.inputTokens ?? 0, out: u?.outputTokens ?? 0, cacheRead: u?.cacheReadInputTokens ?? 0, cacheWrite: u?.cacheCreationInputTokens ?? 0 },
                    rateLimit: rl.status ? { status: rl.status, claim: rl.claim, resetAt: rl.resetAt, util5h: rl.utilization5h, util7d: rl.utilization7d } : undefined,
                  })
                  dbg(`doStream complete in ${dur}ms`, { modelId, stopReason: event.stopReason })
                  if (textActive) { controller.enqueue({ type: 'text-end', id: textId }); textActive = false }
                  if (reasoningActive) { controller.enqueue({ type: 'reasoning-end', id: reasoningId }); reasoningActive = false }

                  const eu = event.usage
                  controller.enqueue({
                    type: 'finish',
                    usage: convertUsage(eu),
                    finishReason: convertFinishReason(event.stopReason ?? null),
                    providerMetadata: {
                      'claude-max': {
                        cacheCreationInputTokens: eu?.cacheCreationInputTokens ?? 0,
                        cacheReadInputTokens: eu?.cacheReadInputTokens ?? 0,
                      },
                      // Also under 'anthropic' key for opencode compatibility
                      anthropic: {
                        cacheCreationInputTokens: eu?.cacheCreationInputTokens ?? 0,
                        cacheReadInputTokens: eu?.cacheReadInputTokens ?? 0,
                      },
                    },
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

export function createClaudeMax(options: ClaudeMaxProviderOptions = {}) {
  dbg('createClaudeMax called with:', { hasAccessToken: !!options.accessToken, credentialsPath: options.credentialsPath, allKeys: Object.keys(options) })
  const sdk = new ClaudeCodeSDK({
    accessToken: options.accessToken,
    refreshToken: options.refreshToken,
    expiresAt: options.expiresAt,
    credentialsPath: options.credentialsPath,
    keepalive: {
      enabled: process.env.CLAUDE_MAX_KEEPALIVE !== '0',
      // Fire at ~120s (2 min), giving ~180s margin before 5-min cache TTL for retries.
      // Override with CLAUDE_MAX_KEEPALIVE_INTERVAL env var (seconds).
      intervalMs: (parseInt(process.env.CLAUDE_MAX_KEEPALIVE_INTERVAL ?? '120') || 120) * 1000,
      // Stop keepalive after 30 min of no real user activity.
      idleTimeoutMs: (parseInt(process.env.CLAUDE_MAX_KEEPALIVE_IDLE ?? '1800') || 1800) * 1000,
      onTick: (tick) => {
        dbg(`keepalive tick: idle=${Math.round(tick.idleMs/1000)}s nextFire=${Math.round(tick.nextFireMs/1000)}s model=${tick.model}`)
      },
      onHeartbeat: (stats) => {
        const rl = stats.rateLimit ? ` | quota=${stats.rateLimit.status ?? '?'} claim=${stats.rateLimit.claim ?? '?'}` : ''
        logStats(`[${new Date().toISOString()}] model=${stats.model} type=keepalive dur=${stats.durationMs}ms | in=${stats.usage.inputTokens} out=${stats.usage.outputTokens} cacheRead=${stats.usage.cacheReadInputTokens ?? 0} cacheWrite=${stats.usage.cacheCreationInputTokens ?? 0} | idle=${Math.round(stats.idleMs / 1000)}s${rl}`, {
          type: 'keepalive', model: stats.model, dur: stats.durationMs, idle: Math.round(stats.idleMs / 1000),
          usage: { in: stats.usage.inputTokens, out: stats.usage.outputTokens, cacheRead: stats.usage.cacheReadInputTokens ?? 0, cacheWrite: stats.usage.cacheCreationInputTokens ?? 0 },
          rateLimit: stats.rateLimit ?? undefined,
        })
        dbg('keepalive FIRED', { model: stats.model, dur: stats.durationMs, cacheRead: stats.usage.cacheReadInputTokens ?? 0, rateLimit: stats.rateLimit })
      },
    },
  })

  return {
    languageModel(modelId: string): LanguageModelV3 {
      dbg('languageModel requested:', modelId)
      return createLanguageModel(sdk, modelId, 'claude-max')
    },
  }
}
