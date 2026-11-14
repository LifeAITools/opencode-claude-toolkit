/**
 * anthropic-birth-placement — КАКОЙ организации Anthropic отдать НОВУЮ сессию.
 *
 * 🔴 СЛОВО ФАУНДЕРА 12.11.2026 (голос, тема 9090): «если оплачу ещё одну организацию —
 * балансировщик тот же, что у DeepSeek?»; «пятичасовое окно — первичный признак, но бывает
 * 5ч большое, а неделя почти исчерпана»; «динамика расходования, не просто у кого меньше»;
 * «ни в коем случае не менять на лету — сессия получила организацию и остаётся на ней».
 *
 * ДО ЭТОГО ФАЙЛА новая сессия получала организацию последнего входа Claude Code на машине
 * (`orgIdResolver.current()`), и второй оплаченный план не получал ни одной сессии.
 *
 * ЧТО ЗДЕСЬ, А ЧЕГО НЕТ:
 *  • Алгоритм — ТОТ ЖЕ `planPlacement`, что у дверей OpenDesign/Go (оба окна, скорость,
 *    маргинальная нагрузка, «связывает ли стена до сброса»). Своего не пишем.
 *  • Запас — `GET /api/oauth/usage` (без вызова модели; эталон Claude Code
 *    `services/api/usage.ts:55`), по каждой организации ЕЁ токеном.
 *  • Решение принимается ТОЛЬКО для сессии без пина. Пин, удержание и запрет миграции живут
 *    в `selectSessionToken` и не тронуты (рельса no-live-account-migration).
 *  • Сеть и время — параметрами: модуль чистый и проверяется без Anthropic.
 */
import { planPlacement, type PlacementOrg, type PlacementPlan, type PlacementWindow } from './placement.js'

/** Ответ `/api/oauth/usage` — только то, что читаем. */
export interface OauthUsageWindow { utilization: number | null; resets_at: string | null }
export interface OauthUsage { five_hour?: OauthUsageWindow | null; seven_day?: OauthUsageWindow | null }

/** Показание запаса одной организации. `windows` пуст — не измерено (НЕ ноль). */
export interface OrgUsageReading {
  orgId: string
  windows: PlacementWindow[]
  measuredAt: number
}

/** `utilization` приходит в процентах (замер 12.11: 30.0 при 30%). Перевод в долю 0..1. */
export function usageToWindows(u: OauthUsage | null | undefined): PlacementWindow[] {
  if (!u) return []
  const out: PlacementWindow[] = []
  const add = (name: string, w: OauthUsageWindow | null | undefined) => {
    if (!w || typeof w.utilization !== 'number' || !Number.isFinite(w.utilization)) return
    const resetAt = w.resets_at ? Date.parse(w.resets_at) : NaN
    out.push({ name, util: Math.max(0, w.utilization / 100), resetAt: Number.isFinite(resetAt) ? resetAt : null })
  }
  add('5h', u.five_hour)
  add('week', u.seven_day)
  return out
}

/**
 * Показание из ЗАГОЛОВКОВ настоящего ответа (`anthropic-ratelimit-unified-*`): доля уже 0..1,
 * сброс — epoch-секунды. Бесплатно и на каждом ходу, поэтому это основной источник; справочный
 * `/api/oauth/usage` — только для организаций без недавних ходов (у него свой, и, по замеру
 * 12.11.2026, общий на машину лимит частоты: retry-after дорос до 3300 с).
 */
export function headerSnapshotToWindows(snap: {
  utilization5h: number | null; utilization7d: number | null; resetAt: number | null; resetAt7d?: number | null
}): PlacementWindow[] {
  const out: PlacementWindow[] = []
  const ok = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
  if (ok(snap.utilization5h)) out.push({ name: '5h', util: Math.max(0, snap.utilization5h), resetAt: ok(snap.resetAt) ? snap.resetAt * 1000 : null })
  if (ok(snap.utilization7d)) out.push({ name: 'week', util: Math.max(0, snap.utilization7d), resetAt: ok(snap.resetAt7d) ? snap.resetAt7d * 1000 : null })
  return out
}

export interface BirthCandidate {
  orgId: string
  /** Организация ждёт нового входа (отозван refresh / запретила OAuth) — не кандидат. */
  needsRelogin: boolean
  /** Токен истёк и не обновился — не кандидат. */
  tokenAlive: boolean
}

export interface BirthPlacementInput {
  candidates: BirthCandidate[]
  readings: Map<string, OrgUsageReading>
  /** Живые пины по организациям — сколько сессий уже посажено. */
  pinsByOrg: Map<string, number>
  nowMs: number
  /** Показание старше этого — не измерение, а воспоминание. */
  maxReadingAgeMs: number
  seed: string
  /**
   * Веса ПИД (src/placement-control.ts) по организациям. Нет поля — выбор как раньше.
   * Вес 0 — тормоз: организация не кандидат. Больший вес — раньше в выборе (drain).
   */
  weights?: Map<string, { weight: number; mode: string; reason: string }>
}

