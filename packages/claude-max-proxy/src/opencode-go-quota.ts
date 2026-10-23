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
import { Database } from 'bun:sqlite'
import { createHash } from 'crypto'
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { CLAUDE_LOCAL, classifyLevel } from './quota-paths.js'

export const QUOTA_STATUS_OPENCODE_GO_JSON = join(CLAUDE_LOCAL, 'quota-status-opencode-go.json')
export const GO_MODELS_URL = 'https://opencode.ai/zen/go/v1/models'

/** Мост ИМЯ→uid организации. Реестр организаций (SynqTask: `todo_members orgs`) по HTTP
 * недоступен, а потребителю (lat-context) надо склеить `member.orgUid` с записью `orgs[]`
 * по имени — иначе подвал агента не может показать ОРГ АГЕНТА (жалоба фаундера 13.10).
 * Файл — типизированный конфиг ({ "console-personal": "<uid>", ... }); нет его — {} и НЕ
 * выдумываем: потребитель падает на прежний выбор (активную), и это видно, а не врёт. */
export const ORG_UIDS_JSON =
  process.env.OPENCODE_GO_ORG_UIDS ?? join(CLAUDE_LOCAL, 'opencode-go-org-uids.json')

export function readOrgUids(path: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const [name, uid] of Object.entries(raw)) {
      if (typeof uid === 'string' && uid) out[name] = uid
    }
    return out
  } catch {
    return {}
  }
}

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
  /** Статус организации из реестра (FR-1): `active | exhausted | retired | restricted`.
   *  Нет поля — организация считается `active` (реестр пока его не несёт). */
  status?: string
  /** Смысловая причина ограничения (обязательна при `restricted`, FR-1): чтобы агент
   *  и пускатель понимали ПОЧЕМУ, а не гадали. */
  restricted_reason?: string | null
  /** Модели, привязанные к организации (FR-1). Нет — поле не выводится (не выдумываем). */
  models?: string[]
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

/**
 * Какая пара «аккаунт/организация» ДЕЙСТВИТЕЛЬНО в работе — по двум источникам.
 *
 * ЗАЧЕМ (22.10.2026): отчёт раньше ПИСАЛ утверждение, скопированное из реестра
 * (`orgs[].active`), и источники разошлись — агент работал на одной организации,
 * а файл говорил «активна другая». Теперь `active` не хранится, а выводится из
 * `account_state` (таблица opencode), и расхождение честно называется `неизвестно`.
 * Чистая функция: без ввода-вывода, испытания без базы.
 */
export interface ActiveOrgResolution {
  /** Подтверждённое имя активной организации либо null, когда источники не сошлись. */
  name: string | null
  /** НА ЧЁМ основано подтверждение: по идентификаторам (сильный) или по именам (слабый). */
  basis: 'workspace_id' | 'label' | null
  /** Что сказал каждый источник — присутствует ВСЕГДА, чтобы `unknown` называл причину. */
  sources: {
    registry: string | null
    registryWorkspace: string | null
    accountState: string | null
    accountId: string | null
    accountOrgId: string | null
  }
  /** Машиночитаемая причина. `labelMismatch` — факт один, разошлись ПОДПИСИ. */
  reason:
    | 'agreed'
    | 'agreed_by_label'
    | 'labelMismatch'
    | 'account_state_unreadable'
    | 'account_email_not_in_registry'
    | 'sources_disagree'
}

/**
 * КАНОН — ИДЕНТИФИКАТОР, А НЕ ИМЯ (поправка владельца реестра 23.10, и он прав).
 *
 * Мы с ним джойнили РАЗНЫЕ величины: я `active_account_id → account.email` (почта УЧЁТКИ),
 * он `active_org_id → workspace` в реестре (имя ОРГАНИЗАЦИИ). Сегодня они совпадают только
 * потому, что в opencode одна учётка = одна организация и имя орг равно почте. В день, когда
 * это перестанет быть так, разойдутся не справочники, а САМИ ВЕЛИЧИНЫ, и сверка имён этого
 * не поймает — она подтвердит совпадение подписей при разных фактах.
 *
 * Поэтому сверка идёт по паре `(activeAccountId, activeOrgId)`, когда обе стороны её несут;
 * имена остаются ЯРЛЫКАМИ для человека. `labelMismatch` — важный отдельный исход: пара
 * совпала, а названия разные, значит факт один и пускатель тут ни при чём. Валить его в
 * `sources_disagree` значило бы через месяц не отличить «вход был в другую организацию» от
 * «мы по-разному её назвали».
 */
