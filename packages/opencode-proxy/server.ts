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

import { ClaudeCodeSDK, RateLimitError, AuthError, APIError } from '@life-ai-tools/claude-code-sdk'
import type { GenerateOptions, StreamEvent } from '@life-ai-tools/claude-code-sdk'
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
import { spawn } from 'bun'
import { writeFileSync, readFileSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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
const VERBOSE = args.includes('--verbose') || process.env.PROXY_VERBOSE === '1'
const LOG_DIR = process.env.PROXY_LOG_DIR ?? ''

// ============================================================
// Logging helpers
// ============================================================

function ts(): string {
  return new Date().toISOString()
}

function logUsage(prefix: string, usage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number }) {
  const parts = [
    `in=${usage.inputTokens}`,
    `out=${usage.outputTokens}`,
  ]
  if (usage.cacheReadInputTokens) {
    parts.push(`cache_read=${usage.cacheReadInputTokens}`)
    const hitRate = ((usage.cacheReadInputTokens / usage.inputTokens) * 100).toFixed(0)
    parts.push(`hit=${hitRate}%`)
  }
  if (usage.cacheCreationInputTokens) {
    parts.push(`cache_write=${usage.cacheCreationInputTokens}`)
  }
  console.log(`${prefix} ${parts.join(' ')}`)
}

/** Dump raw SSE event to log file for debugging */
function dumpEvent(requestId: string, event: StreamEvent) {
  if (!VERBOSE) return
  const line = `[${ts()}] [${requestId}] ${JSON.stringify(event)}`
  console.log(`[proxy:dump] ${event.type}${event.type === 'text_delta' ? ` (${(event as any).text?.length ?? 0} chars)` : ''}`)
  if (LOG_DIR) {
    try {
      const file = `${LOG_DIR}/proxy-${requestId}.jsonl`
      Bun.write(file, line + '\n', { append: true } as any)
    } catch { /* best effort */ }
  }
}

// ============================================================
// Active connection tracking
// ============================================================

let activeStreams = 0
let draining = false  // when true, new requests get redirected to new proxy

function streamStart() { activeStreams++ }
function streamEnd() {
  activeStreams--
  if (draining && activeStreams <= 0) {
    console.log(`[proxy] ${ts()} All streams drained — shutting down old instance`)
    process.exit(0)
  }
}

// ============================================================
// PID file for daemon management
// ============================================================

const PID_FILE = join(tmpdir(), `opencode-proxy-${PORT}.pid`)

function writePidFile() {
  writeFileSync(PID_FILE, String(process.pid))
}

function readPidFile(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf8').trim())
    // Check if process is actually running
    try { process.kill(pid, 0); return pid } catch { return null }
  } catch { return null }
}

