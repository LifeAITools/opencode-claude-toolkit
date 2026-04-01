#!/usr/bin/env bun
/**
 * opencode-proxy — OpenAI-compatible HTTP server backed by claude-code-sdk.
 *
 * Allows opencode (and any OpenAI-compatible client) to use Claude Max/Pro
 * subscription credentials instead of an API key.
 *
 * Usage:
 *   bun run server.ts [--port 4040] [--credentials ~/.claude/.credentials.json]
 *
 * opencode config:
 *   LOCAL_ENDPOINT=http://localhost:4040/v1 opencode
 *
 * Routes:
 *   GET  /v1/models              — list available models
 *   POST /v1/chat/completions    — streaming and non-streaming chat
 *   GET  /health                 — health check
 */

import { ClaudeCodeSDK } from '@lifeaitools/claude-code-sdk'
import type { GenerateOptions, StreamEvent } from '@lifeaitools/claude-code-sdk'
import {
  toSDKMessages,
  toSDKTools,
  toSDKToolChoice,
  extractSystem,
  resolveModel,
  SUPPORTED_MODELS,
} from './translate.js'
import type { OAIChatRequest } from './translate.js'
import { randomUUID } from 'crypto'

// ============================================================
// CLI args
// ============================================================

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const PORT = portIdx >= 0 ? parseInt(args[portIdx + 1]) : parseInt(process.env.PROXY_PORT ?? '4040')
const credentialsPath = (() => {
  const idx = args.indexOf('--credentials')
  return idx >= 0 ? args[idx + 1] : undefined
})()

// ============================================================
// SDK instance (shared, lazy auth)
// ============================================================

const sdk = new ClaudeCodeSDK({ credentialsPath, timeout: 600_000 })

// ============================================================
// Server
// ============================================================

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255, // max seconds — prevent Bun from killing long SSE streams (Opus thinking)
  async fetch(req) {
    const url = new URL(req.url)

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }

    // Health
    if (url.pathname === '/health' && req.method === 'GET') {
      return json({ status: 'ok', models: SUPPORTED_MODELS.map(m => m.id) })
    }

    // Models list
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return json({
        object: 'list',
        data: SUPPORTED_MODELS.map(m => ({
          id: m.id,
          object: 'model',
          created: 1700000000,
          owned_by: 'anthropic',
        })),
      })
    }

    // Chat completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      let body: OAIChatRequest
      try {
        body = await req.json() as OAIChatRequest
      } catch {
        return errorResponse(400, 'invalid_request', 'Invalid JSON body')
      }

      try {
        if (body.stream) {
          return handleStream(body, req.signal)
        } else {
          return await handleNonStream(body)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error('[proxy] Error:', msg)
        return errorResponse(500, 'internal_error', msg)
      }
    }

    return errorResponse(404, 'not_found', `Unknown route: ${url.pathname}`)
  },
})

console.log(`[opencode-proxy] Running on http://localhost:${PORT}`)
console.log(`[opencode-proxy] Set LOCAL_ENDPOINT=http://localhost:${PORT}/v1 in opencode`)
console.log(`[opencode-proxy] Credentials: ${credentialsPath ?? '~/.claude/.credentials.json'}`)

// ============================================================
// Non-streaming handler
// ============================================================

async function handleNonStream(body: OAIChatRequest): Promise<Response> {
  const start = Date.now()
  console.log(`[proxy] ${new Date().toISOString()} generate ${body.model} msgs=${body.messages.length}`)
  const opts = buildSDKOptions(body)
  const response = await sdk.generate(opts)
  console.log(`[proxy] ${new Date().toISOString()} done ${Date.now() - start}ms in=${response.usage.inputTokens} out=${response.usage.outputTokens}`)

  const content = response.content
    .filter(b => b.type === 'text')
    .map(b => b.type === 'text' ? b.text : '')
    .join('')

  const toolCalls = response.toolCalls?.map(tc => ({
    id: tc.id,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input),
    },
  }))

  const message: Record<string, unknown> = {
    role: 'assistant',
    content: content || null,
  }
  if (toolCalls?.length) {
    message.tool_calls = toolCalls
  }

  return json({
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{
      index: 0,
      message,
      finish_reason: mapFinishReason(response.stopReason),
    }],
    usage: {
      prompt_tokens: response.usage.inputTokens,
      completion_tokens: response.usage.outputTokens,
      total_tokens: response.usage.inputTokens + response.usage.outputTokens,
      prompt_tokens_details: {
        cached_tokens: response.usage.cacheReadInputTokens ?? 0,
      },
    },
  })
}

// ============================================================
// Streaming handler — SSE
// ============================================================

