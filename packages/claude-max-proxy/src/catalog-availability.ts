/**
 * Донесения доступности моделей в КАТАЛОГ ЗАПУСКА (SynqTask, `PUT /availability`).
 *
 * 🔴 ЗАЧЕМ ЭТО ОТДЕЛЬНОЕ ДЕЙСТВИЕ, А НЕ СТРОКА В ПРОКСИ. Каталог хранит пары
 * «программа + модель» и показывает агенту только те, о которых какая-то машина
 * СКАЗАЛА, что они у неё работают. Молчание там читается как «никто не мерил»
 * (`available: null`), а не как «не работает» — поэтому отчёт обязан быть замером,
 * а не украшением. Смысл отчёта — каталога; наша половина — носильщик, который
 * знает про свою машину и ничего не выдумывает про чужие.
 *
 * 🔴 ОТЧЁТ ЗАМЕНЯЕТ СНИМОК МАШИНЫ ЦЕЛИКОМ (`launch-catalog.ts:181`,
 * `store.launchAvailability.set(machine, …)`). Значит:
 *   • пустой отчёт = «на этой машине не запускается ничего» — ЛОЖЬ при любом сбое
 *     сбора, поэтому пустой снимок не отправляется никогда;
 *   • пропавшая из отчёта модель обязана из снимка исчезнуть — это не потеря, а
 *     правильная семантика, и обходить её «дописыванием старого» нельзя.
 *
 * 🔴 ПОЧЕМУ `ok` СТАВИТСЯ БЕЗ ПРОБЫ (и что это честно значит). Ключ чтения списка
 * (`catalog-sync-read`) намеренно не умеет вызывать модели (`rpm 0`), а проба
 * каждого вызова стоила бы СЧЁТЧИКОВ ПОДПИСКИ — того единственного, что у нас
 * реально расходуется. Поэтому `ok: true` здесь означает «фронт объявляет эту
 * модель на этой машине», и это записано в `detail` словами. Если понадобится
 * настоящая проба — это отдельное решение: она покупает уверенность за подписку.
 *
 * ВЫКЛЮЧЕНО ПО УМОЛЧАНИЮ: без `CATALOG_AVAILABILITY_ENABLED='true'` таймера нет
 * вовсе (а не «таймер, который молчит») — так в health видно, что донесения не
 * включены, а не что они работают тихо.
 */

import { readFileSync } from 'node:fs'

/** Как часто отправляем снимок. Пять минут — компромисс между свежестью и шумом в журнале. */
export const DEFAULT_INTERVAL_MS = 5 * 60_000

/** Модель в отчёте — ровно те поля, которые каталог принимает и хранит. */
export interface ReportedModel {
  model: string
  ok: boolean
  probedAt?: string
  detail?: string
}

export interface ReportedHarness {
  harness: string
  version?: string
  models: ReportedModel[]
  /**
   * Какие ПРОСТРАНСТВА ИМЁН этот отчёт покрывает, например `["kiberos-go/"]`.
   *
   * 🔴 ЗАЧЕМ ЯВНО (26.10.2026, просьба владельца каталога). Раньше область выводилась из
   * префиксов моделей — и первый же живой прогон спрятал 18 ПРЯМЫХ пар: моё «две модели»
   * прочиталось как «больше нет ни у кого». Вывод там, где уже горело, — плохая опора;
   * теперь отчёт НАЗЫВАЕТ свою область, а не оставляет её угадывать. Поле необязательное:
   * не прислали — потребитель выводит из префиксов, как раньше.
   */
  namespaces: string[]
}

export interface AvailabilityReport {
  machine: string
  harnesses: ReportedHarness[]
}

