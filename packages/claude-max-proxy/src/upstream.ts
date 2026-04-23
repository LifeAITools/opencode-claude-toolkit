/**
 * Upstream — credentials read + passthrough fetch to api.anthropic.com.
 *
 * Uses claude-code-sdk's FileCredentialStore for shared-fs token coordination
 * with native `claude` CLI (both read/write ~/.claude/.credentials.json).
 */

import { FileCredentialStore } from '@life-ai-tools/claude-code-sdk'
import type { StreamEvent } from '@life-ai-tools/claude-code-sdk'
import type { ProxyConfig } from './config.js'
import { emit } from './event-bus.js'

// ═══ Credential reader ═══════════════════════════════════════════

let _store: FileCredentialStore | null = null
let _cachedToken: { accessToken: string; expiresAt: number } | null = null

function getStore(cfg: ProxyConfig): FileCredentialStore {
  if (!_store) _store = new FileCredentialStore(cfg.credentialsPath)
  return _store
}

/**
 * Returns current valid access_token, refreshing from disk if needed.
 * No proactive refresh — we rely on native `claude` CLI and opencode
 * plugin to refresh the file; we just read what's there.
 */
export async function getAccessToken(cfg: ProxyConfig): Promise<string> {
  const now = Date.now()
  // 5-min safety buffer
  if (_cachedToken && _cachedToken.expiresAt - now > 5 * 60 * 1000) {
    return _cachedToken.accessToken
  }

  const store = getStore(cfg)
  const creds = await store.read()
  if (!creds?.accessToken) {
    emit({
      level: 'error',
      kind: 'TOKEN_NEEDS_RELOGIN',
      msg: `No credentials at ${cfg.credentialsPath} — run: claude login`,
    })
    throw new Error('NO_CREDENTIALS')
  }

  _cachedToken = { accessToken: creds.accessToken, expiresAt: creds.expiresAt }

  if (creds.expiresAt - now < 5 * 60 * 1000) {
    emit({
      level: 'error',
      kind: 'TOKEN_EXPIRED',
      msg: `Token expires in ${Math.round((creds.expiresAt - now) / 1000)}s — refresh handled by native claude CLI. Run: claude login if stuck.`,
      expiresInMs: creds.expiresAt - now,
    })
  }

  return creds.accessToken
}

/** Invalidate cached token (call after 401 from upstream). */
export function invalidateTokenCache(): void {
  _cachedToken = null
}

// ═══ Raw upstream fetch ═══════════════════════════════════════════

/**
 * Raw Anthropic request — used by KA engine to replay snapshot.
 * Returns SSE stream as async iterator of StreamEvent.
 *
 * Implementation is a MINIMAL SSE parser — we don't need full fidelity
 * (KA only cares about message_stop.usage), but the iterator contract
 * is the same as sdk.ts's doStreamRequest.
 */
export async function* upstreamFetch(
  cfg: ProxyConfig,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const url = `${cfg.anthropicBaseUrl}/v1/messages?beta=true`

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    const err: Error & { status?: number } = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    err.status = response.status

    if (response.status === 401) invalidateTokenCache()

    throw err
  }

  if (!response.body) throw new Error('No response body')

  yield* parseSSE(response.body, signal)
}

/** Minimal SSE parser yielding StreamEvents. Focused on message_stop.usage for KA. */
async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let usage = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }
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
        const raw = line.slice(6)
        if (raw === '[DONE]') continue
        let parsed: any
        try { parsed = JSON.parse(raw) } catch { continue }

        if (parsed.type === 'message_start') {
          const u = parsed.message?.usage
          if (u) {
            usage = {
              inputTokens: u.input_tokens ?? 0,
              outputTokens: u.output_tokens ?? 0,
              cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
              cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
            }
          }
        } else if (parsed.type === 'message_delta') {
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason
          if (parsed.usage?.output_tokens) usage.outputTokens = parsed.usage.output_tokens
        } else if (parsed.type === 'message_stop') {
          yield { type: 'message_stop', usage, stopReason }
        }
        // Other SSE events (content_block_delta etc) not yielded here — the proxy
        // byte-pipes them directly to CC in the passthrough handler. KA fires use
        // this parser only to drain and extract usage.
      }
    }
  } finally {
    reader.releaseLock()
  }
}
