#!/usr/bin/env bun
/**
 * opencode-go-quota — остаток подписки OpenCode Go в файл квоты, для подвала агентов.
 *
 * ЗАЧЕМ (07.10.2026, поручение фаундера: под агентами на Go должна стоять квота Go,
 * а не Anthropic). Читатель — lat-context (файл той же формы, что у Alibaba).
 *
 * ОТКУДА ЧИСЛА. Из ЕДИНСТВЕННОЙ двери реестра организаций (kiberos-app):
 * `python3 .../litellm/go_refresher.py status --json` — отдаёт активную организацию
 * и по каждой её окна поставщика (status/percent/resetsAt). Решение kiberos-app
 * 09.10: «читать один источник, в .go-tokens.json не лезть». Секретов в ответе нет.
 * 🔴 Прямую дверь `/zen/go/v1/usage` ключом из auth.json БОЛЬШЕ НЕ ЧИТАЕМ: она
 * описывает ПЕРВУЮ (исчерпанную) организацию, а шлюз ходит ВТОРОЙ — подвал показывал
 * не тот счёт (инцидент 08-09.10).
 *
 * КАКИМ МОДЕЛЯМ ПРИНАДЛЕЖИТ. Не догадка по имени (ловушка: голое deepseek-v4.1-flash
 * идёт в DashScope): GET /zen/go/v1/models ключом из auth.json → id с приставкой
 * `opencode-go/`, плюс алиасы LiteLLM, чей api_base ведёт в zen/go.
 */
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CLAUDE_LOCAL, classifyLevel } from './quota-paths.js'

export const QUOTA_STATUS_OPENCODE_GO_JSON = join(CLAUDE_LOCAL, 'quota-status-opencode-go.json')
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

/** Одна организация из двери реестра `go_refresher.py status --json`. */
export interface GoOrgStatus {
  name: string
  workspace?: string
  auth?: string
  /** true — через неё сейчас ходит посредник (меняется только командой `use`). */
  active?: boolean
  expires_at_ms?: number | null
  usage?: GoUsage | null
  usage_error?: string | null
  /** Имена исчерпанных окон этой организации (например ['weekly']). */
  exhausted?: string[]
}

