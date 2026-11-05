/**
 * placement — КУДА САЖАТЬ НОВОГО АГЕНТА, с учётом динамики, а не только запаса.
 *
 * 🔴 СЛОВО ФАУНДЕРА 05.11.2026, дословно по смыслу: «не просто всех сажало там, где меньше,
 * потому что если все сажаются там, где меньше, они разгоняются и убивают себя об стену.
 * Надо, чтобы она понимала реальную текущую загрузку или некую производную… если на
 * организацию уже мало, то лучше класть меньше агентов» И ещё: «пятичасовая квота
 * расходуется быстрее, семидневная медленнее — это тоже надо учитывать».
 *
 * ЧТО УЖЕ БЫЛО И ЧЕГО НЕ ХВАТАЛО (проверено по коду 05.11.2026):
 *  • `pickOrgByTimeToWall` (go-org-pick.ts) УЖЕ считает динамику: скорость = util / прошедшее
 *    время окна, время до стены = (1−util)/скорость, и окно «связывает» только если стена
 *    наступит РАНЬШЕ его сброса. То есть выбор «по запасу» давно не голый.
 *  • НЕ ХВАТАЛО ДВУХ ВЕЩЕЙ: (1) МАРГИНАЛЬНОЙ НАГРУЗКИ — посадка ещё одного агента добавляет
 *    расход, и на организации с 60 сессиями это другой риск, чем на пустой; (2) единого
 *    ответа «куда посадить», который можно показать человеку. Первое и есть цель этого файла.
 *
 * МОДЕЛЬ (пропорциональная, без выдуманных коэффициентов):
 *   baseRate   = util / elapsed                      — средняя скорость окна (доля/час)
 *   afterRate  = baseRate × (n + 1) / n              — та же скорость на n+1 агентах
 *                                                    (n = 0 → берём baseRate как есть)
 *   ttwAfter   = (1 − util) / afterRate              — часы до стены ПОСЛЕ посадки
 *   окно связывает, только если ttwAfter < остаток до сброса
 *   оценка орг = min(ttwAfter) по связывающим окнам; нет связывающих → Infinity
 *
 * ЧЕСТНАЯ ГРАНИЦА МОДЕЛИ: это не PID с обратной связью и не прогноз на секунды. Скорость
 * берётся СРЕДНЯЯ С НАЧАЛА ОКНА (другой у нас нет без отдельного сэмплера), а вклад агента
 * считается пропорциональным. Поэтому решение — «куда лучше посадить», а не «сколько
 * миллисекунд осталось». Когда появится сэмплер расхода (шаг S7), сюда встанет настоящая
 * производная без смены интерфейса.
 */

export interface PlacementWindow {
  /** `5h` | `week` | `month` — длина берётся из WINDOW_HOURS. */
  name: string
  /** Доля использованного 0..1. `null` — не измерено (это НЕ ноль). */
  util: number | null
  /** Когда окно сбросится (мс эпохи). `null` — неизвестно. */
  resetAt: number | null
}

export interface PlacementOrg {
  name: string
  windows: PlacementWindow[]
  /** Сколько живых сессий уже посажено на эту организацию. */
  activeAgents: number
  /** Организация запрещена/исчерпана/без входа — не кандидат (причина в `blockedReason`). */
  blockedReason?: string | null
}

export interface PlacementAssessment {
  name: string
  /** Часы до стены ПОСЛЕ посадки ещё одного агента. `Infinity` — ни одно окно не связывает. */
  score: number
  /** Часы до стены без учёта посадки (то, что видно и без этой модели). */
  scoreBefore: number
  /**
   * ХУДШИЙ остаток по измеренным окнам (1 − самая занятая доля) — второй ключ сортировки.
   * 🔴 Не среднее: среднее по трём окнам, где одно на 100%, даёт «67%» и читается как
   * «запас есть» — ровно тот обман, из-за которого правило и писалось.
   */
  worstHeadroom: number | null
  /** Сколько окон вообще измерено. 0 — об организации не известно ничего. */
  measuredCount: number
  activeAgents: number
  /** Какое окно связывает (имя) и сколько ему ещё жить до сброса. */
  binding: Array<{ window: string; ttwHours: number; resetsInHours: number; usedFraction: number }>
  /**
   * `place` — измерено и стена далеко; `unknown` — не измерено ни одно окно (это НЕ «хорошо»);
   * `avoid` — измерено, но до стены меньше NEAR_WALL_HOURS; `walled` — упёрлась/запрещена.
   */
  verdict: 'place' | 'unknown' | 'avoid' | 'walled'
  /** Человеческая причина — одной строкой. */
  reason: string
}

