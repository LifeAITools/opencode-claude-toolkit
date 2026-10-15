/**
 * provider-dump/v1 — одна запись на вызов к поставщику, одна схема для всех дверей.
 *
 * Схема: /home/relishev/projects/vibe/kiberos-app/PRPs/provider-layer/01-architecture.md §3.4.
 * Поставщико-зависимо ровно одно — извлекатель usage (`extractUsage*`), по функции на диалект.
 *
 * Правила, которые нельзя ломать:
 *   - Поле, которого поставщик не даёт, — `null`, а не `0`. У Go нет «записано в кэш».
 *   - Секреты не пишутся никогда: заголовки режутся по SECRET_HEADERS, тело людей — только хэш,
 *     полное тело под рычагом PROVIDER_DUMP_BODIES=1 (на время разработки).
 *   - Писатель не роняет ход: любая ошибка записи глотается.
 *
 * Файл: JSONL по дням, ~/.claude-local/provider-dump/<YYYY-MM-DD>.jsonl, права 0600.
 */

import { appendFile, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

export const DUMP_SCHEMA_VERSION = 1

export type CallKind = 'real' | 'warm' | 'probe' | 'refresh' | 'title'
export type ErrorKind = 'network' | 'auth' | 'quota' | 'provider' | 'client'

/** Заголовки, значения которых не пишутся. Список — по probe_capture.py:45 плюс наши. */
export const SECRET_HEADERS = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization',
])

/** Заголовки учёта/квоты, которые дословно уходят в quota_seen. */
const QUOTA_HEADER_RE = /^(x-ratelimit-|retry-after$|anthropic-ratelimit-|x-.*(cost|quota|usage|balance|remaining))/i

export interface UsageNorm {
  input: number | null
  output: number | null
  reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  cache_write_1h: number | null
}

export interface DumpRecord {
  v: typeof DUMP_SCHEMA_VERSION
  ts: string
  host: string
  door: string
  provider: string
  org_id: string | null
  provider_org_ref: string | null
  model: string | null
  session_id: string | null
  lineage: string | null
  call_kind: CallKind
  actor: string | null
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body_sha256: string | null
    body_bytes: number | null
    body_ref: string | null
  }
  response: {
    status: number | null
    headers: Record<string, string>
    body: unknown | null
    chunks: Array<{ t_ms: number; bytes: number; text: string }> | null
  }
  usage_raw: unknown | null
  usage_norm: UsageNorm
  quota_seen: Record<string, string>
  timing: { ttfb_ms: number | null; total_ms: number | null }
  error: { kind: ErrorKind; provider_type: string | null } | null
}

const EMPTY_USAGE: UsageNorm = {
  input: null, output: null, reasoning: null, cache_read: null, cache_write: null, cache_write_1h: null,
}

function dumpDir(): string {
  return process.env.PROVIDER_DUMP_DIR ?? join(homedir(), '.claude-local', 'provider-dump')
}
function dumpEnabled(): boolean {
  return process.env.PROVIDER_DUMP !== '0'
}
function bodiesEnabled(): boolean {
  return process.env.PROVIDER_DUMP_BODIES === '1'
}

/** Режет секретные заголовки; значение заменяется длиной, чтобы было видно «был». */
export function redactHeaders(h: Headers | Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h)
  for (const [k, v] of entries) {
    out[k.toLowerCase()] = SECRET_HEADERS.has(k.toLowerCase()) ? `<redacted:${v.length}b>` : v
  }
  return out
}

/** Всё, что похоже на квоту/цену в заголовках, — дословно (секретные уже отрезаны). */
export function pickQuotaSeen(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (!SECRET_HEADERS.has(k) && QUOTA_HEADER_RE.test(k)) out[k] = v
  }
  return out
}

export function sha256(buf: string | Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null)

/**
 * usage диалекта chat/completions (DeepSeek и др. у Go): prompt_tokens / completion_tokens,
 * кэш — prompt_tokens_details.cached_tokens. Записи в кэш у Go нет → null.
 */
export function extractUsageChat(usage: unknown): UsageNorm {
  const u = (usage ?? {}) as Record<string, any>
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE }
  return {
    input: num(u.prompt_tokens),
    output: num(u.completion_tokens),
    reasoning: num(u.completion_tokens_details?.reasoning_tokens),
    cache_read: num(u.prompt_tokens_details?.cached_tokens),
    cache_write: null,
    cache_write_1h: null,
  }
}

/** usage диалекта Responses (Muse Spark): input_tokens / output_tokens, кэш — input_tokens_details.cached_tokens. */
export function extractUsageResponses(usage: unknown): UsageNorm {
  const u = (usage ?? {}) as Record<string, any>
  if (!usage || typeof usage !== 'object') return { ...EMPTY_USAGE }
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    reasoning: num(u.output_tokens_details?.reasoning_tokens),
    cache_read: num(u.input_tokens_details?.cached_tokens),
    cache_write: null,
    cache_write_1h: null,
  }
}

/** Ищет usage в SSE-тексте: последний `data:` с объектом usage (chat — финальный чанк, Responses — response.completed). */
export function usageFromSseText(text: string): unknown | null {
  let found: unknown | null = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const j = JSON.parse(payload)
      const u = j?.usage ?? j?.response?.usage
      if (u && typeof u === 'object') found = u
    } catch { /* не JSON — пропускаем */ }
  }
  return found
}

export function classifyError(status: number | null, networkFailure: boolean): DumpRecord['error'] {
  if (networkFailure) return { kind: 'network', provider_type: null }
  if (status === null || status < 400) return null
  if (status === 401 || status === 403) return { kind: 'auth', provider_type: null }
  if (status === 429) return { kind: 'quota', provider_type: null }
  if (status >= 500) return { kind: 'provider', provider_type: null }
  return { kind: 'client', provider_type: null }
}

export function newRecord(partial: Partial<DumpRecord> & Pick<DumpRecord, 'door' | 'provider' | 'call_kind'>): DumpRecord {
  return {
    v: DUMP_SCHEMA_VERSION,
    ts: new Date().toISOString(),
    host: process.env.PROVIDER_DUMP_HOST ?? 'local',
    org_id: null, provider_org_ref: null, model: null, session_id: null, lineage: null, actor: null,
    request: { method: 'POST', url: '', headers: {}, body_sha256: null, body_bytes: null, body_ref: null },
    response: { status: null, headers: {}, body: null, chunks: null },
    usage_raw: null, usage_norm: { ...EMPTY_USAGE }, quota_seen: {},
    timing: { ttfb_ms: null, total_ms: null }, error: null,
    ...partial,
  }
}

/** Тело людей — только хэш; полное — под рычагом. */
export function bodyField(text: string | null): unknown | null {
  if (text === null || !bodiesEnabled()) return null
  try { return JSON.parse(text) } catch { return text.slice(0, 20_000) }
}

let ensured = false
/** Пишет запись. Не бросает: дамп не имеет права уронить ход. */
export function writeDump(rec: DumpRecord): void {
  if (!dumpEnabled()) return
  try {
    const dir = dumpDir()
    if (!ensured) { mkdirSync(dir, { recursive: true }); ensured = true }
    const file = join(dir, `${rec.ts.slice(0, 10)}.jsonl`)
    appendFile(file, JSON.stringify(rec) + '\n', { mode: 0o600 }, (err) => {
      if (!err) { try { chmodSync(file, 0o600) } catch { /* ignore */ } }
    })
  } catch { /* swallow */ }
}

/** Для испытаний: сброс кэша «каталог создан». */
export function _resetDumpForTests(): void { ensured = false }