/** Ответ двери реестра: кто активен и по каждой организации её окна. */
export interface GoRegistryStatus {
  active?: string
  measured_at_ms?: number
  orgs: GoOrgStatus[]
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

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>

/**
 * Реестр организаций из ЕДИНСТВЕННОЙ двери kiberos-app: `go_refresher.py status --json`.
 * Отдаёт `active` (какая организация обслуживает сейчас) и по каждой — окна поставщика
 * как есть. Секретов в ответе нет — решение kiberos-app 09.10: «читать один источник,
 * в .go-tokens.json не лезть». Запуск через execFile, не shell.
 */
export async function readGoRegistry(
  doorPath: string,
  runner?: Runner,
): Promise<{ registry: GoRegistryStatus | null; error: string | null }> {
  const run: Runner = runner ?? (async (cmd, args) => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    try {
      const out = await (promisify(execFile))(cmd, args, { timeout: 60_000, maxBuffer: 256 * 1024 })
      return { code: 0, stdout: String(out.stdout ?? ''), stderr: String(out.stderr ?? '') }
    } catch (e: any) {
      return { code: typeof e?.code === 'number' ? e.code : 1, stdout: String(e?.stdout ?? ''), stderr: String(e?.stderr ?? e?.message ?? '') }
    }
  })
  try {
    const r = await run('python3', [doorPath, 'status', '--json'])
    if (r.code !== 0) return { registry: null, error: `go_refresher_exit_${r.code}` }
    const body = JSON.parse(r.stdout) as GoRegistryStatus
    if (!body || !Array.isArray(body.orgs)) return { registry: null, error: 'go_refresher_bad_json' }
    return { registry: body, error: null }
  } catch (e) {
    return { registry: null, error: `go_refresher_unavailable: ${String((e as Error).message).slice(0, 200)}` }
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
  /** Имя активной организации из реестра — её числа здесь и лежат. */
  org: string
  /** true — через эту организацию сейчас ходит посредник (меняется командой `use`). */
  active: boolean
  accountHint: string
  models: string[]
  modelsSource: string
  measuredAt: Date
}): Record<string, unknown> {
  const { usage, error, org, active, accountHint, models, modelsSource, measuredAt } = input
  const base = {
    version: 1,
    provider: 'opencode-go',
    updatedAt: measuredAt.toISOString(),
    measured_at: measuredAt.toISOString(),
    org,
    active,
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
        org,
        active,
        util5h: util5h === null ? null : util5h / 100,
        util7d: util7d === null ? null : util7d / 100,
        utilMonth: utilMonth === null ? null : utilMonth / 100,
        reset5hAt: isoOf(usage.rolling?.resetsAt),
        reset7dAt: isoOf(usage.weekly?.resetsAt),
        resetMonthAt: isoOf(usage.monthly?.resetsAt),
        windows,
        level,
        message: windows.length === 0
          ? `opencode-go (${org}${active ? ', активна' : ', не активна'}): план не ограничивает окна.`
          : `opencode-go (${org}${active ? ', активна' : ', не активна'}): ` + windows.map((w) => `${w.window} ${pc(w.util as number)}`).join(', ') + '.',
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
  /** Путь к двери реестра kiberos-app: `go_refresher.py`. */
  goRefresherPath: string
  outPath: string
  fetcher?: typeof fetch
  now?: () => Date
  /** Подмена запуска двери в испытаниях (по умолчанию — python3 execFile). */
  runner?: Runner
}

export async function collectOnce(opts: CollectOptions): Promise<Record<string, unknown>> {
  const fetcher = opts.fetcher ?? fetch
  const now = opts.now ?? (() => new Date())
  const apiKey = readGoKey(opts.authJsonPath)
  // Числа — из ОДНОЙ двери реестра (kiberos-app): АКТИВНАЯ организация, а не та,
  // чей ключ лежит в auth.json (09.10: вторая организация обслуживает, первая
  // исчерпана — подвал показывал первую). Ключ из auth.json остаётся ТОЛЬКО для
  // списка моделей подписки.
  const [{ registry, error: doorError }, sub] = await Promise.all([
    readGoRegistry(opts.goRefresherPath, opts.runner),
    goSubscriptionModels(apiKey, fetcher),
  ])
  const activeOrg = registry
    ? (registry.orgs.find((o) => o.active === true) ?? registry.orgs[0] ?? null)
    : null
  let litellmAliases: string[] = []
  let litellmSource = 'litellm config unread'
  try {
    const raw = readFileSync(opts.litellmConfigPath, 'utf8')
    litellmAliases = litellmGoAliases(Bun.YAML.parse(raw))
    litellmSource = `litellm aliases (${litellmAliases.length})`
  } catch {
    litellmSource = 'litellm config unread'
  }
  const measuredAt = registry?.measured_at_ms ? new Date(registry.measured_at_ms) : now()
  const models = [...sub.models, ...litellmAliases].sort()
  const status = buildGoQuotaStatus({
    usage: activeOrg?.usage ?? null,
    error: doorError ?? activeOrg?.usage_error ?? null,
    org: activeOrg?.name ?? 'unknown',
    active: activeOrg?.active === true,
    accountHint: activeOrg?.name ?? 'opencode-go-unknown',
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
    goRefresherPath: process.env.GO_REFRESHER_PATH ?? '/home/relishev/projects/vibe/kiberos-app/litellm/go_refresher.py',
    outPath: process.env.QUOTA_STATUS_OPENCODE_GO_JSON ?? QUOTA_STATUS_OPENCODE_GO_JSON,
  })
  console.log(JSON.stringify({ written: process.env.QUOTA_STATUS_OPENCODE_GO_JSON ?? QUOTA_STATUS_OPENCODE_GO_JSON, error: (status as any).error ?? null, models: ((status as any).models as string[]).length }))
}