export interface PlacementPlan {
  /** Куда сажать: `null` — сажать некуда, и это НАЗВАНО, а не «нет данных». */
  org: PlacementAssessment | null
  ranked: PlacementAssessment[]
  /** Почему выбран этот — одной строкой. */
  reason: string
}

const WINDOW_HOURS: Record<string, number> = { '5h': 5, week: 7 * 24, month: 30 * 24 }
/** Окно короче 15 минут не даёт скорости: слишком мало прошло, делить не на что. */
const MIN_ELAPSED_HOURS = 0.25
/** Сколько часов до стены считается «на грани»: такая организация не первый выбор. */
export const NEAR_WALL_HOURS = 2

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** FNV-1a: стабильный тай-брейк между равными, чтобы порядок не прыгал от вызова к вызову. */
function stableHash(value: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Оценка одной организации. `activeAgents` — уже посаженные сессии: их расход УЖЕ внутри
 * util, поэтому доля скорости на одного агента = baseRate / n, а посадка n+1-го даёт
 * baseRate × (n+1)/n. При n = 0 делить не на что — берём скорость как есть (консервативно:
 * не делаем вид, что пустая организация бесплатна).
 */
export function assessOrg(org: PlacementOrg, nowMs: number): PlacementAssessment {
  const blocked = org.blockedReason ?? null
  const agents = Math.max(0, Math.floor(org.activeAgents))
  const measured = org.windows.filter(w => finite(w.util) && w.resetAt !== null)
  const worstHeadroom = measured.length
    ? 1 - Math.max(...measured.map(w => w.util as number))
    : null

  const base: PlacementAssessment = {
    name: org.name,
    score: blocked ? 0 : Infinity,
    scoreBefore: blocked ? 0 : Infinity,
    worstHeadroom,
    measuredCount: measured.length,
    activeAgents: agents,
    binding: [],
    verdict: blocked ? 'walled' : measured.length === 0 ? 'unknown' : 'place',
    reason: blocked ?? (measured.length === 0 ? 'ни одно окно не измерено — сказать нечего' : ''),
  }
  if (blocked) return base

  // 🔴 НЕЧЕГО ИЗМЕРЯТЬ — И ЭТО НАЗВАННЫЙ ВЕРДИКТ, А НЕ «ничего не связывает».
  // У такой организации score был бы Infinity и она встала бы ПЕРВОЙ в сортировке.
  if (measured.length === 0) {
    return { ...base, score: 0, scoreBefore: 0, verdict: 'unknown' }
  }

  const walled = measured.find(w => (w.util as number) >= 1)
  if (walled) {
    return {
      ...base, score: 0, scoreBefore: 0, verdict: 'walled',
      reason: `окно ${walled.name} исчерпано (${(100 * (walled.util as number)).toFixed(0)}%)`,
    }
  }

  let bestAfter: number | null = null
  let bestBefore: number | null = null
  const binding: PlacementAssessment['binding'] = []

  for (const w of measured) {
    const len = WINDOW_HOURS[w.name]
    if (!len) continue
    const util = w.util as number
    const remainingH = Math.max(0, ((w.resetAt as number) - nowMs) / 3_600_000)
    const elapsed = len - remainingH
    if (elapsed < MIN_ELAPSED_HOURS) continue

    const baseRate = util / elapsed
    const rateAfter = agents > 0 ? baseRate * (agents + 1) / agents : baseRate
    const ttwBefore = baseRate <= 1e-9 ? Infinity : Math.max(0, (1 - util) / baseRate)
    const ttwAfter = rateAfter <= 1e-9 ? Infinity : Math.max(0, (1 - util) / rateAfter)

    if (bestBefore === null || ttwBefore < bestBefore) bestBefore = ttwBefore
    // Связывает только если стена наступит РАНЬШЕ сброса — иначе окно успеет обнулиться.
    if (ttwAfter < remainingH) {
      binding.push({ window: w.name, ttwHours: ttwAfter, resetsInHours: remainingH, usedFraction: util })
      if (bestAfter === null || ttwAfter < bestAfter) bestAfter = ttwAfter
    }
  }

  const score = bestAfter === null ? Infinity : bestAfter
  const scoreBefore = bestBefore === null ? Infinity : bestBefore
  const bindingText = binding.length
    ? `связывает ${binding.map(b => `${b.window} (${fmt(b.ttwHours)} после посадки, сброс через ${fmt(b.resetsInHours)})`).join(', ')}`
    : 'ни одно окно не связывает — успеет сброситься'
  const verdict: PlacementAssessment['verdict'] = score === Infinity ? 'place' : score < NEAR_WALL_HOURS ? 'avoid' : 'place'
  const headText = worstHeadroom === null ? 'не измерен' : `${(100 * worstHeadroom).toFixed(0)}%`

  return {
    ...base,
    score,
    scoreBefore,
    binding,
    verdict,
    reason: `${bindingText}; агентов ${agents}; худший запас ${headText}`,
  }
}

function fmt(h: number): string {
  if (!Number.isFinite(h)) return '∞'
  if (h < 1) return `${Math.round(h * 60)}м`
  return `${h.toFixed(1)}ч`
}

/**
 * Куда посадить нового агента.
 *
 * Порядок: сначала вердикт (`walled` никогда, `avoid` только если сажать больше некуда),
 * затем оценка ПОСЛЕ посадки (больше — лучше), затем средний запас, затем стабильный хеш.
 * Хеш считается по `seed` (обычно номер сессии), чтобы равные не перекидывались.
 */
export function planPlacement(orgs: PlacementOrg[], nowMs: number, seed = ''): PlacementPlan {
  const ranked = orgs.map(o => assessOrg(o, nowMs)).sort((a, b) => {
    // 🔴 НЕИЗМЕРЕННОЕ НЕ ВЫШЕ ИЗМЕРЕННОГО. У организации без окон `score = Infinity`
    // («ничего не связывает»), и сортировка по score поставила бы её ПЕРВОЙ — то есть
    // «нечего сказать» превратилось бы в «лучший выбор». Ровно этот класс мы и ловим.
    const rank = (v: PlacementAssessment['verdict']) =>
      v === 'place' ? 0 : v === 'unknown' ? 1 : v === 'avoid' ? 2 : 3
    if (rank(a.verdict) !== rank(b.verdict)) return rank(a.verdict) - rank(b.verdict)
    if (a.score !== b.score) return a.score > b.score ? -1 : 1
    const ah = a.worstHeadroom ?? -1
    const bh = b.worstHeadroom ?? -1
    if (ah !== bh) return bh - ah
    return stableHash(`${seed}|${a.name}`) - stableHash(`${seed}|${b.name}`)
  })

  const chosen = ranked.find(r => r.verdict !== 'walled') ?? null
  if (!chosen) return { org: null, ranked, reason: 'все организации упёрлись или запрещены — сажать некуда' }
  if (chosen.verdict === 'unknown') {
    return { org: chosen, ranked, reason: `не измерено ни у одной: ${chosen.name} — ${chosen.reason}` }
  }
  if (chosen.verdict === 'avoid') {
    return { org: chosen, ranked, reason: `свободных нет, берём ближайшую к стене: ${chosen.name} — ${chosen.reason}` }
  }
  return { org: chosen, ranked, reason: `${chosen.name}: ${chosen.reason}` }
}

/** Собирает вход анализатора из отчёта квоты и карты пинов. Чистая функция: удобно проверять. */
export function placementInputs(
  quotaOrgs: Array<{ name: string; status?: string | null; windows?: Array<{ window: string; util: number | null; resetAt: number | null }>; util5h?: number | null; util7d?: number | null; utilMonth?: number | null }>,
  pins: Record<string, { org: string; at?: number }>,
  opts: { nowMs: number; pinTtlMs?: number } = { nowMs: Date.now() },
): PlacementOrg[] {
  // Считаем только ЖИВЫЕ посадки: просроченный пин — это уже не нагрузка, и держать его
  // в знаменателе значило бы вечно считать организацию занятой.
  const ttl = opts.pinTtlMs ?? 12 * 60 * 60 * 1000
  const counts = new Map<string, number>()
  for (const p of Object.values(pins)) {
    if (typeof p.at === 'number' && opts.nowMs - p.at > ttl) continue
    counts.set(p.org, (counts.get(p.org) ?? 0) + 1)
  }
  return quotaOrgs.map(o => {
    const windows: PlacementWindow[] = Array.isArray(o.windows) && o.windows.length
      ? o.windows.map(w => ({ name: w.window, util: w.util, resetAt: w.resetAt }))
      : [
          { name: '5h', util: o.util5h ?? null, resetAt: null },
          { name: 'week', util: o.util7d ?? null, resetAt: null },
          { name: 'month', util: o.utilMonth ?? null, resetAt: null },
        ]
    const status = (o.status ?? 'active').toLowerCase()
    const blockedReason = status === 'exhausted' ? 'организация помечена exhausted'
      : status === 'absent' ? 'организация без подписки'
        : status === 'unreadable' ? 'квоту измерить не удалось'
          : null
    return { name: o.name, windows, activeAgents: counts.get(o.name) ?? 0, blockedReason }
  })
}
