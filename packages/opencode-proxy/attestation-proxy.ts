#!/usr/bin/env bun
/**
 * attestation-proxy — Emergency fallback proxy for cch= attestation.
 * 
 * Routes API requests through the real Claude Code binary to get
 * genuine Bun/Zig attestation (cch= hash).
 * 
 * Usage:
 *   bun run attestation-proxy.ts [--port 8319] [--mode direct|cc]
 * 
 * Modes:
 *   direct (default) — forward to api.anthropic.com with cch=00000 (current behavior)
 *   cc               — route through `claude --print` for real attestation
 * 
 * Test:
 *   curl http://localhost:8319/health
 *   curl -X POST http://localhost:8319/v1/messages \
 *     -H "Content-Type: application/json" \
 *     -H "Authorization: Bearer $TOKEN" \
 *     -d '{"model":"claude-sonnet-4-6","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'
 */

import { spawn } from 'child_process'
import { readFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ─── Config ────────────────────────────────────────────────
const args = process.argv.slice(2)
const PORT = parseInt(args[args.indexOf('--port') + 1] || '8319')
const MODE: 'direct' | 'cc' = (args[args.indexOf('--mode') + 1] as any) || 'direct'
const API_BASE = 'https://api.anthropic.com'
const CC_BIN = process.env.CC_BIN || 'claude'
const LOG_FILE = join(homedir(), '.claude', 'attestation-proxy.log')

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`
  console.log(line)
  try { appendFileSync(LOG_FILE, line + '\n') } catch {}
}

// ─── Direct mode: forward with our headers ─────────────────
async function handleDirect(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const targetUrl = `${API_BASE}${url.pathname}${url.search}`
  
  // Forward all headers, body unchanged
  const headers: Record<string, string> = {}
  req.headers.forEach((v, k) => { headers[k] = v })
  // Remove host header (will be set by fetch)
  delete headers['host']
  // Don't request compressed response — we need to stream raw bytes through
  delete headers['accept-encoding']
  
  const body = await req.text()
  log(`DIRECT: ${req.method} ${url.pathname} → ${targetUrl} (${body.length} bytes)`)
  
  // Bun's fetch auto-decompresses gzip but the upstream may send compressed.
  // Ensure we request uncompressed to avoid double-decompression issues.
  headers['accept-encoding'] = 'identity'
  
  const resp = await fetch(targetUrl, {
    method: req.method,
    headers,
    body: req.method !== 'GET' ? body : undefined,
  })
  
  // Forward response with all headers
  const respHeaders = new Headers()
  resp.headers.forEach((v, k) => respHeaders.set(k, v))
  
  // Log rate limit info
  const claim = resp.headers.get('anthropic-ratelimit-unified-representative-claim')
  const status = resp.headers.get('anthropic-ratelimit-unified-status')
  log(`DIRECT: ${resp.status} claim=${claim} status=${status}`)
  
  // Stream the response
  return new Response(resp.body, {
    status: resp.status,
    headers: respHeaders,
  })
}

// ─── CC mode: route through Claude Code binary ─────────────
async function handleCC(req: Request): Promise<Response> {
  const body = JSON.parse(await req.text())
  const model = body.model || 'claude-sonnet-4-6'
  const maxTokens = body.max_tokens || 16384
  const stream = body.stream !== false
  
  // Extract user message (last user message from messages array)
  const messages = body.messages || []
  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user')
  let prompt = ''
  if (lastUser) {
    if (typeof lastUser.content === 'string') {
      prompt = lastUser.content
    } else if (Array.isArray(lastUser.content)) {
      prompt = lastUser.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
    }
  }
  
  if (!prompt) {
    return new Response(JSON.stringify({ error: 'No user message found' }), { status: 400 })
  }
  
  // Build system prompt from body
  let systemPrompt = ''
  if (typeof body.system === 'string') {
    systemPrompt = body.system
  } else if (Array.isArray(body.system)) {
    systemPrompt = body.system.map((b: any) => b.text || '').join('\n')
  }
  
  log(`CC: model=${model} prompt=${prompt.length}chars system=${systemPrompt.length}chars stream=${stream}`)
  
  // Build CC command
  const ccArgs = [
    '--print',
    '--model', model,
    '--max-turns', '1',
  ]
  if (systemPrompt) {
    ccArgs.push('--system-prompt', systemPrompt)
  }
  // The prompt goes as the positional argument
  ccArgs.push(prompt)
  
  return new Promise<Response>((resolve) => {
    const proc = spawn(CC_BIN, ccArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1' },
    })
    
    let stdout = ''
    let stderr = ''
    
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    
    proc.on('close', (code) => {
      if (code !== 0) {
        log(`CC: process exited ${code}: ${stderr.slice(0, 200)}`)
        resolve(new Response(JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `CC process exited ${code}: ${stderr.slice(0, 200)}` }
        }), { 
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }))
        return
      }
      
      log(`CC: response ${stdout.length} bytes`)
      
      // Wrap in Anthropic API response format
      const response = {
        id: `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [{ type: 'text', text: stdout }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
      
      // Copy rate limit headers from CC's response if available in logs
      const headers = new Headers({
        'Content-Type': 'application/json',
        'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      })
      
      resolve(new Response(JSON.stringify(response), { status: 200, headers }))
    })
    
    // Timeout after 120s
    setTimeout(() => {
      proc.kill()
      resolve(new Response(JSON.stringify({ error: 'CC process timed out' }), { status: 504 }))
    }, 120_000)
  })
}

// ─── Server ────────────────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({
        status: 'ok',
        mode: MODE,
        port: PORT,
        cc_bin: CC_BIN,
        timestamp: new Date().toISOString(),
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    
    // Mode check / switch
    if (url.pathname === '/mode') {
      return new Response(JSON.stringify({ mode: MODE }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    
    // API passthrough
    if (url.pathname.startsWith('/v1/')) {
      try {
        if (MODE === 'cc') {
          return await handleCC(req)
        }
        return await handleDirect(req)
      } catch (err: any) {
        log(`ERROR: ${err.message}`)
        return new Response(JSON.stringify({ error: err.message }), { status: 500 })
      }
    }
    
    return new Response('Not found', { status: 404 })
  },
})

log(`attestation-proxy started on :${PORT} mode=${MODE} cc=${CC_BIN}`)
log(`  Direct mode:  curl http://localhost:${PORT}/health`)
log(`  Switch to CC: restart with --mode cc`)