export function resolveActiveOrg(input: {
  /** Активная запись реестра: имя (ярлык) и `workspace` (идентификатор организации). */
  registryActive: { name: string | null; workspace: string | null } | null
  /** email из `account_state` → `account` (ярлык учётки). */
  accountEmail: string | null
  /** `account_state.active_account_id` — идентификатор учётки. */
  accountId?: string | null
  /** `account_state.active_org_id` — идентификатор организации. */
  accountOrgId?: string | null
  registryOrgNames: string[]
}): ActiveOrgResolution {
  const clean = (v: string | null | undefined): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const accountEmail = clean(input.accountEmail)
  const registryName = clean(input.registryActive?.name ?? null)
  const registryWorkspace = clean(input.registryActive?.workspace ?? null)
  const accountId = clean(input.accountId ?? null)
  const accountOrgId = clean(input.accountOrgId ?? null)
  const sources = {
    registry: registryName,
    registryWorkspace,
    accountState: accountEmail,
    accountId,
    accountOrgId,
  }
  if (!accountEmail) return { name: null, basis: null, sources, reason: 'account_state_unreadable' }

  // Сильная сверка: пара идентификаторов. Только она отвечает на «тот ли это факт».
  if (registryWorkspace && accountOrgId) {
    if (registryWorkspace !== accountOrgId) {
      return { name: null, basis: 'workspace_id', sources, reason: 'sources_disagree' }
    }
    // Пара совпала. Ярлыки могут при этом разойтись — это НЕ спор источников.
    if (!registryName) return { name: null, basis: 'workspace_id', sources, reason: 'sources_disagree' }
    return {
      name: registryName,
      basis: 'workspace_id',
      sources,
      reason: registryName === accountEmail ? 'agreed' : 'labelMismatch',
    }
  }

  // Слабая сверка: идентификаторов нет хотя бы с одной стороны — сравниваем ярлыки и НАЗЫВАЕМ,
  // что основание слабое. Молча выдать это за `agreed` значило бы приравнять подпись к факту.
  const names = (Array.isArray(input.registryOrgNames) ? input.registryOrgNames : []).map((n) => String(n).trim())
  if (!names.includes(accountEmail)) {
    return { name: null, basis: 'label', sources, reason: 'account_email_not_in_registry' }
  }
  if (registryName === accountEmail) {
    return { name: accountEmail, basis: 'label', sources, reason: 'agreed_by_label' }
  }
  return { name: null, basis: 'label', sources, reason: 'sources_disagree' }
}

/**
 * Читает email активного аккаунта из базы opencode (`account_state` → `account`).
 *
 * ЗАЧЕМ: единственный источник правды о том, на какой паре агент работает СЕЙЧАС.
 * Реестр знает лишь то, что ему сказали командой `use`, и 22.10 источники разошлись.
 * Ошибка НИКОГДА не бросается: `unknown` должен уметь назвать причину, а не уронить сбор.
 */
