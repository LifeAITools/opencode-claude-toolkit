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
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
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
  /** Что сказал каждый источник — присутствует ВСЕГДА, чтобы `unknown` называл причину. */
  sources: { registry: string | null; accountState: string | null }
  /** Машиночитаемая причина, когда `name` null. */
  reason: 'agreed' | 'account_state_unreadable' | 'account_email_not_in_registry' | 'sources_disagree'
}

export function resolveActiveOrg(input: {
  /** Имя организации из реестра, у которой `active === true` (null — такой нет). */
  registryActive: string | null
  /** email из `account_state` → `account` (null — прочитать не удалось). */
  accountEmail: string | null
  registryOrgNames: string[]
}): ActiveOrgResolution {
  const clean = (v: string | null): string | null =>
    typeof v === 'string' && v.trim() ? v.trim() : null
  const accountEmail = clean(input.accountEmail)
  const registryActive = clean(input.registryActive)
  const sources = { registry: registryActive, accountState: accountEmail }
  if (!accountEmail) return { name: null, sources, reason: 'account_state_unreadable' }
  const names = (Array.isArray(input.registryOrgNames) ? input.registryOrgNames : []).map((n) => String(n).trim())
  if (!names.includes(accountEmail)) return { name: null, sources, reason: 'account_email_not_in_registry' }
  if (registryActive === accountEmail) return { name: accountEmail, sources, reason: 'agreed' }
  return { name: null, sources, reason: 'sources_disagree' }
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
): { email: string | null; orgId: string | null; error: string | null } {
  let db: Database | null = null
  try {
    db = new Database(dbPath, { readonly: true })
    // 🔴 БЕЗ `ORDER BY id` И С ПРОВЕРКОЙ ЧИСЛА СТРОК (поправка владельца реестра 23.10).
    // `account_state` по устройству держит ОДНУ строку. `order by id limit 1` при двух строках
    // молча выбрал бы меньший id и выдал бы выбор за факт — тот же класс, что мы весь месяц
    // ловим. Две строки = «не знаем, какая из них в работе», а не «возьмём первую».
    const count = db.query('select count(*) as n from account_state').get() as { n?: unknown } | null
    const rows = typeof count?.n === 'number' ? count.n : -1
    if (rows === 0) return { email: null, orgId: null, error: 'no account_state row' }
    if (rows !== 1) return { email: null, orgId: null, error: `account_state has ${rows} rows — which pair is in use is unknown` }
    const state = db
      .query('select active_account_id, active_org_id from account_state limit 1')
      .get() as { active_account_id?: unknown; active_org_id?: unknown } | null
    if (!state) return { email: null, orgId: null, error: 'no account_state row' }
    const orgId = typeof state.active_org_id === 'string' && state.active_org_id.trim()
      ? state.active_org_id.trim()
      : null
    const accountId = typeof state.active_account_id === 'string' ? state.active_account_id.trim() : ''
    if (!accountId) return { email: null, orgId, error: 'no active_account_id' }
    const row = db.query('select email from account where id = ?').get(accountId) as { email?: unknown } | null
    if (!row) return { email: null, orgId, error: 'account row not found' }
    const email = typeof row.email === 'string' ? row.email.trim() : ''
    if (!email) return { email: null, orgId, error: 'empty account email' }
    return { email, orgId, error: null }
  } catch (e) {
    return { email: null, orgId: null, error: `account_state unreadable: ${String((e as Error)?.message ?? e).slice(0, 120)}` }
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
    activeSources: resolution.sources,
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
    const o5 = pct(u.rolling), o7 = pct(u.weekly), oM = pct(u.monthly)
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
      windows: [win('5h', u.rolling, o5), win('week', u.weekly, o7), win('month', u.monthly, oM)].filter((w) => w.util !== null),
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
        message: windows.length === 0
          ? `opencode-go (${org}${activityNote}): план не ограничивает окна.`
          : `opencode-go (${org}${activityNote}): ` + windows.map((w) => `${w.window} ${pc(w.util as number)}`).join(', ') + '.',
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
  /** Путь к базе opencode (по умолчанию `OPENCODE_DB_PATH` или ~/.local/share/opencode/opencode.db).
   *  Нужен испытаниям, чтобы не читать живую базу. */
  dbPath?: string
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
  const accountEmail = readActiveAccountEmail(dbPath).email
  const activeOrgResolution = resolveActiveOrg({
    registryActive: registry?.orgs.find((o) => o.active === true)?.name ?? null,
    accountEmail,
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
