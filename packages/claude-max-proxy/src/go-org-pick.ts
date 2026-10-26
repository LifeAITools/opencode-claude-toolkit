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

/** Окна одной организации так, как их видит отчёт квоты. Поля могут отсутствовать. */
export interface OrgQuotaView {
  name: string
  util5h?: number | null
  util7d?: number | null
  utilMonth?: number | null
  /** `active | exhausted | restricted | retired` — из реестра; нет поля → считаем `active`. */
  status?: string | null
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
/** Ширина полосы «почти равного запаса» по умолчанию: 2% пятичасового окна. */
export const DEFAULT_STICKY_BAND = 0.02

export interface PickOptions {
  /**
   * Ключ стабильности (обычно номер сессии). Когда задан, выбор внутри полосы почти равного запаса
   * держится за этим ключом, а не перескакивает на каждый запрос.
   *
   * 🔴 ЗАЧЕМ. Кэш префикса принадлежит АККАУНТУ. Пока организации почти равны (а сразу после сброса
   * они все 0.01–0.06), выбор «максимум запаса» перекидывается между ними от запроса к запросу —
   * и каждый перескок означает холодный префикс на новом аккаунте, то есть ту самую дорогую
   * перезапись, ради предотвращения которой этот слой и существует (замер 26.10: медиана
   * `cached_tokens` 227–428 тыс. на вызов, то есть флот живёт на кэше).
   */
  stickyKey?: string | null
  /** Ширина полосы. По умолчанию `DEFAULT_STICKY_BAND`. */
  band?: number
}

/** FNV-1a: детерминированный и дешёвый — одинаковый ключ даёт одну и ту же организацию. */
function stableHash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function pickOrgByHeadroom(
  orgs: GoOrg[],
  quotas: OrgQuotaView[],
  hasCredential: (name: string) => boolean,
  opts: PickOptions = {},
): PickByHeadroomResult {
  const byName = new Map(quotas.map((q) => [q.name, q]))
  const scored: Array<{ org: GoOrg; h5: number; h7: number; index: number }> = []

  orgs.forEach((org, index) => {
    if (org.auth !== 'console') return
    const q = byName.get(org.name)
    if (!q) return
    const status = (q.status ?? 'active').toLowerCase()
    if (status === 'restricted' || status === 'retired') return
    if (exhausted(q)) return
    if (!hasCredential(org.name)) return
    const h5 = headroom(q.util5h)
    // Нет пятичасового окна у организации — судить о запасе нечем, в выбор не берём.
    if (h5 === null) return
    const h7 = headroom(q.util7d) ?? -1
    scored.push({ org, h5, h7, index })
  })

  if (scored.length === 0) return { org: null, reason: 'нет кандидата с замером и пропуском' }

  scored.sort((a, b) => (b.h5 - a.h5) || (b.h7 - a.h7) || (a.index - b.index))
  const best = scored[0]
  const key = (opts.stickyKey ?? '').trim()
  if (key) {
    const band = typeof opts.band === 'number' && Number.isFinite(opts.band) ? Math.max(0, opts.band) : DEFAULT_STICKY_BAND
    // Полоса — «почти равные»: лучший плюс все, кто отстал не больше чем на band. Внутри неё выбор
    // стабилен по ключу; из полосы организация выходит сама, когда реально отстала по запасу.
    const inBand = scored.filter((s) => best.h5 - s.h5 <= band)
    if (inBand.length > 1) {
      const chosen = inBand[stableHash(key) % inBand.length]
      return {
        org: chosen.org,
        reason: `запас 5ч=${chosen.h5.toFixed(2)} 7д=${chosen.h7 < 0 ? '?' : chosen.h7.toFixed(2)}; `
          + `липко к сессии внутри полосы ${inBand.length} из ${scored.length} (лучший ${best.h5.toFixed(2)})`,
      }
    }
  }
  return {
    org: best.org,
    reason: `запас 5ч=${best.h5.toFixed(2)} 7д=${best.h7 < 0 ? '?' : best.h7.toFixed(2)} среди ${scored.length}`,
  }
}

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