function handleStream(body: OAIChatRequest, signal: AbortSignal): Response {
  const opts = buildSDKOptions(body)
  const completionId = `chatcmpl-${randomUUID()}`
  const startTime = Date.now()

  console.log(`[proxy] ${new Date().toISOString()} stream ${body.model} msgs=${body.messages.length}`)

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      let closed = false
      let chunks = 0

      function safeEnqueue(data: Uint8Array): boolean {
        if (closed) return false
        try {
          controller.enqueue(data)
          return true
        } catch {
          closed = true
          return false
        }
      }

      function emit(data: Record<string, unknown>) {
        if (closed) return
        if (safeEnqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`))) {
          chunks++
        }
      }

      function finish() {
        if (closed) return
        closed = true // set BEFORE any controller ops to prevent races
        try {
          controller.enqueue(enc.encode('data: [DONE]\n\n'))
          controller.close()
        } catch { /* already closed by client disconnect */ }
        console.log(`[proxy] ${new Date().toISOString()} done ${chunks} chunks ${Date.now() - startTime}ms`)
      }

      // Detect client disconnect via abort signal
      signal.addEventListener('abort', () => {
        if (!closed) {
          closed = true
          console.log(`[proxy] ${new Date().toISOString()} client disconnected after ${chunks} chunks ${Date.now() - startTime}ms`)
          try { controller.close() } catch { /* ok */ }
        }
      })

      // Accumulate partial tool input per tool_use_id
      const toolInputBuffers: Map<string, { name: string; buffer: string }> = new Map()
      let currentToolId: string | null = null

      try {
        for await (const event of sdk.stream({ ...opts, signal })) {
          if (closed) break
          await dispatchEvent(event)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[proxy] ${new Date().toISOString()} error: ${msg}`)
        emit({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })
      }

      finish()

      async function dispatchEvent(event: StreamEvent) {
        switch (event.type) {
          case 'text_delta': {
            emit({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: event.text },
                finish_reason: null,
              }],
            })
            break
          }

          case 'thinking_delta': {
            // Send thinking as a non-standard delta field
            // Most OpenAI clients ignore unknown delta fields gracefully
            emit({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                delta: { thinking: event.text },
                finish_reason: null,
              }],
            })
            break
          }

          case 'tool_use_start': {
            currentToolId = event.id
            toolInputBuffers.set(event.id, { name: event.name, buffer: '' })
            // Emit tool_calls start chunk
            emit({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{
                    index: 0,
                    id: event.id,
                    type: 'function',
                    function: { name: event.name, arguments: '' },
                  }],
                },
                finish_reason: null,
              }],
            })
            break
          }

          case 'tool_use_delta': {
            if (currentToolId) {
              const tb = toolInputBuffers.get(currentToolId)
              if (tb) tb.buffer += event.partialInput
              // Emit incremental arguments
              emit({
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: 0,
                      function: { arguments: event.partialInput },
                    }],
                  },
                  finish_reason: null,
                }],
              })
            }
            break
          }

          case 'tool_use_end': {
            currentToolId = null
            break
          }

          case 'message_stop': {
            emit({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: mapFinishReason(event.stopReason),
              }],
              usage: {
                prompt_tokens: event.usage.inputTokens,
                completion_tokens: event.usage.outputTokens,
                total_tokens: event.usage.inputTokens + event.usage.outputTokens,
                prompt_tokens_details: {
                  cached_tokens: event.usage.cacheReadInputTokens ?? 0,
                },
              },
            })
            break
          }

          case 'error': {
            console.error('[proxy] SDK stream error:', event.error.message)
            break
          }
        }
      }
    },
  })

  return new Response(stream, {
    headers: {
      ...corsHeaders(),
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// ============================================================
// Helpers
// ============================================================

function buildSDKOptions(body: OAIChatRequest): GenerateOptions {
  const model = resolveModel(body.model)
  const messages = toSDKMessages(body.messages)
  const system = extractSystem(body.messages)
  const tools = toSDKTools(body.tools)
  const toolChoice = toSDKToolChoice(body.tool_choice)

  const opts: GenerateOptions = {
    model,
    messages,
    maxTokens: body.max_tokens ?? 16384,
    caching: true, // Always enable — handled by SDK
  }

  if (system) opts.system = system
  if (tools?.length) opts.tools = tools
  if (toolChoice) opts.toolChoice = toolChoice
  if (body.temperature !== undefined) opts.temperature = body.temperature
  if (body.top_p !== undefined) opts.topP = body.top_p
  if (body.stop) {
    opts.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop]
  }

  // reasoning_effort → effort (for Opus/Sonnet 4.6 which support it)
  // opencode sends this when model.CanReason=true and ProviderLocal
  if (body.reasoning_effort) {
    opts.effort = body.reasoning_effort
  }

  return opts
}

function mapFinishReason(stopReason: string | null): string {
  switch (stopReason) {
    case 'end_turn': return 'stop'
    case 'max_tokens': return 'length'
    case 'tool_use': return 'tool_calls'
    default: return 'stop'
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, type: string, message: string): Response {
  return json({ error: { type, message } }, status)
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}
