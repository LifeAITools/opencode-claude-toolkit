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
  /**
   * Поставщик УЖЕ отказал этой организации (429 с retry-after): у окна может стоять 0.99, а
   * приходить будут отказы до самого сброса. Это знание о стене, а не оценка запаса —
   * поэтому оно запрещает посадку новой сессии, даже когда `util < 1`.
   */
  exhausted?: boolean
}

/**
 * 🔴 «ПОЧТИ ИСЧЕРПАНО» — ЭТО ТОЖЕ СТЕНА. У недельного окна 0.99 и сброс через 30 часов
 * поставщик отвечает 429 задолго до 1.00 (замер 14.11.2026: oeliseva при util7d 0.99 выдавала
 * 429 с retry-after 110 787 с). Для выбора новой сессии это не «лучше, чем у соседа», а
 * «сажать некуда». Порог назван здесь, а не размазан по коду.
 */
const WEEK_EFFECTIVELY_WALLED = 0.98
/** Сброс ближе этого — стена снимается сама, и запрет был бы ложным. */
const WALL_CLEARS_SOON_H = 1

/** Окно исчерпано СЕЙЧАС: либо поставщик отказал, либо окно на 1.00, либо неделя у порога. */
export function windowIsWalled(reading: OrgUsageReading | undefined, nowMs: number): boolean {
  if (!reading) return false
  if (reading.exhausted === true) return true
  const resetInH = (w: PlacementWindow): number => (typeof w.resetAt === 'number' ? (w.resetAt - nowMs) / 3_600_000 : Infinity)
  return reading.windows.some(w => {
    if (typeof w.util !== 'number') return false
    const soon = resetInH(w) <= WALL_CLEARS_SOON_H
    if (w.util >= 1 && !soon) return true
    if (w.name === 'week' && w.util >= WEEK_EFFECTIVELY_WALLED && resetInH(w) > WALL_CLEARS_SOON_H) return true
    return false
  })
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

/**
 * 🔴 ЗАПАСНОЙ ВЫБОР, КОГДА СРАВНИВАТЬ НЕ С ЧЕМ (14.11.2026, TG 85966/85967).
 *
 * `chooseBirthOrg` честно возвращает `null`, когда свежих измерений меньше двух, и вызывающий
 * в этом случае оставляет сессию на АКТИВНОЙ организации — той, где стоял предыдущий вход.
 * Замер 11:13Z: у relishev измерению было ровно 90 мин (граница свежести), у oeliseva неделя
 * 100% — выбор вернул `null`, и новая сессия села прямо в стену: 38 отказов 429 за час.
 *
 * ЗДЕСЬ ВОЗРАСТ ЗАМЕРА РАБОТАЕТ ТОЛЬКО В СТОРОНУ ЗАПРЕТА. Старое показание «окно исчерпано»
 * достаточно, чтобы НЕ сажать новую сессию, и недостаточно, чтобы выбрать организацию по
 * запасу: выбираем не «лучшую», а «не худшую из тех, про кого известно, что они не в стене».
 * Окно, чей сброс уже прошёл, исчерпанным не считается — замер устарел вместе со стеной.
 *
 * `null` — защищать нечего (активная не в стене) или некуда уходить (все живые в стене);
 * в обоих случаях вызывающий остаётся на прежнем поведении, и это названо причиной.
 */
export function chooseNonWalledFallback(input: {
  candidates: BirthCandidate[]
  readings: Map<string, OrgUsageReading>
  /** Организация, на которой стоял предыдущий вход: её вызывающий оставит при `null`. */
  activeOrg: string | null
  nowMs: number
  seed: string
}): { orgId: string | null; reason: string } {
  const { candidates, readings, activeOrg, nowMs } = input
  if (!activeOrg) return { orgId: null, reason: 'активная организация неизвестна — прежнее поведение' }
  const walledNow = (orgId: string): boolean => windowIsWalled(readings.get(orgId), nowMs)
  if (!walledNow(activeOrg)) {
    return { orgId: null, reason: `активная ${activeOrg.slice(0, 8)} не в стене — прежнее поведение` }
  }
  const free = candidates.filter(c => c.orgId !== activeOrg && c.tokenAlive && !c.needsRelogin && !walledNow(c.orgId))
  if (free.length === 0) {
    return { orgId: null, reason: 'все живые организации в стене или запрещены — остаёмся на активной' }
  }
  // Между известными и неизмеренными: известный запас решает первым, чтобы «нечего сказать»
  // не превратилось в «лучший выбор» (тот же принцип, что в planPlacement).
  const known = free.filter(c => (readings.get(c.orgId)?.windows.length ?? 0) > 0)
  const pool = known.length > 0 ? known : free
  const headroom = (orgId: string): number => {
    const r = readings.get(orgId)
    if (!r || r.windows.length === 0) return Infinity
    return Math.min(...r.windows.map(w => 1 - (typeof w.util === 'number' ? w.util : 1)))
  }
  const best = Math.max(...pool.map(c => headroom(c.orgId)))
  const tied = pool.filter(c => headroom(c.orgId) === best)
  // Повторяемо по номеру сессии: одновременные рождения не сходятся в одну организацию.
  let h = 0x811c9dc5
  for (let i = 0; i < input.seed.length; i++) { h ^= input.seed.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  const pick = tied[(h >>> 0) % tied.length]!
  return {
    orgId: pick.orgId,
    reason: `активная ${activeOrg.slice(0, 8)} в стене — новая сессия уходит на ${pick.orgId.slice(0, 8)}` +
      (Number.isFinite(best) ? ` (худший запас ${(100 * best).toFixed(0)}%)` : ' (запас не измерен, но не в стене)'),
  }
}
