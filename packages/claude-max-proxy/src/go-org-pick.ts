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
export function pickOrgByHeadroom(
  orgs: GoOrg[],
  quotas: OrgQuotaView[],
  hasCredential: (name: string) => boolean,
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
  try {
    const doc = JSON.parse(readFileSync(path, 'utf8')) as { orgs?: Record<string, { access_token?: unknown }> }
    const names = Object.entries(doc.orgs ?? {})
      .filter(([, v]) => v && typeof v.access_token === 'string' && v.access_token !== '')
      .map(([k]) => k)
    return new Set(names)
  } catch {
    return new Set()
  }
}