function removePidFile() {
  try { unlinkSync(PID_FILE) } catch { /* ok */ }
}

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
      return json({
        status: draining ? 'draining' : 'ok',
        models: SUPPORTED_MODELS.map(m => m.id),
        pid: process.pid,
        activeStreams,
        uptime: Math.floor(process.uptime()),
      })
    }

    // Admin: status
    if (url.pathname === '/admin/status' && req.method === 'GET') {
      return json({
        pid: process.pid,
        port: PORT,
        activeStreams,
        draining,
        uptime: Math.floor(process.uptime()),
        verbose: VERBOSE,
      })
    }

    // Admin: graceful reload — start new proxy, drain old
    if (url.pathname === '/admin/reload' && req.method === 'POST') {
      if (draining) {
        return json({ status: 'already_draining', activeStreams })
      }
      console.log(`[proxy] ${ts()} Reload requested — spawning new instance...`)
      const result = await gracefulReload()
      return json(result)
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
      // If draining, reject new requests — client should retry and hit new proxy
      if (draining) {
        return errorResponse(503, 'service_unavailable', 'Proxy is reloading, retry in a moment')
      }

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
        if (err instanceof RateLimitError) {
          const retryAfter = err.rateLimitInfo?.retryAfter
          console.error(`[proxy] Rate limited${retryAfter ? ` (retry after ${retryAfter}s)` : ''}`)
          const headers: Record<string, string> = {}
          if (retryAfter) headers['retry-after'] = String(Math.ceil(retryAfter))
          return errorResponse(429, 'rate_limit_error', msg, headers)
        }
        if (err instanceof AuthError) {
          console.error('[proxy] Auth error:', msg)
          return errorResponse(401, 'authentication_error', msg)
        }
        if (err instanceof APIError) {
          console.error(`[proxy] API error ${err.status}:`, msg)
          return errorResponse(err.status, 'api_error', msg)
        }
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
console.log(`[opencode-proxy] Verbose: ${VERBOSE ? 'ON (--verbose)' : 'off'}${LOG_DIR ? ` Log dir: ${LOG_DIR}` : ''}`)

// ============================================================
// Non-streaming handler
// ============================================================

async function handleNonStream(body: OAIChatRequest): Promise<Response> {
  const start = Date.now()
  const reqId = randomUUID().slice(0, 8)
  console.log(`[proxy] ${ts()} [${reqId}] generate ${body.model} msgs=${body.messages.length}`)
  const opts = buildSDKOptions(body)
  const response = await sdk.generate(opts)
  logUsage(`[proxy] ${ts()} [${reqId}] done ${Date.now() - start}ms`, response.usage)

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
        cache_creation_tokens: response.usage.cacheCreationInputTokens ?? 0,
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
  const reqId = completionId.slice(-8)
  const startTime = Date.now()

  streamStart()
  console.log(`[proxy] ${ts()} [${reqId}] stream ${body.model} msgs=${body.messages.length} (active=${activeStreams})`)

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
        streamEnd()
        console.log(`[proxy] ${ts()} [${reqId}] done ${chunks} chunks ${Date.now() - startTime}ms (active=${activeStreams})`)
      }

      // Detect client disconnect via abort signal
      signal.addEventListener('abort', () => {
        if (!closed) {
          closed = true
          streamEnd()
          console.log(`[proxy] ${ts()} [${reqId}] client disconnected after ${chunks} chunks ${Date.now() - startTime}ms (active=${activeStreams})`)
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

        // Determine error type and status for OpenAI-compatible error response
        let errorType = 'internal_error'
        let errorStatus = 500
        if (err instanceof RateLimitError) {
          errorType = 'rate_limit_error'
          errorStatus = 429
          const retryAfter = err.rateLimitInfo?.retryAfter
          console.error(`[proxy] ${ts()} [${reqId}] RATE LIMITED${retryAfter ? ` (retry after ${retryAfter}s)` : ''}: ${msg}`)
        } else if (err instanceof AuthError) {
          errorType = 'authentication_error'
          errorStatus = 401
          console.error(`[proxy] ${ts()} [${reqId}] AUTH ERROR: ${msg}`)
        } else if (err instanceof APIError) {
          errorType = 'api_error'
          errorStatus = err.status
          console.error(`[proxy] ${ts()} [${reqId}] API ERROR ${err.status}: ${msg}`)
        } else {
          console.error(`[proxy] ${ts()} [${reqId}] ERROR: ${msg}`)
        }

        // Send error as an SSE event that OpenAI-compatible clients understand
        // First send an error data chunk so the client can display it
        emit({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: `\n\n[${errorType.toUpperCase()}] ${msg}` },
            finish_reason: null,
          }],
        })

        // Then send the finish with error reason
        emit({
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          error: { type: errorType, message: msg, status: errorStatus },
        })
      }

      finish()

      async function dispatchEvent(event: StreamEvent) {
        dumpEvent(reqId, event)
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
            // Log usage with cache breakdown
            logUsage(`[proxy] ${ts()} [${reqId}] usage`, event.usage)

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
                  cache_creation_tokens: event.usage.cacheCreationInputTokens ?? 0,
                },
              },
            })
            break
          }

          case 'error': {
            console.error(`[proxy] ${ts()} [${reqId}] SDK stream error:`, event.error.message)
            // Send error as visible content so client displays it
            emit({
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: body.model,
              choices: [{
                index: 0,
                delta: { role: 'assistant', content: `\n\n[ERROR] ${event.error.message}` },
                finish_reason: null,
              }],
            })
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

function json(data: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json', ...extraHeaders },
  })
}

