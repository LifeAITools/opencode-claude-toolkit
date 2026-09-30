/**
 * ГДЕ СТАВИТЬ СТЕНУ ЗАПАСА — по времени до сброса, а не одним числом.
 *
 * ЗАЧЕМ СТЕНА. Сторож запаса (proxy-client, `QUOTA_GUARD_BLOCKED`) придерживает настоящие ходы у
 * потолка пятичасового окна, чтобы до сброса дожил ПРОГРЕВ: дойди счётчик до 100 %, Anthropic
 * откажет и ему, кэши всех сессий аккаунта умрут по часам, и после сброса каждая купит контекст
 * заново. Значит, стена нужна ровно там, где остатка окна хватает прогреву до сброса — не раньше
 * (зря стоит работа) и не позже (гибнут кэши).
 *
 * ПОЧЕМУ НЕ ОДНО ЧИСЛО. Фаундер 30.09 ~16:15Z: «почему она так жёстко отрубает? Жёстко прокси может
 * отрубать когда условно 98-99%, чтобы оставить для keep alive». Замер того же дня по аккаунту
 * 02b4bfd1 (движение его собственного счётчика, не пересчёт в цены — рельса ka-subscription-not-api):
 * стена 0.95 встала в 16:39:25Z, сброс в 17:40Z; за этот час прогрев 44 сессий — 266 выстрелов,
 * 87 483 344 токена чтения кэша, 0 записи, настоящих ходов 4 — и счётчик 0.95 → 0.97. То есть прогрев
 * ест ~2 пункта в час. Стена 0.98 в тот день довела бы прогрев до края; стена за три часа до сброса
 * потребовала бы ~6 пунктов, и уже 0.95 было бы мало. Ответ зависит от ВРЕМЕНИ ДО СБРОСА.
 *
 * ЛИНИЯ = 1 − (расход прогрева в час × часы до сброса) − запас на отставание счётчика,
 * зажатая в [нижняя, верхняя]. Нижняя — прежний порог (по умолчанию 0.95): строже, чем было, стена не
 * становится никогда — это решение о смене поведения флота принимается отдельно, а не здесь. Не
 * измерен расход — линия равна нижней, то есть ровно прежнему поведению.
 *
 * РАСХОД ПРОГРЕВА меряется живьём по его ответам за последний час: чтение, запись и выхлоп, каждый
 * по своему курсу «токенов на пункт окна» — курсы замерены движением счётчика (регрессия 11.09 для
 * записи и выхлопа, опыт у стены 30.09 для чтения) и лежат в keepalive.json → quotaGuard.
 */

export interface KaSpendSample {
  atMs: number
  read: number
  write: number
  output: number
}

export interface SpendRates {
  /** Токенов чтения кэша на один пункт окна (0.01). Замер 30.09: ~44 млн. */
  readTokensPerPoint: number
  /** Токенов записи кэша на пункт. Замер 11.09: 493 672. */
  writeTokensPerPoint: number
  /** Токенов выхлопа на пункт. Замер 11.09: 75 278. */
  outputTokensPerPoint: number
}

const HOUR_MS = 3_600_000

/**
 * Расход прогрева по аккаунтам за скользящий час. Пока наблюдение короче `minCoverageMs`, расход
 * не называется: полчаса — это уже с десяток выстрелов по каждой тёплой сессии, а меньше легко
 * поймать тихую минуту и занизить.
 */
export class KaSpendMeter {
  private readonly samples = new Map<string, KaSpendSample[]>()
  private readonly firstSeenAt = new Map<string, number>()

  constructor(private readonly minCoverageMs = 30 * 60_000) {}

  record(orgId: string | null | undefined, s: KaSpendSample): void {
    if (!orgId) return
    let list = this.samples.get(orgId)
    if (!list) { list = []; this.samples.set(orgId, list); this.firstSeenAt.set(orgId, s.atMs) }
    list.push(s)
    this.prune(list, s.atMs)
  }

  /** Расход прогрева в долях окна за час (0.02 = два пункта); null — не измерено. */
  utilPerHour(orgId: string | null | undefined, nowMs: number, rates: SpendRates): number | null {
    if (!orgId) return null
    const first = this.firstSeenAt.get(orgId)
    if (first === undefined || nowMs - first < this.minCoverageMs) return null
    const list = this.samples.get(orgId) ?? []
    this.prune(list, nowMs)
    const span = Math.min(HOUR_MS, nowMs - first)
    let points = 0
    for (const s of list) {
      points += s.read / rates.readTokensPerPoint
        + s.write / rates.writeTokensPerPoint
        + s.output / rates.outputTokensPerPoint
    }
    return (points * 0.01) * (HOUR_MS / span)
  }

  private prune(list: KaSpendSample[], nowMs: number): void {
    const cutoff = nowMs - HOUR_MS
    let i = 0
    while (i < list.length && list[i]!.atMs < cutoff) i++
    if (i > 0) list.splice(0, i)
  }
}

export interface StopLineInput {
  /** Нижняя граница — прежний порог (`blockAtUtil5h`). */
  floor: number
  /** Верхняя граница (`maxBlockAtUtil5h`). */
  ceiling: number
  /** Запас на отставание счётчика на один ход (`lagMarginUtil`). */
  lagMargin: number
  /** Мс до сброса окна; null — неизвестно. */
  resetInMs: number | null
  /** Расход прогрева в долях окна за час; null — не измерено. */
  kaUtilPerHour: number | null
}

export interface StopLine {
  line: number
  /** Откуда взялась линия — для журнала и отказа: человек видит, почему стена именно тут. */
  basis: 'measured' | 'floor:unmeasured' | 'floor:clamped' | 'ceiling:clamped'
  /** Сколько окна прогрев съест до сброса (доля), если измерено. */
  kaNeedToReset: number | null
}

export function quotaStopLine(i: StopLineInput): StopLine {
  if (i.ceiling <= i.floor || i.resetInMs === null || i.kaUtilPerHour === null) {
    return { line: i.floor, basis: 'floor:unmeasured', kaNeedToReset: null }
  }
  const need = i.kaUtilPerHour * (Math.max(0, i.resetInMs) / HOUR_MS)
  const raw = 1 - need - i.lagMargin
  if (raw <= i.floor) return { line: i.floor, basis: 'floor:clamped', kaNeedToReset: need }
  if (raw >= i.ceiling) return { line: i.ceiling, basis: 'ceiling:clamped', kaNeedToReset: need }
  // Без округления: счётчик отдаёт сотые, и сравнение `util5h >= line` само встаёт на первую
  // сотую не ниже линии. Отставание счётчика уже покрыто lagMargin — округлять вниз значило бы
  // отнять у флота второй пункт.
  return { line: raw, basis: 'measured', kaNeedToReset: need }
}