export interface CatalogAvailabilityConfig {
  enabled: boolean
  /** Полный адрес `PUT /availability` каталога. null — некуда писать. */
  url: string | null
  /** Файл с секретом писателя (машинная учётка с грантом `launch.report`). */
  secretFile: string | null
  /**
   * Имена ключей ВНУТРИ файла, если это env-файл (`KEY=value`), а не готовая строка.
   * По умолчанию — контракт SynqTask: id машинной учётки и её секрет.
   */
  secretIdKey: string
  secretKey: string
  /** Устойчивое имя этой машины в каталоге. */
  machine: string | null
  /** Откуда читать список моделей фронта. */
  modelsUrl: string
  /** Файл с читающим ключом к списку моделей фронта. */
  modelsKeyFile: string | null
  /** Имя программы, как его знает каталог (`claude-code`, `opencode`, `dsh`). */
  harness: string
  /**
   * Какие id из списка фронта принадлежат ЭТОЙ программе. Обязателен; `*` — «все, и я это
   * осознал».
   *
   * 🔴 ПОЧЕМУ НЕ «ВСЕ ПО УМОЛЧАНИЮ». Синк каталога ДОБАВЛЯЕТ пары, о которых отчёт сказал
   * `ok: true`, а ключ пары — (программа, модель) (`syncLaunchCatalogFromReports`,
   * `launch-catalog.ts:262`). Значит отчёт «всё подряд под одним именем программы» не просто
   * шумит: он заводит в каталоге НАСТОЯЩИЕ пары вида «claude-code × kiberos-go/flash», и
   * человек потом увидит их в меню. Молчание безопасно, выдуманная пара — нет.
   */
  modelPrefix: string
  /**
   * Пространство имён каталога, которое приписывается к id модели (например `kiberos-go/`).
   * Каталог называет пару `opencode:kiberos-go/<id фронта>` — имя модели в отчёте обязано
   * совпасть с этим точно, иначе синк заведёт пару, которой нет.
   */
  modelNamespace: string
  intervalMs: number
}

export interface CatalogAvailabilityDeps {
  /**
   * Уже́е, чем `typeof fetch`: нам нужна только эта форма вызова. Так подмена в
   * испытании — обычная функция, а не объект, обязанный нести ещё и `preconnect`.
   */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>
  now?: () => number
  readFile?: (path: string) => string
  log?: (line: string) => void
}

export interface AvailabilityOutcome {
  sent: boolean
  reason?: string
  models?: number
  status?: number
}

function env(environ: Record<string, string | undefined>, key: string): string | null {
  const v = environ[key]
  return v === undefined || v.trim() === '' ? null : v.trim()
}