export interface BirthPlacementResult {
  /** Выбранная организация или `null` — решать нечем, оставить прежний выбор. */
  orgId: string | null
  plan: PlacementPlan | null
  /** Почему `null`: одна организация, никто не измерен, все исключены. */
  skipped: string | null
  /** Что решил регулятор (если участвовал) — для журнала. */
  control?: string
}

/**
 * Решение для НОВОЙ сессии. `null` в `orgId` — сознательное «не знаю», вызывающий оставляет
 * прежнее поведение. Кандидат без свежего измерения в план не идёт: неизмеренная организация
 * со `score = Infinity` встала бы ПЕРВОЙ, а «нечего сказать» не должно выигрывать.
 */
export function chooseBirthOrg(input: BirthPlacementInput): BirthPlacementResult {
  const eligible = input.candidates.filter(c => c.tokenAlive && !c.needsRelogin)
  if (eligible.length < 2) {
    return { orgId: null, plan: null, skipped: `живых организаций ${eligible.length} — выбирать не из чего` }
  }
  const orgs: PlacementOrg[] = []
  for (const c of eligible) {
    const r = input.readings.get(c.orgId)
    if (!r || r.windows.length === 0 || input.nowMs - r.measuredAt > input.maxReadingAgeMs) continue
    orgs.push({ name: c.orgId, windows: r.windows, activeAgents: input.pinsByOrg.get(c.orgId) ?? 0 })
  }
  // 🔴 СРАВНИВАТЬ ОДНУ С НИЧЕМ НЕЛЬЗЯ: если свежо измерена одна организация из двух живых,
  // «выбор» всегда отдавал бы её — даже на грани стены, — а неизмеренную морил бы голодом.
  // Меньше двух измеренных — прежнее поведение, и это названо.
  if (orgs.length < 2) {
    return { orgId: null, plan: null, skipped: `свежо измерено ${orgs.length} из ${eligible.length} — сравнивать не с чем` }
  }
  const plan = planPlacement(orgs, input.nowMs, input.seed)
  if (!plan.org) return { orgId: null, plan, skipped: plan.reason }
  if (!input.weights || input.weights.size === 0) return { orgId: plan.org.name, plan, skipped: null }

  // ── Регулятор поверх ранжира. Тормоз (вес 0) исключает организацию; из оставшихся годных
  // (не walled) первой идёт та, у кого БОЛЬШЕ вес — drain-организация, пока отстаёт от
  // траектории, и ровно пропорционально весу (детерминированно по seed), чтобы приток на неё
  // был долей, а не «всё или ничего». Равные веса — порядок planPlacement.
  // 🔴 ТОРМОЗ ОТСТУПАЕТ ТОЛЬКО НА РАВНЫЙ ИЛИ ЛУЧШИЙ (14.11.2026, TG 85936/85941). Регулятор ведёт
  // одно 5ч-окно; ранжир planPlacement видит ОБА окна. Затормозив relishev (5ч 0.77, неделя 0.56),
  // регулятор отдал все новые сессии oeliseva с НЕДЕЛЕЙ 0.99 — ранжир ставил её ниже. Поэтому
  // заторможенная организация выбывает, только если выше неё по ранжиру остаётся незаторможенная:
  // тогда отступ — на лучшую. Иначе тормоз гнал бы в стену ровно то, от чего он защищает.
  const live = plan.ranked.filter(a => a.verdict !== 'walled')
  const brakedOut = (a: typeof live[number]) => (input.weights!.get(a.name)?.weight ?? 1) <= 0
  const firstFree = live.findIndex(a => !brakedOut(a))
  const usable = live.filter((a, i) => !brakedOut(a) || (firstFree >= 0 && i < firstFree))
  const ctlText = [...input.weights].map(([o, w]) => `${o.slice(0, 8)} ${w.mode} w=${w.weight.toFixed(2)}`).join('; ')
  if (usable.length === 0) return { orgId: null, plan, skipped: 'регулятор затормозил все организации — прежний выбор', control: ctlText }
  const drainers = usable.filter(a => input.weights!.get(a.name)?.mode === 'drain' && (input.weights!.get(a.name)?.weight ?? 0) > 0)
  if (drainers.length > 0) {
    const d = drainers[0]!
    const w = input.weights.get(d.name)!.weight
    // Доля притока = вес: псевдослучайно, но повторяемо по seed (номер сессии).
    let h = 0x811c9dc5
    for (let i = 0; i < input.seed.length; i++) { h ^= input.seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
    if ((h >>> 0) / 2 ** 32 < w) return { orgId: d.name, plan, skipped: null, control: ctlText }
    const other = usable.find(a => a.name !== d.name)
    if (other) return { orgId: other.name, plan, skipped: null, control: ctlText }
    return { orgId: d.name, plan, skipped: null, control: ctlText }
  }
  return { orgId: usable[0]!.name, plan, skipped: null, control: ctlText }
}
