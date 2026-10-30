/**
 * Выбор организации Go, когда её НЕ НАЗВАЛИ явно — по ЗАПАСУ, а не по `active:` реестра.
 *
 * 🔴 ЗАЧЕМ. `pickOrg` без заголовка берёт ту, что в реестре помечена `active` (`name === reg.active`).
 * Пока трафик шёл через посредник с его собственной логикой, это было незаметно. В момент, когда
 * дверь становится ЕДИНСТВЕННЫМ путём (перевод записей LiteLLM на `:5050/go`), это превращается в
 * тихую беду: 21.10 замерено — `active: hello` при 7д=0.91, а свежая `hello@kiberos.app` при 0/0/0.
 * Весь флот пошёл бы в почти исчерпанную организацию, упёрся в неделю и начал получать 429 —
 * при живой свежей орг рядом и без единой ошибки в `/health`.
 *
 * ПРАВИЛО ВЗЯТО У ФАУНДЕРА (16.10): отдельного порога нет — «берём лучшую из них, надо в итоге
 * израсходовать лимит по всем организациям равномерно до 100%». То есть выбираем max(1−util5h);
 * при равенстве — лучшая неделя, затем порядок реестра. Отказ — только когда выбирать не из чего.
 *
 * 🔴 СЧИТАЕМ СЧЁТЧИКИ ПОДПИСКИ, А НЕ ЦЕНЫ. Никаких «стоимость чтения/записи» здесь нет и быть
 * не может (рельс `ka-subscription-not-api`): util — это доля окна, её отдаёт сам поставщик.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GoOrg } from './go-registry.js'

/** Окно организации из отчёта: сколько израсходовано и когда сбросится. */
export interface OrgWindow {
  window: string
  util: number | null
  resetAt: number | null
}

/** Окна одной организации так, как их видит отчёт квоты. Поля могут отсутствовать. */
export interface OrgQuotaView {
  name: string
  util5h?: number | null
  util7d?: number | null
  utilMonth?: number | null
  /** `active | exhausted | restricted | retired` — из реестра; нет поля → считаем `active`. */
  status?: string | null
  /** Сырые окна (новый отчёт): из них считается время до стены. */
  windows?: OrgWindow[]
}

/** Запас по окну: 1 − util. Неизвестное окно запаса не даёт и кандидата не улучшает. */
function headroom(util: number | null | undefined): number | null {
  if (typeof util !== 'number' || !Number.isFinite(util)) return null
  return 1 - util
}

/** Исчерпано ли хоть одно ИЗВЕСТНОЕ окно. Неизвестные окна исчерпанными НЕ считаем. */
function exhausted(q: OrgQuotaView): boolean {
  for (const u of [q.util5h, q.util7d, q.utilMonth]) {
    if (typeof u === 'number' && Number.isFinite(u) && u >= 1) return true
  }
  return false
}

export interface PickByHeadroomResult {
  org: GoOrg | null
  /** Почему именно эта — для журнала/отладки; значения токенов сюда не попадают. */
  reason: string
}

/**
 * Выбирает организацию с наибольшим запасом.
 *
 * Кандидаты: консольные, не `restricted`/`retired`, имеют пропуск в хранилище, ни одно известное
 * окно не исчерпано. Нет ни одного кандидата или нет ни одного ЗАМЕРА — `org: null`, и вызывающий
 * откатывается на прежнее правило (`active:`): «замера нет» ≠ «выбирать нечего».
 */
/**
 * Читает отчёт квоты (тот же файл, что рисует подвал агентам). Файл может отсутствовать или быть
 * неполным — это НЕ ошибка выбора: вернём пустой список, и вызывающий откатится на `active:`.
 */
export function readOrgQuotas(path: string): OrgQuotaView[] {
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { orgs?: unknown; accounts?: unknown }
    const rows = Array.isArray(doc.orgs)
      ? doc.orgs
      : doc.accounts && typeof doc.accounts === 'object'
        ? Object.entries(doc.accounts as Record<string, unknown>).map(([name, v]) => ({ name, ...(v as object) }))
        : []
    const out: OrgQuotaView[] = []
    for (const raw of rows as any[]) {
      if (!raw || typeof raw.name !== 'string') continue
      out.push({
        name: raw.name,
        util5h: numOrNull(raw.util5h),
        util7d: numOrNull(raw.util7d),
        utilMonth: numOrNull(raw.utilMonth),
        status: typeof raw.status === 'string' ? raw.status : null,
        windows: Array.isArray(raw.windows)
          ? raw.windows
            .filter((w: any) => w && typeof w.window === 'string')
            .map((w: any) => ({
              window: w.window,
              util: numOrNull(w.util),
              resetAt: typeof w.resetAt === 'number' && Number.isFinite(w.resetAt) ? w.resetAt : null,
            }))
          : undefined,
      })
    }
    return out
  } catch {
    return []
  }
}

function numOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** Читает хранилище пропусков и говорит, у какой организации там есть вход. Токены не возвращает. */
export function readStoreOrgNames(path: string | null): Set<string> {
  if (!path) return new Set()
  const names = new Set<string>()
  const collect = (doc: { orgs?: Record<string, { access_token?: unknown }> } | null) => {
    for (const [k, v] of Object.entries(doc?.orgs ?? {})) {
      if (v && typeof v.access_token === 'string' && v.access_token !== '') names.add(k)
    }
  }
  try { collect(JSON.parse(readFileSync(path, 'utf8'))) } catch { /* нет хранилища — нет имён */ }
  // 🔴 ОЧЕРЕДЬ НОВЫХ ВХОДОВ ЧИТАЕМ ТОЖЕ (замер 22.10, hello@sealform.dev): вход ложится в
  // `.go-tokens.incoming.json` и до слияния писателем НЕ виден в основном хранилище. Для выбора
  // организации это значило «пропуска нет» на живой, только что оплаченной организации — и
  // выбор по запасу её просто не рассматривал. Писать очередь по-прежнему имеет право только
  // её писатель; читать — можно, и обновлятор сам давно читает проекцию «своё + входящее».
  try {
    const raw = JSON.parse(readFileSync(join(dirname(path), '.go-tokens.incoming.json'), 'utf8')) as any
    collect(raw && typeof raw === 'object' && raw.orgs ? raw : { orgs: raw })
  } catch { /* очереди нет — обычный случай */ }
  return names
}

/**
 * Годится ли НАЗВАННАЯ организация сейчас — те же фильтры, что у выбора.
 *
 * 🔴 ЗАЧЕМ ОТДЕЛЬНО. Выданная однажды организация должна ПЕРЕИСПОЛЬЗОВАТЬСЯ, пока она годна
 * (правило фаундера 26.10: «если сессию знаем — организация была уже выдана»). Но переиспользовать
 * её вслепую нельзя: пропуск мог исчезнуть, окно — исчерпаться, организацию — закрыть. Тогда
 * сессию надо переселить ОДИН раз, а не молча получать 401.
 */
export function isOrgUsable(
  orgs: GoOrg[],
  quotas: OrgQuotaView[],
  hasCredential: (name: string) => boolean,
  name: string,
): boolean {
  return orgUnusableReason(orgs, quotas, hasCredential, name) === null
}

/**
 * ПОЧЕМУ выданная организация больше не годится — или `null`, если годится.
 *
 * 🔴 Зачем причина, а не да/нет (30.10.2026, разбор «почему pin уезжает внутри сессии»):
 * пока функция отвечала только `false`, переселение сессии было НЕМЫМ — в журнале оставался
 * `source: quota`, и по нему нельзя было отличить «окно кончилось» от «пропуск отозвали» или
 * «строку замера потеряли». Фаундер спрашивал именно это, и отвечать приходилось раскопками.
 *
 * Коды речи: `no-org` (нет в реестре), `not-console` (вход не по подписке), `no-credential`,
 * `no-quota-row` (замера нет), `status:<…>`, `exhausted:<окно>=<доля>` (стена),
 * `util5h-unknown` (доля пятичасового окна не сообщена — тогда судить нельзя, но и выдавать
 * вслепую нельзя).
 */
export function orgUnusableReason(
  orgs: GoOrg[],
  quotas: OrgQuotaView[],
  hasCredential: (name: string) => boolean,
  name: string,
): string | null {
  const org = orgs.find((o) => o.name === name)
  if (!org) return 'no-org'
  if (org.auth !== 'console') return 'not-console'
  if (!hasCredential(org.name)) return 'no-credential'
  const q = quotas.find((row) => row.name === name)
  if (!q) return 'no-quota-row'
  const status = (q.status ?? 'active').toLowerCase()
  if (status === 'restricted' || status === 'retired') return `status:${status}`
  for (const [win, v] of [['5h', q.util5h], ['7d', q.util7d], ['month', q.utilMonth]] as const) {
    if (typeof v === 'number' && Number.isFinite(v) && v >= 1) return `exhausted:${win}=${v}`
  }
  return headroom(q.util5h) !== null ? null : 'util5h-unknown'
}

/** FNV-1a: стабильный тай-брейк, чтобы равные организации не перекидывались между сессиями. */
function stableHash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * ВРЕМЯ ДО СТЕНЫ — модель выбора организации, заданная фаундером 26.10.2026.
 *
 * Зачем вместо «максимума запаса»: запас (1−util) не говорит, КОГДА кончится. Организация
 * с 70% недели может быть безопаснее, чем с 30% пятичасовой, — всё зависит от скорости и от
 * того, когда окно сбросится. Поэтому считается скорость расхода и время до стены.
 *
 * Формула:
 *   elapsed = длина_окна − остаток_до_сброса        (окна короче 15 минут не считаем:
 *                                                    скорость на них неизвестна)
 *   rate    = util / elapsed                        (доля окна в час)
 *   ttw     = (1 − util) / rate                     (часы до стены)
 *   окно СВЯЗЫВАЕТ, только если ttw < остаток_до_сброса — иначе оно сбросится раньше,
 *                                                     чем упрётся, и пугать им нельзя
 *   оценка орг = min по СВЯЗЫВАЮЩИМ окнам; нет связывающих → бесконечность (успеет сброситься)
 *   util ≥ 1 хотя бы по одному окну → организация не кандидат
 */