function errorResponse(status: number, type: string, message: string, extraHeaders?: Record<string, string>): Response {
  return json({ error: { type, message } }, status, extraHeaders)
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  }
}

// ============================================================
// Graceful reload — zero-downtime restart
// ============================================================

async function gracefulReload(): Promise<Record<string, unknown>> {
  // 1. Find a free port for the new instance
  let newPort = PORT
  for (let p = PORT + 1; p < PORT + 20; p++) {
    try {
      const s = Bun.listen({ hostname: '127.0.0.1', port: p, socket: { data() {}, open() {}, close() {}, error() {} } })
      s.stop()
      newPort = p
      break
    } catch { /* port in use */ }
  }
  if (newPort === PORT) {
    return { status: 'error', message: 'No free port found for new instance' }
  }

  // 2. Spawn new proxy on the new port
  const serverPath = import.meta.url.replace('file://', '')
  const newProxy = spawn({
    cmd: [process.execPath, 'run', serverPath, '--port', String(newPort)],
    env: { ...process.env, PROXY_PORT: String(newPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  // 3. Wait for new instance to be healthy
  const maxWait = 10_000
  const start = Date.now()
  let healthy = false
  while (Date.now() - start < maxWait) {
    try {
      const r = await fetch(`http://localhost:${newPort}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) { healthy = true; break }
    } catch { /* not ready */ }
    await Bun.sleep(200)
  }

  if (!healthy) {
    try { newProxy.kill() } catch { /* ok */ }
    return { status: 'error', message: 'New instance failed health check' }
  }

  console.log(`[proxy] ${ts()} New instance healthy on :${newPort} (pid=${newProxy.pid})`)

  // 4. Start draining — new requests to this instance get 503
  draining = true

  // 5. Update PID file to point to new instance
  writeFileSync(PID_FILE, String(newProxy.pid))

  // 6. If no active streams, exit immediately
  if (activeStreams <= 0) {
    console.log(`[proxy] ${ts()} No active streams — exiting immediately`)
    setTimeout(() => process.exit(0), 100)
    return { status: 'reloaded', newPort, newPid: newProxy.pid, drained: true }
  }

  // 7. Otherwise, drain will happen when last stream finishes (see streamEnd())
  console.log(`[proxy] ${ts()} Draining ${activeStreams} active stream(s)...`)

  // Safety timeout: force exit after 10 minutes even if streams are stuck
  setTimeout(() => {
    if (draining) {
      console.log(`[proxy] ${ts()} Drain timeout — force exit (${activeStreams} streams still active)`)
      process.exit(0)
    }
  }, 600_000)

  return { status: 'draining', newPort, newPid: newProxy.pid, activeStreams }
}

// ============================================================
// Startup — handle daemon mode, kill old instance, write PID
// ============================================================

// Kill old instance if running on same port (we take over)
const oldPid = readPidFile()
if (oldPid && oldPid !== process.pid) {
  // Ask old instance to drain gracefully via the reload endpoint
  // If that fails, we're starting fresh (old instance may have crashed)
  try {
    const r = await fetch(`http://localhost:${PORT}/admin/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
    if (r.ok) {
      const result = await r.json() as Record<string, unknown>
      console.log(`[opencode-proxy] Asked old instance (pid=${oldPid}) to drain:`, result.status)
    }
  } catch {
    // Old instance not responding — kill it
    try {
      process.kill(oldPid, 'SIGTERM')
      console.log(`[opencode-proxy] Killed stale instance (pid=${oldPid})`)
      await Bun.sleep(500)
    } catch { /* already dead */ }
  }
}

writePidFile()
process.on('exit', removePidFile)
process.on('SIGTERM', () => {
  console.log(`[proxy] ${ts()} SIGTERM received — shutting down`)
  removePidFile()
  process.exit(0)
})
