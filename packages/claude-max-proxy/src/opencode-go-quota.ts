#!/usr/bin/env bun
/**
 * opencode-go-quota — остаток подписки OpenCode Go в файл квоты, для подвала агентов.
 *
 * ЗАЧЕМ (07.10.2026, поручение фаундера: под агентами на Go должна стоять квота Go,
 * а не Anthropic). Читатель — lat-context (файл той же формы, что у Alibaba).
 *
 * ОТКУДА ЧИСЛА. Недокументированная дверь `GET https://opencode.ai/zen/go/v1/usage`
 * (anomalyco/opencode #16513): `Authorization: Bearer <ключ opencode-go из auth.json>`.
 * 🔴 Дверь требует юзер-агент opencode (без него 403 даже с верным ключом — замер 07.10).
 * Ответ: `{usage:{rolling|weekly|monthly:{status, percent, resetsAt}}}`; percent —
 * ЦЕЛЫЙ ИСРАСХОДОВАННЫЙ 0–100, клампится; при упоре status ≠ ok.
 *
 * КАКИМ МОДЕЛЯМ ПРИНАДЛЕЖИТ. Не догадка по имени (ловушка: голое deepseek-v4.1-flash
 * идёт в DashScope): GET /zen/go/v1/models тем же ключом → id с приставкой
 * `opencode-go/`, плюс алиасы LiteLLM, чей api_base ведёт в zen/go.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CLAUDE_LOCAL, classifyLevel } from './quota-paths.js'

export const QUOTA_STATUS_OPENCODE_GO_JSON = join(CLAUDE_LOCAL, 'quota-status-opencode-go.json')
export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
export const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'

export interface GoWindowUsage {
  status?: unknown
  percent?: unknown
  resetsAt?: unknown
}

export interface GoUsage {
  rolling?: GoWindowUsage
  weekly?: GoWindowUsage
  monthly?: GoWindowUsage
}

/** Ключ opencode-go из auth.json. Нет ключа — null (названное отсутствие ниже). */
export function readGoKey(authJsonPath: string): string | null {
  try {
    const auth = JSON.parse(readFileSync(authJsonPath, 'utf8')) as Record<string, { type?: unknown; key?: unknown }>
    const key = auth?.['opencode-go']?.key
    return typeof key === 'string' && key ? key : null
  } catch {
    return null
  }
}

const userAgent = () => process.env.OPENCODE_GO_QUOTA_UA ?? 'opencode/1.18.34'