export interface TimeToWall {
  /** Часы до первой стены среди связывающих окон; `Infinity` — таких нет. */
  score: number
  /** Средний остаток по окнам — второй ключ сортировки. */
  avgHeadroom: number
  /** Для журнала: чем именно связывает (или что не связывает ничем). */
  reason: string
}

const WINDOW_HOURS: Record<string, number> = { '5h': 5, week: 7 * 24, month: 30 * 24 }
const MIN_ELAPSED_HOURS = 0.25

export function timeToWall(view: OrgQuotaView, nowMs: number): TimeToWall | null {
  const wins = view.windows ?? []
  if (wins.length === 0) return null
  let head = 0
  let counted = 0
  let best: number | null = null
  const binding: string[] = []
  for (const w of wins) {
    const len = WINDOW_HOURS[w.window]
    if (!len || w.util === null || w.resetAt === null) continue
    const remainingH = Math.max(0, (w.resetAt - nowMs) / 3_600_000)
    const elapsed = len - remainingH
    head += 1 - w.util
    counted++
    if (elapsed < MIN_ELAPSED_HOURS) continue
    const rate = w.util / elapsed
    const ttw = rate <= 1e-9 ? Infinity : Math.max(0, (1 - w.util) / rate)
    if (ttw < remainingH) {
      binding.push(`${w.window}=${ttw === Infinity ? '∞' : ttw.toFixed(0)}ч`)
      if (best === null || ttw < best) best = ttw
    }
  }
  if (counted === 0) return null
  const avgHeadroom = head / counted
  return {
    score: best === null ? Infinity : best,
    avgHeadroom,
    reason: binding.length ? `связывают ${binding.join(', ')}` : 'ни одно окно не связывает',
  }
}

/**
 * Выбор организации по времени до стены.
 *
 * 🔴 ПОРЯДОК ВАЖНЕЕ ФОРМУЛЫ. Модель применяется ТОЛЬКО когда выдачи ещё нет: запиненная
 * сессия не переезжает (иначе платит холодной перезаписью префикса — ровно то, от чего
 * этот слой существует), а явно названная организация вообще не наша логика. Это делает
 * вызывающий: сюда он приходит уже после проверки пина и заголовка.
 *
 * 🔴 ТАЙ-БРЕЙК СТАБИЛЕН ПО СЕССИИ: (оценка desc, средний запас desc, hash(сессия+орг) asc).
 * Без третьего ключа две сессии с равным запасом перекидывались бы между организациями.
 */
export function pickOrgByTimeToWall(
  orgs: GoOrg[],
  quotas: OrgQuotaView[],
  hasCredential: (name: string) => boolean,
  opts: { nowMs?: number; sessionKey?: string | null } = {},
): PickByHeadroomResult {
  const now = opts.nowMs ?? Date.now()
  const byName = new Map(quotas.map((q) => [q.name, q]))
  const scored: Array<{ org: GoOrg; score: number; avg: number; tie: number; reason: string }> = []
  const key = (opts.sessionKey ?? '').trim()

  orgs.forEach((org) => {
    if (org.auth !== 'console') return
    const q = byName.get(org.name)
    if (!q) return
    const status = (q.status ?? 'active').toLowerCase()
    if (status === 'restricted' || status === 'retired') return
    if (!hasCredential(org.name)) return
    // Стена: любое окно исчерпано — не кандидат, даже если остальные пусты.
    const walled = [q.util5h, q.util7d, q.utilMonth].some((u) => typeof u === 'number' && u >= 1)
      || (q.windows ?? []).some((w) => typeof w.util === 'number' && w.util >= 1)
    if (walled) return
    const ttw = timeToWall(q, now)
    if (!ttw) return
    scored.push({
      org,
      score: ttw.score,
      avg: ttw.avgHeadroom,
      tie: stableHash(`${key}|${org.name}`),
      reason: ttw.reason,
    })
  })

  if (scored.length === 0) return { org: null, reason: 'нет кандидата с замером и пропуском' }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score > a.score ? 1 : -1
    if (b.avg !== a.avg) return b.avg - a.avg
    return a.tie - b.tie
  })
  const best = scored[0]
  const hours = best.score === Infinity ? '∞' : `${best.score.toFixed(0)}ч`
  return {
    org: best.org,
    reason: `до стены ${hours} (${best.reason}); запас ${(best.avg * 100).toFixed(0)}% среди ${scored.length}`,
  }
}