function num(environ: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env(environ, key)
  const n = raw === null ? NaN : Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function readCatalogAvailabilityConfig(environ: Record<string, string | undefined>): CatalogAvailabilityConfig {
  return {
    enabled: env(environ, 'CATALOG_AVAILABILITY_ENABLED') === 'true',
    url: env(environ, 'CATALOG_AVAILABILITY_URL'),
    secretFile: env(environ, 'CATALOG_AVAILABILITY_SECRET_FILE'),
    secretIdKey: env(environ, 'CATALOG_AVAILABILITY_SECRET_ID_KEY') ?? 'SYNQTASK_REPORTER_ID',
    secretKey: env(environ, 'CATALOG_AVAILABILITY_SECRET_KEY') ?? 'SYNQTASK_REPORTER_SECRET',
    machine: env(environ, 'CATALOG_AVAILABILITY_MACHINE'),
    modelsUrl: env(environ, 'CATALOG_AVAILABILITY_MODELS_URL') ?? 'http://127.0.0.1:4000/v1/models',
    modelsKeyFile: env(environ, 'CATALOG_AVAILABILITY_MODELS_KEY_FILE'),
    harness: env(environ, 'CATALOG_AVAILABILITY_HARNESS') ?? 'opencode',
    modelPrefix: env(environ, 'CATALOG_AVAILABILITY_MODEL_PREFIX') ?? '',
    modelNamespace: env(environ, 'CATALOG_AVAILABILITY_MODEL_NAMESPACE') ?? '',
    intervalMs: num(environ, 'CATALOG_AVAILABILITY_INTERVAL_MS', DEFAULT_INTERVAL_MS),
  }
}

/**
 * Почему донесение невозможно как НАСТРОЕНО. Пустая строка — всё на месте.
 * Отдельно от сборки: причину надо называть в журнале, а не молча выключаться.
 */
export function missingSettings(cfg: CatalogAvailabilityConfig): string[] {
  const missing: string[] = []
  if (!cfg.enabled) missing.push('CATALOG_AVAILABILITY_ENABLED')
  if (!cfg.url) missing.push('CATALOG_AVAILABILITY_URL')
  if (!cfg.secretFile) missing.push('CATALOG_AVAILABILITY_SECRET_FILE')
  if (!cfg.machine) missing.push('CATALOG_AVAILABILITY_MACHINE')
  if (!cfg.modelsKeyFile) missing.push('CATALOG_AVAILABILITY_MODELS_KEY_FILE')
  // Обязателен намеренно: см. комментарий у `modelPrefix` — отчёт «всё под одной программой»
  // заводит в каталоге пары, которых нет.
  if (!cfg.modelPrefix) missing.push('CATALOG_AVAILABILITY_MODEL_PREFIX')
  if (!cfg.modelNamespace) missing.push('CATALOG_AVAILABILITY_MODEL_NAMESPACE')
  return missing
}

/** Сырое содержимое файла — для ключа чтения витрины (он всегда одна строка, не env-файл). */
function readRaw(path: string, deps: CatalogAvailabilityDeps): string | null {
  try {
    const v = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path).trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}

interface WriterCredentials {
  id: string | null
  secret: string
}

/**
 * Учётные данные писателя из файла. Две законные формы, и обе поддерживаются, потому что
 * владелец двери выбирает форму, а не я:
 *   • env-файл (`KEY=value`) — берём id и секрет по именам ключей (контракт SynqTask);
 *   • готовая строка — тогда это Bearer-токен.
 * Пустая строка, отсутствующий файл или файл без секрета — это ОТКАЗ, а не «отправим как есть».
 */
function readCredentials(cfg: CatalogAvailabilityConfig, deps: CatalogAvailabilityDeps): WriterCredentials | null {
  let raw: string
  try {
    raw = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(cfg.secretFile as string)
  } catch {
    return null
  }
  const trimmed = raw.trim()
  if (trimmed === '') return null

  const vars: Record<string, string> = {}
  for (const line of trimmed.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    vars[m[1]] = m[2].replace(/^["']|["']$/g, '').trim()
  }
  const secret = vars[cfg.secretKey]
  if (secret) return { id: vars[cfg.secretIdKey] ?? null, secret }
  // Ни одного KEY=value — значит в файле лежит сам токен.
  return { id: null, secret: trimmed }
}

/** Список моделей фронта. Пустой список — законный ответ, поэтому отдельно от ошибки. */
async function fetchModels(cfg: CatalogAvailabilityConfig, deps: CatalogAvailabilityDeps): Promise<string[] | null> {
  const key = cfg.modelsKeyFile ? readRaw(cfg.modelsKeyFile, deps) : null
  if (!key) return null
  const f = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
  try {
    const res = await f(cfg.modelsUrl, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
    const ids = (body.data ?? []).map((m) => m?.id).filter((id): id is string => typeof id === 'string' && id !== '')
    return ids
  } catch {
    return null
  }
}

/**
 * Собирает снимок. `null` — отправлять нельзя: нет настроек, нет ключа, нет ответа
 * фронта или список пуст. Все четыре случая означают одно: мы НЕ ЗНАЕМ, что у нас
 * запускается, а снимок «мы ничего не умеем» дороже молчания.
 */
export async function buildReport(
  cfg: CatalogAvailabilityConfig,
  deps: CatalogAvailabilityDeps = {},
): Promise<{ report: AvailabilityReport | null; reason?: string }> {
  if (missingSettings(cfg).length > 0) return { report: null, reason: `not configured: ${missingSettings(cfg).join(', ')}` }

  const ids = await fetchModels(cfg, deps)
  if (ids === null) return { report: null, reason: 'models list unavailable (no answer or no key)' }
  if (ids.length === 0) return { report: null, reason: 'models list is empty — an empty snapshot would claim this machine starts nothing' }

  // Несколько префиксов через запятую: у фронта модели Go названы по-разному
  // (`deepseek-v4.1-flash-go`, `muse-spark-1.3-contributor`), общего префикса у них нет.
  const prefixes = cfg.modelPrefix === '*'
    ? []
    : cfg.modelPrefix.split(',').map((p) => p.trim()).filter(Boolean)
  const mine = cfg.modelPrefix === '*'
    ? ids
    : ids.filter((id) => prefixes.some((p) => id.startsWith(p)))
  if (mine.length === 0) {
    return { report: null, reason: `no models match prefix '${cfg.modelPrefix}' — refusing to report an empty snapshot` }
  }

  const probedAt = new Date((deps.now ?? Date.now)()).toISOString()
  const report: AvailabilityReport = {
    machine: cfg.machine as string,
    harnesses: [
      {
        harness: cfg.harness,
        version: undefined,
        // 🔴 БЕЗ ЗАВЕДУЩЕГО СЛЭША — в такой форме его ХРАНИТ дверь (замер 26.10.2026:
        // на провод уходит `kiberos-go/`, в store лежит `kiberos-go`). Две формы одного
        // имени — это два источника правды; пусть на проводе будет та же, что в хранилище.
        namespaces: [cfg.modelNamespace.replace(/\/+$/, '')].filter(Boolean),
        models: mine.map((id) => ({
          model: `${cfg.modelNamespace}${id}`,
          ok: true,
          probedAt,
          detail: 'listed by the gateway; not probed (a probe would spend subscription counters)',
        })),
      },
    ],
  }
  return { report }
}

/**
 * Один ход: собрать и отправить. Возвращает сводку — её печатает вызывающий, если ему есть куда.
 * Значения секретов сюда не попадают никогда: ни в сводку, ни в причину отказа.
 */
export async function sendAvailability(
  cfg: CatalogAvailabilityConfig,
  deps: CatalogAvailabilityDeps = {},
): Promise<AvailabilityOutcome> {
  const { report, reason } = await buildReport(cfg, deps)
  if (!report) return { sent: false, reason }

  const creds = cfg.secretFile ? readCredentials(cfg, deps) : null
  if (!creds) return { sent: false, reason: 'secret file missing or unreadable' }

  // 🔴 МАШИННАЯ УЧЁТКА — ЭТО ДВА ЗАГОЛОВКА, А НЕ BEARER (замер 26.10.2026): дверь
  // SynqTask аутентифицирует по `X-Agent-Id` + `X-Agent-Secret`; Bearer с тем же секретом
  // получает 401. Если в файле лежит готовая строка без пары id — идём Bearer'ом и не делаем
  // вид, что это одно и то же.
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (creds.id) {
    headers['x-agent-id'] = creds.id
    headers['x-agent-secret'] = creds.secret
  } else {
    headers.authorization = `Bearer ${creds.secret}`
  }

  const f = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
  try {
    const res = await f(cfg.url as string, {
      method: 'PUT',
      headers,
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15_000),
    })
    const models = report.harnesses.reduce((n, h) => n + h.models.length, 0)
    if (!res.ok) return { sent: false, reason: `catalog answered ${res.status}`, models, status: res.status }
    return { sent: true, models, status: res.status }
  } catch (err: any) {
    // 🔴 ТАЙМАУТ — ЭТО НЕ «НЕ ДОШЛО» (замер 26.10.2026): первый же ход по таймеру отвалился по
    // сроку, а отчёт на двери ПОЯВИЛСЯ. Дверь пишет в хранилище и может ответить позже, чем
    // наш срок. Назвать это «unreachable» значит потом чинить несуществующую сеть.
    const name = String(err?.name ?? '')
    const timedOut = name === 'TimeoutError' || name === 'AbortError' || /timed out/i.test(String(err?.message ?? ''))
    return {
      sent: false,
      reason: timedOut
        ? 'no answer within the timeout — the report MAY have landed; outcome unknown, not a failure'
        : `catalog unreachable: ${String(err?.message ?? err).slice(0, 120)}`,
    }
  }
}

/**
 * Таймер. Включённый, но недонастроенный — НЕ запускается и говорит причину один
 * раз при старте: таймер, который каждые пять минут пишет «не настроен», читается
 * как работа, и по нему нельзя понять, что донесений нет вовсе.
 */
export function startCatalogAvailability(
  cfg: CatalogAvailabilityConfig,
  deps: CatalogAvailabilityDeps = {},
): () => void {
  if (!cfg.enabled) return () => {}
  const missing = missingSettings(cfg)
  if (missing.length > 0) {
    deps.log?.(`CATALOG_AVAILABILITY off — missing: ${missing.join(', ')}`)
    return () => {}
  }

  let stopped = false
  const run = async () => {
    if (stopped) return
    const out = await sendAvailability(cfg, deps)
    const target = cfg.machine
    if (out.sent) {
      deps.log?.(`CATALOG_AVAILABILITY sent machine=${target} models=${out.models} status=${out.status}`)
    } else {
      deps.log?.(`CATALOG_AVAILABILITY skipped machine=${target} reason=${out.reason}`)
    }
  }

  const timer = setInterval(() => { void run() }, cfg.intervalMs)
  ;(timer as any).unref?.()
  void run()
  return () => { stopped = true; clearInterval(timer) }
}
