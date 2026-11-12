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
}

export interface BirthPlacementResult {
  /** Выбранная организация или `null` — решать нечем, оставить прежний выбор. */
  orgId: string | null
  plan: PlacementPlan | null
  /** Почему `null`: одна организация, никто не измерен, все исключены. */
  skipped: string | null
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
  return { orgId: plan.org.name, plan, skipped: null }
}
