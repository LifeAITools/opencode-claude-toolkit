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
    machine: env(environ, 'CATALOG_AVAILABILITY_MACHINE'),
    modelsUrl: env(environ, 'CATALOG_AVAILABILITY_MODELS_URL') ?? 'http://127.0.0.1:4000/v1/models',
    modelsKeyFile: env(environ, 'CATALOG_AVAILABILITY_MODELS_KEY_FILE'),
    harness: env(environ, 'CATALOG_AVAILABILITY_HARNESS') ?? 'claude-code',
    modelPrefix: env(environ, 'CATALOG_AVAILABILITY_MODEL_PREFIX') ?? '',
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
  return missing
}

function readSecret(path: string, deps: CatalogAvailabilityDeps): string | null {
  try {
    const raw = (deps.readFile ?? ((p: string) => readFileSync(p, 'utf8')))(path)
    const v = raw.trim()
    return v === '' ? null : v
  } catch {
    // Файла нет или он нечитаем — это причина не отправлять, а не повод отправить пустое.
    return null
  }
}

/** Список моделей фронта. Пустой список — законный ответ, поэтому отдельно от ошибки. */
async function fetchModels(cfg: CatalogAvailabilityConfig, deps: CatalogAvailabilityDeps): Promise<string[] | null> {
  const key = cfg.modelsKeyFile ? readSecret(cfg.modelsKeyFile, deps) : null
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

  const mine = cfg.modelPrefix === '*' ? ids : ids.filter((id) => id.startsWith(cfg.modelPrefix))
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
        models: mine.map((id) => ({
          model: id,
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

  const secret = cfg.secretFile ? readSecret(cfg.secretFile, deps) : null
  if (!secret) return { sent: false, reason: 'secret file missing or unreadable' }

  const f = deps.fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i))
  try {
    const res = await f(cfg.url as string, {
      method: 'PUT',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(15_000),
    })
    const models = report.harnesses.reduce((n, h) => n + h.models.length, 0)
    if (!res.ok) return { sent: false, reason: `catalog answered ${res.status}`, models, status: res.status }
    return { sent: true, models, status: res.status }
  } catch (err: any) {
    return { sent: false, reason: `catalog unreachable: ${String(err?.message ?? err).slice(0, 120)}` }
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