export function readActiveAccountEmail(
  dbPath: string,
): { email: string | null; accountId: string | null; orgId: string | null; error: string | null } {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    // 🔴 БЕЗ `ORDER BY id` И С ПРОВЕРКОЙ ЧИСЛА СТРОК (поправка владельца реестра 23.10).
    // `account_state` по устройству держит ОДНУ строку. `order by id limit 1` при двух строках
    // молча выбрал бы меньший id и выдал бы выбор за факт — тот же класс, что мы весь месяц
    // ловим. Две строки = «не знаем, какая из них в работе», а не «возьмём первую».
    const count = db.query('select count(*) as n from account_state').get() as { n?: unknown } | null
    const rows = typeof count?.n === 'number' ? count.n : -1
    if (rows === 0) return { email: null, accountId: null, orgId: null, error: 'no account_state row' }
    if (rows !== 1) return { email: null, accountId: null, orgId: null, error: `account_state has ${rows} rows — which pair is in use is unknown` }
    const state = db
      .query('select active_account_id, active_org_id from account_state limit 1')
      .get() as { active_account_id?: unknown; active_org_id?: unknown } | null
    if (!state) return { email: null, accountId: null, orgId: null, error: 'no account_state row' }
    const orgId = typeof state.active_org_id === 'string' && state.active_org_id.trim()
      ? state.active_org_id.trim()
      : null
    const accountId = typeof state.active_account_id === 'string' ? state.active_account_id.trim() : ''
    if (!accountId) return { email: null, accountId: null, orgId, error: 'no active_account_id' }
    const row = db.query('select email from account where id = ?').get(accountId) as { email?: unknown } | null
    if (!row) return { email: null, accountId, orgId, error: 'account row not found' }
    const email = typeof row.email === 'string' ? row.email.trim() : ''
    if (!email) return { email: null, accountId, orgId, error: 'empty account email' }
    return { email, accountId, orgId, error: null }
  } catch (e) {
    return { email: null, accountId: null, orgId: null, error: `account_state unreadable: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
  } finally {
    try { db?.close() } catch {}
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
  const models = (litellmConfig as {
    model_list?: Array<{ model_name?: unknown; litellm_params?: { api_base?: unknown; litellm_credential_name?: unknown } }>
  })?.model_list
  if (!Array.isArray(models)) return []
  const out: string[] = []
  for (const m of models) {
    const base = m?.litellm_params?.api_base
    const cred = m?.litellm_params?.litellm_credential_name
    // 🔴 TWO DOORS INTO THE SAME SET OF GO ALIASES. (1) `api_base` pointing at zen/go — the direct
    // aliases. (2) the Go credential entry `opencode-go-active` — our kiberos-app aliases carry
    // `litellm_credential_name` INSTEAD of api_base, because the orgs have DIFFERENT bases
    // (console-* → .../go/openai/v1, apikey-founder → .../zen/go/v1); pinning one api_base here
    // would break the per-org route. Without (2) `deepseek-v4.1-flash-go` never entered models[]
    // and every agent's presence row got no quota (founder, 2026-10-13).
    const isGo =
      (typeof base === 'string' && base.includes('opencode.ai/zen/go')) ||
      (typeof cred === 'string' && cred === 'opencode-go-active')
    if (isGo && typeof m?.model_name === 'string' && m.model_name) {
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

/**
 * Окно ЗАКРЫТО: его число относится к завершившемуся окну и в новом не значит ничего.
 *
 * 🔴 ЗАЧЕМ (находка владельца signal-wire-core, 23.10.2026, замер на живом): производитель
 * переписывает файл целиком и переносит СТАРОЕ число под СВЕЖИЙ `measured_at`. Живой случай —
 * 5ч-окно сброшено в 17:21Z, а в 21:30Z файл показывал `util5h=0.96` (реально было 0.79), и
 * агент дважды остановил работу на числе, которое больше никого не ограничивает.
 *
 * Читателю это не различить: число выглядит живым, потому что штамп свежий. Поэтому решение
 * принимается ЗДЕСЬ, у производителя: число закрытого окна не переносится вовсе, окно
 * называется `expired` и сохраняет свой `resetAt`. Потребителям больше не надо угадывать.
 * `resetAt` неизвестен — судить не по чему, число остаётся (fail-open, прежнее поведение).
 */
const windowClosed = (w: GoWindowUsage | undefined, nowMs: number): boolean => {
  const ms = isoMs(w?.resetsAt)
  return ms !== null && ms <= nowMs
}

/** Файл в форме quota-status.json с provider:"opencode-go". Чистая функция — испытывается без сети. */
export function buildGoQuotaStatus(input: {
  usage: GoUsage | null
  error: string | null
  /** Имя организации, чьи числа лежат в плоских полях отчёта (ПРЕДМЕТ чисел). */
  org: string
  /** 🔴 Какая пара в работе — не копия из реестра, а СВЕРКА реестра с `account_state`
   * opencode. `name === null` — источники не сошлись или база не прочитана: тогда
   * `active` будет null, а причина названа в `activeReason`/`activeSources`. */
  activeOrg: ActiveOrgResolution
  accountHint: string
  models: string[]
  modelsSource: string
  measuredAt: Date
  /** 🔴 ВСЕ организации реестра с их окнами — чтобы потребитель показал ОРГАНИЗАЦИЮ АГЕНТА,
   * а не активную. Без этого подвал для агента на неактивной орг показывал чужие числа
   * (жалоба фаундера 13.10: сверяет Березовскую, а подвал давал активную). */
  orgs?: GoOrgStatus[]
  /** Имя→uid: `member.orgUid` — это SynqTask-uid, а в `orgs[]` лежат только ИМЕНА.
   * Мост обязателен, иначе лат-контекст не сопоставит орг агента с записью. */
  orgUids?: Record<string, string>
}): Record<string, unknown> {
  const { usage, error, org, activeOrg, accountHint, models, modelsSource, measuredAt, orgs, orgUids } = input
  // 🔴 `active` больше НЕ копируется из реестра: подтверждение берётся из сверки с
  // `account_state`. Неизвестно — null (никогда false: «не активна» — тоже утверждение).
  // Старый вызов без `activeOrg` не роняем — считаем, что подтверждения нет.
  const resolution: ActiveOrgResolution = activeOrg ?? {
    name: null,
    sources: { registry: null, accountState: null },
    reason: 'account_state_unreadable',
  }
  // 🔴 РАЗДЕЛЕНИЕ СМЫСЛОВ: `org` — ПРЕДМЕТ плоских чисел (та организация, чьи окна здесь);
  // `active` — ПОДТВЕРЖДЕНО ли, что этот предмет сейчас в работе. Одно другого не влечёт.
  const active: boolean | null = resolution.name ? true : null
  // 🔴 ИНВАРИАНТ: `resolution.name` непусто ТОЛЬКО когда реестр и `account_state` назвали
  // одно имя, а `org` — это имя активной организации реестра того же ответа. Значит
  // подтверждённое имя всегда совпадает с предметом плоских чисел; ветки «активна другая»
  // не существует, и писать её — значит держать код, до которого не доходит ни один вызов.
  const activityNote = resolution.name
    ? ', активна'
    : `, активность не подтверждена (${resolution.reason})`
  const base = {
    version: 1,
    provider: 'opencode-go',
    updatedAt: measuredAt.toISOString(),
    measured_at: measuredAt.toISOString(),
    org,
    // 🔴 `org` — РЕШЕНИЕ, А НЕ ЗАМЕР (просьба владельца реестра 23.10): это имя организации,
    // куда МЫ решили направлять (строка `active:` командой `use`), и его читает пускатель.
    // Без пометки через месяц никто не отличит решение от измерения. Замер лежит рядом:
    // `activeSources.accountState`.
    orgSource: 'registry_decision',
    active,
    activeReason: resolution.reason,
    // 🔴 СЫРЫЕ ИДЕНТИФИКАТОРЫ ПАРЫ рядом с ярлыками (просьба владельца реестра 23.10):
    // канон — идентификатор, имя — подпись для человека. Иначе в день, когда учётка и
    // организация перестанут быть один-к-одному, сверка имён подтвердит совпадение подписей
    // при разных фактах.
    activeAccountId: resolution.sources.accountId,
    activeOrgId: resolution.sources.accountOrgId,
    activeBasis: resolution.basis,
    activeSources: resolution.sources,
    models,
    models_source: modelsSource,
  }
  if (!usage) {
    return { ...base, error: error ?? 'no_usage', accounts: {} }
  }
  const pct = (w?: GoWindowUsage) => clampPct(w?.percent)
  // «Сейчас» — тот же штамп, что уедет в файл: ценз и измерение обязаны смотреть одними часами,
  // иначе внутри одного файла два разных «сейчас».
  const nowMs = measuredAt.getTime()
  const livePct = (w?: GoWindowUsage): number | null => (windowClosed(w, nowMs) ? null : pct(w))
  const util5h = livePct(usage.rolling)
  const util7d = livePct(usage.weekly)
  const utilMonth = livePct(usage.monthly)
  const longest = util7d === null ? utilMonth : utilMonth === null ? util7d : Math.max(util7d, utilMonth)
  const level = classifyLevel(util5h === null ? null : util5h / 100, longest === null ? null : longest / 100)
  const win = (name: string, w: GoWindowUsage | undefined, util: number | null) => {
    const expired = windowClosed(w, nowMs)
    return {
      window: name,
      // Число закрытого окна — null: оно не про ЭТО окно. Само окно остаётся, чтобы читатель
      // видел «сброшено такого-то числа», а не пустое место.
      util: util === null ? null : util / 100,
      status: typeof w?.status === 'string' ? w.status : null,
      resetAt: isoMs(w?.resetsAt),
      resetIso: isoOf(w?.resetsAt),
      ...(expired ? { expired: true } : {}),
    }
  }
  const windows = [win('5h', usage.rolling, util5h), win('week', usage.weekly, util7d), win('month', usage.monthly, utilMonth)]
    // Окно без числа ОСТАЁТСЯ, если оно закрыто: «сброшено» — факт, а не отсутствие данных.
    .filter((w) => w.util !== null || w.expired === true)
  const pc = (v: number) => (Math.round(v * 1000) / 10) + '%'
  // 🔴 ОКНА ВСЕХ ОРГАНИЗАЦИЙ — отдельным списком: потребитель (подвал агента) берёт ту,
  // на которой агент РАБОТАЕТ (по orgUid/имени), а не «активную». Активная остаётся в base
  // для обратной совместимости.
  // 🔴 ОРГАНИЗАЦИЯ БЕЗ ПРОПУСКА — ЭТО ФАКТ, А НЕ ТИШИНА (просьба home-relishev-general
  // 22.10: «чтобы отсутствие пропуска не было тишиной»). Организация, вошедшая в opencode, но
  // не попавшая в хранилище пропусков, в отчёте выглядела ровно как «окон нет» — то же самое,
  // что «ещё не измерена». Агент садился на неё и падал отказом, а читатель не видел причины.
  // Признак детерминированный: провайдерская запись `console` без срока жизни пропуска =
  // пропуска в хранилище нет. Организация на ключе API (`auth: api_key`) срока не имеет по
  // устройству и в этот признак НЕ попадает — это разные вещи, и склеивать их нельзя.
  const credentialOf = (o: GoOrgStatus): { credential?: 'no_token' | 'rejected' } => {
    // Пропуска нет вовсе: провайдерская запись `console` без срока жизни.
    if (o.auth !== 'api_key' && !o.expires_at_ms) return { credential: 'no_token' }
    // Пропуск/ключ ЕСТЬ, а поставщик его отвергает (`api_key_expired`, `authentication_error`,
    // 401). Это тоже не «окон нет»: организация непригодна по причине, которую читатель обязан
    // видеть, иначе агент упирается в отказ без объяснения. Текст причины остаётся в
    // `usage_error` у двери реестра; в отчёт едет только класс — без чужих подробностей.
    if (typeof o.usage_error === 'string' && /401|authentication_error|api_key_expired|Unauthorized/i.test(o.usage_error)) {
      return { credential: 'rejected' }
    }
    return {}
  }
  const perOrg = (orgs ?? []).map((o) => {
    const u = (o.usage ?? {}) as GoUsage
    // Тот же ценз по сбросу, что и у активной организации: у КАЖДОЙ орг свои окна и свой сброс.
    const o5 = livePct(u.rolling), o7 = livePct(u.weekly), oM = livePct(u.monthly)
    const lng = o7 === null ? oM : oM === null ? o7 : Math.max(o7, oM)
    const status = typeof o.status === 'string' && o.status ? o.status : 'active'
    return {
      name: o.name,
      // uid — мост к `member.orgUid`; нет в карте — поля нет (потребитель не выдумывает).
      ...(orgUids?.[o.name] ? { uid: orgUids[o.name] } : {}),
      // 🔴 Только при ПОДТВЕРЖДЁННОЙ паре: проставить false всем — значит утверждать
      // «не активна» там, где мы не знаем. Неизвестно → поля НЕТ ни у одной.
      ...(resolution.name ? { active: o.name === resolution.name } : {}),
      util5h: o5 === null ? null : o5 / 100,
      util7d: o7 === null ? null : o7 / 100,
      utilMonth: oM === null ? null : oM / 100,
      level: classifyLevel(o5 === null ? null : o5 / 100, lng === null ? null : lng / 100),
      // Статус и модельная привязка организации (FR-1/FR-18): их читает пускатель при
      // рождении — «не ограничена и имеет нужную модель». Отсутствие остаётся отсутствием:
      // статуса нет — `active`; причины нет при не-restricted — поля нет; моделей нет — поля нет.
      status,
      // Причина едет ТОЛЬКО при `restricted`: иначе случайная причина читалась бы
      // как запрет, которого нет (FR-1: причина обязательна при флаге).
      ...(status === 'restricted' && typeof o.restricted_reason === 'string' && o.restricted_reason
        ? { restrictedReason: o.restricted_reason } : {}),
      ...(Array.isArray(o.models) && o.models.length ? { models: o.models.map(String) } : {}),
      // 🔴 ОРГАНИЗАЦИЯ БЕЗ ПРОПУСКА — ЭТО ФАКТ, А НЕ ТИШИНА (просьба home-relishev-general
      // 22.10, своими словами: «чтобы отсутствие пропуска не было тишиной»). Организация,
      // вошедшая в opencode, но не попавшая в хранилище пропусков, в отчёте выглядела ровно
      // как «окон нет» — то же самое, что «ещё не измерена». Агент садился на неё и падал
      // отказом, а читатель не видел причины. Признак детерминированный: провайдерская
      // запись `console` без срока жизни пропуска = пропуска в хранилище нет.
      ...credentialOf(o),
      windows: [win('5h', u.rolling, o5), win('week', u.weekly, o7), win('month', u.monthly, oM)]
        .filter((w) => w.util !== null || w.expired === true),
    }
  })
  return {
    ...base,
    orgs: perOrg,
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
        // Закрытое окно называется словами, а не `null%`: «сброшено 17:21» — это факт, а
        // «null%» читается как поломка замера. Ровно тот класс, из-за которого число
        // закрытого окна и попадало в подвал как живое.
        message: windows.length === 0
          ? `opencode-go (${org}${activityNote}): план не ограничивает окна.`
          : `opencode-go (${org}${activityNote}): ` + windows.map((w) => (
            w.expired === true
              ? `${w.window} сброшено${w.resetIso ? ' ' + String(w.resetIso).slice(11, 16) + 'Z' : ''} (окно началось заново)`
              : `${w.window} ${pc(w.util as number)}`
          )).join(', ') + '.',
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

/**
 * СОБЫТИЕ ПЕРЕХОДА, А НЕ СОСТОЯНИЕ (просьба фаундера через home-relishev-general, 23.10.2026):
 * «включая кейс, когда квота сбросилась, а факта об этом не пришло — может надо, чтобы приходил».
 *
 * Зачем: файл отчёта отвечает «как СЕЙЧАС», и потребитель, не видевший прошлого снимка, не может
 * отличить «окно только что сброшено» от «оно сброшено давно» и от «данных нет». Событие снимает
 * это угадывание: одна строка на ПЕРЕХОД, ровно один раз.
 *
 * 🔴 КАК ГАРАНТИРУЕТСЯ «РОВНО ОДИН РАЗ» БЕЗ ВТОРОГО ФАЙЛА СОСТОЯНИЯ: ключ перехода —
 * `(org, window, previousResetAt)`, и он же лежит в журнале. Перед записью журнал читается
 * (хвост, ограниченно), и строка с тем же ключом второй раз не пишется. Перезапуск службы,
 * повторный снимок и дрожание расписания молчат. Новый цикл окна даёт НОВЫЙ `resetAt` — то есть
 * новый ключ и новое событие.
 */
export interface QuotaResetEvent {
  schema: 1
  at: string
  org: string
  window: string
  kind: 'reset'
  /** Момент, который был сроком ЗАКРЫВШЕГОСЯ окна: по нему событие и опознаётся. */
  previousResetAt: string
  detectedBy: 'quota-collector'
}

/** Ключ перехода — то же, что делает событие единственным. */
export const resetEventKey = (org: string, window: string, previousResetAt: string): string =>
  `${org}|${window}|${previousResetAt}`

/** Читает ключи уже записанных переходов (хвост файла, не весь: журнал растёт медленно, но вечно). */
export function readResetEventKeys(path: string, maxBytes = 256 * 1024): Set<string> {
  const keys = new Set<string>()
  try {
    const buf = readFileSync(path)
    const tail = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf
    for (const line of tail.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line) as Partial<QuotaResetEvent>
        if (typeof e.org === 'string' && typeof e.window === 'string' && typeof e.previousResetAt === 'string') {
          keys.add(resetEventKey(e.org, e.window, e.previousResetAt))
        }
      } catch { /* битая строка не рушит чтение остальных */ }
    }
  } catch { /* файла нет — переходов ещё не было */ }
  return keys
}

/**
 * Какие переходы записать. ЧИСТАЯ функция: ни файлов, ни часов — всё приходит на вход.
 * Берутся только ЗАКРЫТЫЕ окна: у живого окна перехода не было.
 */
export function resetTransitions(input: {
  org: string
  windows: ReadonlyArray<{ window: string; resetIso?: string | null; expired?: boolean }>
  at: string
  seen: ReadonlySet<string>
}): QuotaResetEvent[] {
  const out: QuotaResetEvent[] = []
  for (const w of input.windows) {
    if (w.expired !== true) continue
    const prev = typeof w.resetIso === 'string' && w.resetIso ? w.resetIso : null
    // Без срока перехода не существует: «истекло когда-то» — не факт о конкретном окне.
    if (!prev) continue
    if (input.seen.has(resetEventKey(input.org, w.window, prev))) continue
    out.push({
      schema: 1, at: input.at, org: input.org, window: w.window,
      kind: 'reset', previousResetAt: prev, detectedBy: 'quota-collector',
    })
  }
  return out
}

/** Дописывает события. Ошибка записи НЕ роняет сбор квоты — журнал это весть, а не путь обслуживания. */
export function appendResetEvents(path: string, events: readonly QuotaResetEvent[]): number {
  if (events.length === 0) return 0
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, events.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 })
    try { chmodSync(path, 0o600) } catch { /* файл мог быть создан раньше с другим режимом */ }
    return events.length
  } catch {
    return 0
  }
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
  /** Путь к базе opencode (по умолчанию `OPENCODE_DB_PATH` или ~/.local/share/opencode/opencode.db).
   *  Нужен испытаниям, чтобы не читать живую базу. */
  dbPath?: string
  /** Журнал СОБЫТИЙ перехода (по умолчанию рядом с отчётом, `quota-events.jsonl`). */
  eventsPath?: string
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
  // 🔴 Кто в работе — СВЕРКА, а не копия: реестр говорит одно, `account_state` — другое,
  // и 22.10 они разошлись. База читается напрямую, путь переопределяется для испытаний.
  const dbPath = opts.dbPath ?? process.env.OPENCODE_DB_PATH
    ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  const accountState = readActiveAccountEmail(dbPath)
  const registryActiveOrg = registry?.orgs.find((o) => o.active === true) ?? null
  const activeOrgResolution = resolveActiveOrg({
    registryActive: registryActiveOrg
      ? { name: registryActiveOrg.name ?? null, workspace: registryActiveOrg.workspace ?? null }
      : null,
    accountEmail: accountState.email,
    accountId: accountState.accountId,
    accountOrgId: accountState.orgId,
    registryOrgNames: (registry?.orgs ?? []).map((o) => o.name),
  })
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
    activeOrg: activeOrgResolution,
    accountHint: activeOrg?.name ?? 'opencode-go-unknown',
    models,
    modelsSource: [sub.source, litellmSource].join('; '),
    measuredAt,
    orgs: registry?.orgs,
    orgUids: readOrgUids(ORG_UIDS_JSON),
  })
  writeAtomic(opts.outPath, status)
  // СОБЫТИЯ ПЕРЕХОДА — рядом с отчётом, после его записи. Ошибка журнала квоту не отменяет:
  // отчёт уже на диске, а весть — дополнение к нему, не его условие.
  try {
    const eventsPath = opts.eventsPath ?? process.env.GO_QUOTA_EVENTS_PATH
      ?? join(dirname(opts.outPath), 'quota-events.jsonl')
    const orgs = Array.isArray((status as any).orgs) ? (status as any).orgs : []
    const seen = readResetEventKeys(eventsPath)
    const events = orgs.flatMap((o: any) => resetTransitions({
      org: String(o?.name ?? ''),
      windows: Array.isArray(o?.windows) ? o.windows : [],
      at: measuredAt.toISOString(),
      seen,
    })).filter((e: QuotaResetEvent) => e.org !== '')
    appendResetEvents(eventsPath, events)
  } catch { /* журнал переходов — весть, а не путь обслуживания */ }
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