/** Тот же запрос, что отдаёт usage живьём (замер 07.10, обе пробы 200). */
export async function readGoUsage(
  apiKey: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ usage: GoUsage | null; error: string | null }> {
  if (!apiKey) return { usage: null, error: 'go_key_missing: opencode-go not in auth.json' }
  try {
    const res = await fetcher(GO_USAGE_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'user-agent': userAgent(),
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { usage: null, error: `go_http_${res.status}` }
    const body = (await res.json()) as { usage?: GoUsage }
    if (!body || typeof body.usage !== 'object') return { usage: null, error: 'go_no_data' }
    return { usage: body.usage, error: null }
  } catch (e) {
    return { usage: null, error: `go_unreachable: ${String((e as Error).message).slice(0, 200)}` }
  }
}

/** Модели подписки: GET /models тем же ключом → `opencode-go/<id>`. */
export async function goSubscriptionModels(
  apiKey: string | null,
  fetcher: typeof fetch = fetch,
): Promise<{ models: string[]; source: string }> {
  if (!apiKey) return { models: [], source: 'no key' }
  try {
    const res = await fetcher(GO_MODELS_URL, {
      headers: { authorization: `Bearer ${apiKey}`, 'user-agent': userAgent(), accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { models: [], source: `GET /models -> ${res.status}` }
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
    return { models: ids.map((id) => `opencode-go/${id}`), source: `GET /models (${ids.length})` }
  } catch {
    return { models: [], source: 'GET /models failed' }
  }
}

/**
 * Алиасы LiteLLM, чей api_base ведёт в zen/go — по конфигу, не по имени.
 * Читаются только имена моделей и адреса (ключей не касаемся).
 */
export function litellmGoAliases(litellmConfig: unknown): string[] {
  const models = (litellmConfig as { model_list?: Array<{ model_name?: unknown; litellm_params?: { api_base?: unknown } }> })?.model_list
  if (!Array.isArray(models)) return []
  const out: string[] = []
  for (const m of models) {
    const base = m?.litellm_params?.api_base
    if (typeof base === 'string' && base.includes('opencode.ai/zen/go') && typeof m?.model_name === 'string' && m.model_name) {
      out.push(m.model_name)
    }
  }
  return [...new Set(out)]
}

export function accountHintFor(apiKey: string): string {
  return 'opencode-go-' + createHash('sha256').update(apiKey).digest('hex').slice(0, 12)
}

const clampPct = (v: unknown): number | null => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(100, Math.max(0, Math.round(v)))
}
const isoMs = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : null
}
const isoOf = (v: unknown): string | null => {
  const ms = isoMs(v)
  return ms === null ? null : new Date(ms).toISOString()
}

/** Файл в форме quota-status.json с provider:"opencode-go". Чистая функция — испытывается без сети. */
export function buildGoQuotaStatus(input: {
  usage: GoUsage | null
  error: string | null
  accountHint: string
  models: string[]
  modelsSource: string
  measuredAt: Date
}): Record<string, unknown> {
  const { usage, error, accountHint, models, modelsSource, measuredAt } = input
  const base = {
    version: 1,
    provider: 'opencode-go',
    updatedAt: measuredAt.toISOString(),
    measured_at: measuredAt.toISOString(),
    models,
    models_source: modelsSource,
  }
  if (!usage) {
    return { ...base, error: error ?? 'no_usage', accounts: {} }
  }
  const pct = (w?: GoWindowUsage) => clampPct(w?.percent)
  const util5h = pct(usage.rolling)
  const util7d = pct(usage.weekly)
  const utilMonth = pct(usage.monthly)
  const longest = util7d === null ? utilMonth : utilMonth === null ? util7d : Math.max(util7d, utilMonth)
  const level = classifyLevel(util5h === null ? null : util5h / 100, longest === null ? null : longest / 100)
  const win = (name: string, w: GoWindowUsage | undefined, util: number | null) => ({
    window: name,
    util: util === null ? null : util / 100,
    status: typeof w?.status === 'string' ? w.status : null,
    resetAt: isoMs(w?.resetsAt),
    resetIso: isoOf(w?.resetsAt),
  })
  const windows = [win('5h', usage.rolling, util5h), win('week', usage.weekly, util7d), win('month', usage.monthly, utilMonth)]
    .filter((w) => w.util !== null)
  const pc = (v: number) => (Math.round(v * 1000) / 10) + '%'
  return {
    ...base,
    accounts: {
      [accountHint]: {
        accountHint,
        util5h: util5h === null ? null : util5h / 100,
        util7d: util7d === null ? null : util7d / 100,
        utilMonth: utilMonth === null ? null : utilMonth / 100,
        reset5hAt: isoOf(usage.rolling?.resetsAt),
        reset7dAt: isoOf(usage.weekly?.resetsAt),
        resetMonthAt: isoOf(usage.monthly?.resetsAt),
        windows,
        level,
        message: windows.length === 0
          ? 'opencode-go: the plan reports no limited window.'
          : 'opencode-go: ' + windows.map((w) => `${w.window} ${pc(w.util as number)}`).join(', ') + '.',
      },
    },
  }
}

export function writeAtomic(path: string, body: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n')
  renameSync(tmp, path)
}

export interface CollectOptions {
  authJsonPath: string
  litellmConfigPath: string
  outPath: string
  fetcher?: typeof fetch
  now?: () => Date
}

export async function collectOnce(opts: CollectOptions): Promise<Record<string, unknown>> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? (() => new Date())
  const apiKey = readGoKey(opts.authJsonPath)
  const [{ usage, error }, sub] = await Promise.all([
    readGoUsage(apiKey, fetcher),
    goSubscriptionModels(apiKey, fetcher),
  ])
  let litellmAliases: string[] = []
  let litellmSource = 'litellm config unread'
  try {
    const raw = readFileSync(opts.litellmConfigPath, 'utf8')
    litellmAliases = litellmGoAliases(Bun.YAML.parse(raw))
    litellmSource = `litellm aliases (${litellmAliases.length})`
  } catch {
    litellmSource = 'litellm config unread'
  }
  const measuredAt = now()
  const models = [...sub.models, ...litellmAliases].sort()
  const status = buildGoQuotaStatus({
    usage,
    error: apiKey ? error : 'go_key_missing: opencode-go not in auth.json',
    accountHint: apiKey ? accountHintFor(apiKey) : 'opencode-go-unknown',
    models,
    modelsSource: [sub.source, litellmSource].join('; '),
    measuredAt,
  })
  writeAtomic(opts.outPath, status)
  return status
}

if (import.meta.main) {
  const home = homedir()
  const status = await collectOnce({
    authJsonPath: process.env.OPENCODE_AUTH_JSON ?? join(home, '.local', 'share', 'opencode', 'auth.json'),
    litellmConfigPath: process.env.LITELLM_CONFIG_PATH ?? '/home/relishev/projects/vibe/kiberos-app/litellm/config.yaml',
    outPath: process.env.QUOTA_STATUS_OPENCODE_GO_JSON ?? QUOTA_STATUS_OPENCODE_GO_JSON,
  })
  console.log(JSON.stringify({ written: process.env.QUOTA_STATUS_OPENCODE_GO_JSON ?? QUOTA_STATUS_OPENCODE_GO_JSON, error: (status as any).error ?? null, models: ((status as any).models as string[]).length }))
}
