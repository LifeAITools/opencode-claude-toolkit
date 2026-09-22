#!/usr/bin/env bun
/**
 * openai-compat-proxy — тонкий OpenAI→OpenAI pipe для любого OpenAI-совместимого апстрима.
 *
 * НЕ ЗНАЕТ провайдеров. Апстрим-адрес (`X-Upstream-Url`) и готовый `Authorization` приходят
 * от вызывающего (плагин/лаунчер); прокси ретранслирует и по пути ловит `usage` через ядро
 * `@kiberos/proxy-core`, записывая строку в SQLite-стора (WAL, защищённый от параллельной записи).
 *
 * Рейлы (02.5):
 *   REQ-CORE-02 — слушает только 127.0.0.1, strip'ит X-Upstream-Url/Authorization перед апстримом;
 *   REQ-CORE-04 — порт и путь базы из env, литералы только fallback.
 */

import { initStore, insertUsage, teeUsage, healthResponse, writePidFile, type OpenAIUsage, type UsageRow } from '@kiberos/proxy-core'

import { homedir } from 'os'
import { join } from 'path'

const PORT = parseInt(process.env.PROXY_PORT ?? '17100', 10)
const STATS_DB = process.env.PROXY_STATS_DB ?? join(homedir(), '.local', 'share', 'openai-compat-proxy', 'stats.sqlite')
const PROVIDER = process.env.PROXY_PROVIDER ?? 'openai-compat'
const PID_FILE = process.env.PROXY_PID_FILE ?? join(process.env.TMPDIR ?? '/tmp', `openai-compat-proxy-${PORT}.pid`)

/** Какие модели прокси объявляет наружу. Хранится В АДАПТЕРЕ, не в ядре (US-04). */
const MODELS = (process.env.PROXY_MODELS ?? 'qwen-portal/coder-model')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => ({ id, object: 'model', owned_by: 'openai-compat' }))

function usageToRow(model: string | undefined, sessionId: string | undefined, usage: OpenAIUsage | undefined): UsageRow | null {
  if (!usage) return null
  const input = usage.prompt_tokens ?? 0
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    ts: new Date().toISOString(),
    pid: process.pid,
    provider: PROVIDER,
    model: model ?? null,
    sessionId: sessionId ?? null,
    inputTokens: input,
    outputTokens: usage.completion_tokens ?? 0,
    cacheRead: cached,
    // REQ-CORE-01: выводимый факт, пока апстрим не даёт cache_creation отдельно.
    cacheWrite: Math.max(0, input - cached),
  }
}

async function forward(request: Request, model: string | undefined): Promise<Response> {
  const base = request.headers.get('x-upstream-url') ?? process.env.PROXY_UPSTREAM_BASE ?? null
  if (!base) {
    return new Response(JSON.stringify({ error: 'missing X-Upstream-Url header or PROXY_UPSTREAM_BASE env' }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    })
  }

  const url = new URL(request.url)
  // Конкатенация, а не new URL: апстрим-префикс может нести собственный путь
  // (напр. `/compatible-mode/v1` у Alibaba), и перезапись `pathname` его теряет (→404).
  const target = base.replace(/\/+$/, '') + (url.pathname.startsWith('/v1/') ? url.pathname : `/v1${url.pathname}`) + url.search

  const sessionId = request.headers.get('x-session-id') ?? undefined
  const headers = new Headers(request.headers)
  // REQ-CORE-02: свои служебные заголовки и host не утекают апстриму.
  for (const h of ['x-upstream-url', 'x-session-id', 'host', 'content-length', 'content-encoding']) headers.delete(h)

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

  const upstreamRes = await fetch(target, { method: request.method, headers, body: bodyText })
  const write = (usage: OpenAIUsage) => {
    const row = usageToRow(model, sessionId, usage)
    if (row) {
      try {
        insertUsage(STATS_DB, row)
      } catch {
        /* наблюдательный слой — не ронять разговор */
      }
    }
  }

  if (streamWanted && upstreamRes.body) {
    const teed = teeUsage(upstreamRes.body, write)
    return new Response(teed, { status: upstreamRes.status, headers: upstreamRes.headers })
  }

  try {
    const text = await upstreamRes.text()
    write((JSON.parse(text) as { usage?: OpenAIUsage }).usage as OpenAIUsage)
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
    if (url.pathname === '/health') return healthResponse({ port: PORT, stats: STATS_DB })
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

initStore(STATS_DB)
writePidFile(PID_FILE)
console.log(`openai-compat-proxy listening on 127.0.0.1:${PORT} (stats → ${STATS_DB})`)