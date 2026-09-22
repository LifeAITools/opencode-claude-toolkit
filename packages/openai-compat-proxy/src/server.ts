#!/usr/bin/env bun
/**
 * openai-compat-proxy — тонкий OpenAI→OpenAI pipe для любого OpenAI-совместимого апстрима.
 *
 * НЕ ЗНАЕТ провайдеров. Апстрим-адрес (`X-Upstream-Url`) и готовый `Authorization` приходят
 * от вызывающего (плагин/лаунчер); прокси ретранслирует и по пути ловит `usage` через ядро
 * `@kiberos/proxy-core`, дописывая строку в stats.jsonl.
 *
 * Рейлы (02.5):
 *   REQ-CORE-02 — слушает только 127.0.0.1, strip'ит X-Upstream-Url/Authorization перед апстримом;
 *   REQ-CORE-04 — порт и путь stats из env, литералы только fallback.
 */

import {
  appendStatsLine,
  STATS_SCHEMA_VERSION,
  teeUsage,
  healthResponse,
  writePidFile,
  type OpenAIUsage,
  type StatsLine,
} from '@kiberos/proxy-core'

import { homedir } from 'os'
import { join } from 'path'

const PORT = parseInt(process.env.PROXY_PORT ?? '17100', 10)
const STATS_JSONL =
  process.env.PROXY_STATS_JSONL ?? join(homedir(), '.local', 'share', 'openai-compat-proxy', 'stats.jsonl')
const PID_FILE = process.env.PROXY_PID_FILE ?? join(process.env.TMPDIR ?? '/tmp', `openai-compat-proxy-${PORT}.pid`)

/** Какие модели прокси объявляет наружу. Хранится В АДАПТЕРЕ, не в ядре (US-04). */
const MODELS = (process.env.PROXY_MODELS ?? 'qwen-portal/coder-model')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => ({ id, object: 'model', owned_by: 'openai-compat' }))

function projectUsage(model: string | undefined, usage: OpenAIUsage | undefined): StatsLine | null {
  if (!usage) return null
  const inTokens = usage.prompt_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    v: STATS_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    pid: process.pid,
    type: 'stream',
    model: model ?? '?',
    usage: {
      in: inTokens,
      out: usage.completion_tokens ?? 0,
      cacheRead: cached,
      // REQ-CORE-01: выводимый факт, пока апстрим не даёт cache_creation отдельно.
      cacheWrite: Math.max(0, inTokens - cached),
    },
  }
}

function upstreamBase(req: Request): string | null {
  return req.headers.get('x-upstream-url')
}

async function forward(request: Request, model: string | undefined): Promise<Response> {
  const base = upstreamBase(request)
  if (!base) {
    return new Response(JSON.stringify({ error: 'missing X-Upstream-Url header' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(request.url)
  const upstream = new URL(base.replace(/\/+$/, ''))
  upstream.pathname = url.pathname.startsWith('/v1/') ? url.pathname : `/v1${url.pathname}`
  upstream.search = url.search

  const headers = new Headers(request.headers)
  // REQ-CORE-02: свои служебные заголовки и host не утекают апстриму.
  for (const h of ['x-upstream-url', 'host', 'content-length', 'content-encoding', 'x-qwen-model']) headers.delete(h)

  let bodyText: string | null = null
  let streamWanted = false
  try {
    bodyText = await request.text()
    const parsed = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {}
    streamWanted = parsed.stream === true
    if (streamWanted && (parsed.stream_options as Record<string, unknown> | undefined)?.include_usage !== true) {
      parsed.stream_options = { ...((parsed.stream_options as Record<string, unknown>) ?? {}), include_usage: true }
      bodyText = JSON.stringify(parsed)
    }
    if (!model && typeof parsed.model === 'string') model = parsed.model
  } catch {
    /* не-JSON тело — шлём как есть */
  }

  const upstreamRes = await fetch(upstream, { method: request.method, headers, body: bodyText })

  if (streamWanted && upstreamRes.body) {
    const teed = teeUsage(upstreamRes.body, (usage) => {
      const line = projectUsage(model, usage)
      if (line) appendStatsLine(STATS_JSONL, line)
    })
    return new Response(teed, { status: upstreamRes.status, headers: upstreamRes.headers })
  }

  try {
    const text = await upstreamRes.text()
    const line = projectUsage(model, (JSON.parse(text) as { usage?: OpenAIUsage }).usage)
    if (line) appendStatsLine(STATS_JSONL, line)
    return new Response(text, { status: upstreamRes.status, headers: { 'content-type': 'application/json' } })
  } catch {
    return upstreamRes
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/health') return healthResponse({ port: PORT, stats: STATS_JSONL })
    if (url.pathname === '/v1/models') return Response.json({ object: 'list', data: MODELS })
    if (req.method === 'POST' && (url.pathname.endsWith('/chat/completions') || url.pathname.endsWith('/responses'))) {
      return forward(req, undefined)
    }
    return new Response(JSON.stringify({ error: 'not found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  },
})

writePidFile(PID_FILE)
console.log(`openai-compat-proxy listening on 127.0.0.1:${PORT} (stats → ${STATS_JSONL})`)