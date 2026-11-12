/**
 * placement-pid — ПИД-регулятор притока НОВЫХ сессий на организацию.
 *
 * 🔴 СЛОВО ФАУНДЕРА 12.11.2026 (голос, тема 9090): «сделаем полноценный ПИД — если
 * компонента не нужна, просто не пользуемся; откатать на наших логах, откалибровать;
 * автокалибровка в моменте, чтобы не шла в разнос»; «ручка, которая додавит одну
 * организацию аккуратно — к 99%, но чтобы все разом в стену не упёрлись».
 * План: PRPs/placement-pid/plan.md.
 *
 * ПОСТАНОВКА. Объект — расход окна организации (util, 0..1). Он инерционный: посаженная
 * сессия тратит часами, и ПЕРЕСАДИТЬ её нельзя (рельса no-live-account-migration). Значит
 * регулятор управляет ТОЛЬКО притоком — весом организации при выборе для новой сессии, — а
 * уже посаженная нагрузка для него неуправляемое возмущение, которое он ПРОГНОЗИРУЕТ.
 *
 * УСТАВКА — ТРАЕКТОРИЯ, а не точка: r(t) = util₀ + (target − util₀)·(t − t₀)/(T − t₀).
 * Точка «99% сейчас» дала бы максимальный вес на старте и разгон всех сессий разом; линия
 * задаёт темп, с которым к цели подходят.
 *
 *   e  = r(t) − util(t)                       отставание от линии (+ — недобор)
 *   P  = Kp·e
 *   I  = Ki·∫e dt                             систематический недобор (вялые сессии)
 *   D  = −Kd·d(util)/dt                       по ИЗМЕРЕНИЮ, не по ошибке: смена уставки
 *                                             не даёт «удара»; гасит разгон расхода
 *   u  = P + I + D + Kff·(dr/dt)              упреждение по наклону линии
 *   w  = clamp(u, 0, wMax), со скоростью изменения ≤ slew
 *
 * ЗАЩИТЫ ОТ РАЗНОСА (все обязательны):
 *  1. ТОРМОЗ ПО ИНЕРЦИИ — главное против «все разом в стену». Прогноз util к сроку от уже
 *     посаженной нагрузки: util + rate·(T − t). Если он ≥ target − margin — вес 0, что бы
 *     ни говорил ПИД: посаженные и так дотянут. Объект с запаздыванием управляется
 *     предсказанием, а не реакцией.
 *  2. ANTI-WINDUP: интеграл не копится, когда выход насыщен в сторону ошибки и когда
 *     притока нет (управлять нечем); и ограничен по модулю.
 *  3. Ограничение выхода [0, wMax] и скорости его изменения.
 *  4. Фильтр производной (EMA): замеры ступенчатые, сырая производная — шум.
 *  5. АДАПТАЦИЯ ТОЛЬКО В ГРАНИЦАХ: усиление объекта K̂ (Δutil на сессие-час) оценивается
 *     онлайн с забыванием и масштабирует Kp/Ki как K_cal/K̂, но множитель зажат в
 *     [adaptMin, adaptMax]; при слишком малом числе наблюдений — множитель 1.
 *  Последняя линия — сторож квоты прокси (blockAtUtil5h); этот модуль его не заменяет.
 *
 * Модуль чистый: время и замеры — параметрами, состояние — объект, который хранит вызывающий.
 */

export interface PidGains {
  kp: number
  ki: number
  kd: number
  /** Упреждение по наклону траектории (доля/час → вес). 0 — выключено. */
  kff: number
}

export interface PidLimits {
  /** Верхняя граница веса. */
  wMax: number
  /** Максимальное изменение веса за час. */
  slewPerHour: number
  /** |∫e| не больше этого (в долях·час). */
  integralMax: number
  /** Запас тормоза по инерции: прогноз ≥ target − margin ⇒ вес 0. */
  brakeMargin: number
  /** Постоянная фильтра производной, часы. */
  derivTauHours: number
}

export interface PidAdaptation {
  enabled: boolean
  /**
   * Калиброванное усиление объекта ПО КЛАССУ: Δutil на сессие-час для `провайдер/модель`.
   * Класс без калибровки берёт `kDefault` — и это названо в журнале, а не молча.
   */
  kCalByClass: Record<string, number>
  kDefault: number
  /**
   * Фоновый расход окна, не объяснённый ни одной отслеживаемой сессией (доля/час).
   * Замер 12.11.2026 на истории (research/placement-pid-plant-identification-2026-11.md):
   * ≈0.020/ч на организацию (p10–p90 0.018–0.023). Отдельный вход, а не часть K_class:
   * вложенный в коэффициент сессии, он считался бы дважды.
   */
  driftPerHour: number
  /** Коэффициент забывания оценки (0..1, ближе к 1 — медленнее). */
  forget: number
  adaptMin: number
  adaptMax: number
  /** Сколько наблюдений нужно, прежде чем доверять оценке. */
  minObservations: number
}

export interface DrainTarget {
  /** Цель по доле окна (0..1), напр. 0.99. */
  targetUtil: number
  /** Срок (мс эпохи). */
  deadlineMs: number
}

export interface PidState {
  /** Начало траектории — фиксируется при первом шаге с этой целью. */
  t0Ms: number | null
  util0: number | null
  /** Для какой цели построена траектория: смена цели — новая линия. */
  targetKey: string | null
  integral: number
  derivFiltered: number
  lastUtil: number | null
  lastMs: number | null
  lastOutput: number
  /**
   * Онлайн-оценка ОБЩЕГО множителя θ: Δutil/час ≈ θ·L, где L = Σ K_cal[класс]·сессии —
   * нагрузка в калиброванных единицах. θ = 1 — калибровка верна; θ = 2 — сейчас каждая
   * сессия жжёт вдвое быстрее, чем на истории. Одна оценка на организацию, а не на класс:
   * разделить вклад классов по одному util нельзя (уравнение одно), а классы уже разведены
   * калиброванными коэффициентами.
   */
  sxy: number
  sxx: number
  observations: number
}

export function newPidState(): PidState {
  return {
    t0Ms: null, util0: null, targetKey: null, integral: 0, derivFiltered: 0,
    lastUtil: null, lastMs: null, lastOutput: 0, sxy: 0, sxx: 0, observations: 0,
  }
}

export interface PidInput {
  nowMs: number
  /** Текущая доля окна (0..1). `null` — не измерено: регулятор ничего не меняет. */
  util: number | null
  /**
   * Уже посаженная нагрузка ПО КЛАССАМ: ключ — `провайдер/модель` (напр. `anthropic/opus`,
   * `anthropic/haiku`, `open-design/deepseek`), значение — число живых сессий этого класса.
   * 🔴 Слово фаундера 12.11: «сессии делить по провайдеру и модели — у них различные
   * коэффициенты». Одна сессия Opus двигает окно сильнее сессии Haiku, поэтому нагрузка —
   * взвешенная сумма, а не счёт сессий.
   */
  sessionsByClass: Record<string, number>
  /** Был ли за прошедший шаг приток новых сессий куда-либо (есть ли чем управлять). */
  inflowSinceLast: boolean
  target: DrainTarget
}

export interface PidOutput {
  /** Вес организации при выборе для НОВОЙ сессии, [0, wMax]. */
  weight: number
  /** Почему такой вес — одной строкой, для журнала. */
  reason: string
  terms: { setpoint: number; error: number; p: number; i: number; d: number; ff: number; adapt: number; forecast: number }
  braked: boolean
}

const HOUR = 3_600_000

/**
 * Ожидаемый расход окна (доля/час) от уже посаженных сессий: Σ K_cal[класс]·сессии.
 * Класс без калибровки — `kDefault`.
 */
export function expectedLoadPerHour(sessionsByClass: Record<string, number>, adapt: Pick<PidAdaptation, 'kCalByClass' | 'kDefault'> & { driftPerHour?: number }): number {
  let sum = adapt.driftPerHour ?? 0
  for (const [cls, n] of Object.entries(sessionsByClass)) {
    if (!(n > 0)) continue
    const k = adapt.kCalByClass[cls]
    sum += n * (typeof k === 'number' && Number.isFinite(k) && k > 0 ? k : adapt.kDefault)
  }
  return sum
}

/** Класс сессии для коэффициентов: `провайдер/семейство` (opus|sonnet|haiku|fable|…). */
export function sessionClass(provider: string, model: string): string {
  const m = model.toLowerCase()
  const fam = ['fable', 'mythos', 'opus', 'sonnet', 'haiku'].find(f => m.includes(f))
    ?? m.replace(/[-_.]?\d.*$/, '').replace(/^.*\//, '') ?? m
  return `${provider}/${fam || m}`
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * Один шаг регулятора. Мутирует `state`. Вызывать на каждом новом замере util организации
 * (или перед выбором для новой сессии), не чаще, чем меняется замер.
 */
export function pidStep(
  state: PidState, input: PidInput, gains: PidGains, limits: PidLimits, adapt: PidAdaptation,
): PidOutput {
  const { nowMs, util, target } = input
  const key = `${target.targetUtil}@${target.deadlineMs}`
  const zeroTerms = { setpoint: NaN, error: NaN, p: 0, i: 0, d: 0, ff: 0, adapt: 1, forecast: NaN }

  if (util === null || !Number.isFinite(util)) {
    return { weight: state.lastOutput, reason: 'запас не измерен — вес прежний', terms: zeroTerms, braked: false }
  }
  if (nowMs >= target.deadlineMs) {
    state.lastOutput = 0
    return { weight: 0, reason: 'срок цели вышел — приток выключен', terms: zeroTerms, braked: true }
  }

  // Новая цель — новая траектория от текущей точки; интеграл с прошлой цели не переносится.
  if (state.targetKey !== key || state.t0Ms === null || state.util0 === null) {
    state.targetKey = key
    state.t0Ms = nowMs
    state.util0 = util
    state.integral = 0
    state.derivFiltered = 0
    state.lastUtil = util
    state.lastMs = nowMs
  }

  const dtH = state.lastMs === null ? 0 : Math.max(0, (nowMs - state.lastMs) / HOUR)
  const span = Math.max(1, target.deadlineMs - state.t0Ms)
  const progress = clamp((nowMs - state.t0Ms) / span, 0, 1)
  const setpoint = state.util0 + (target.targetUtil - state.util0) * progress
  const slopePerHour = (target.targetUtil - state.util0) / (span / HOUR)
  const error = setpoint - util

  // Производная измерения, сглаженная EMA.
  let rateRaw = 0
  if (dtH > 0 && state.lastUtil !== null) {
    // Сброс окна (util упал) — это не «отрицательный расход»: производную не портим.
    rateRaw = util >= state.lastUtil ? (util - state.lastUtil) / dtH : state.derivFiltered
    const alpha = 1 - Math.exp(-dtH / Math.max(1e-6, limits.derivTauHours))
    state.derivFiltered += alpha * (rateRaw - state.derivFiltered)
  }

  // Нагрузка в калиброванных единицах (ожидаемый Δutil/час от уже посаженных сессий).
  const load = expectedLoadPerHour(input.sessionsByClass, adapt)
  // Онлайн-оценка θ: Δutil/час ≈ θ·load. Регрессия через ноль с забыванием.
  if (adapt.enabled && dtH > 0 && load > 0 && rateRaw >= 0) {
    state.sxy = adapt.forget * state.sxy + load * rateRaw
    state.sxx = adapt.forget * state.sxx + load * load
    state.observations += 1
  }
  // Объект «горячее», чем на истории (θ > 1) → то же отставание закрывается быстрее ⇒
  // усиление регулятора делим на θ. Множитель зажат: адаптация не имеет права увести в разнос.
  let adaptMul = 1
  if (adapt.enabled && state.observations >= adapt.minObservations && state.sxx > 0) {
    const theta = state.sxy / state.sxx
    if (theta > 0 && Number.isFinite(theta)) adaptMul = clamp(1 / theta, adapt.adaptMin, adapt.adaptMax)
  }

  // Тормоз по инерции: докуда дотянут уже посаженные к сроку.
  const hoursLeft = (target.deadlineMs - nowMs) / HOUR
  // Скорость для прогноза — БОЛЬШАЯ из измеренной и ожидаемой от посаженных (по классам, с θ):
  // измеренная запаздывает за только что посаженными, ожидаемая не видит «ленивых». Берём
  // осторожную — тормоз обязан сработать раньше стены, а не после.
  const theta = adapt.enabled && state.observations >= adapt.minObservations && state.sxx > 0
    ? clamp(state.sxy / state.sxx, 1 / adapt.adaptMax, 1 / adapt.adaptMin) : 1
  const forecastRate = Math.max(0, state.derivFiltered, load * theta)
  const forecast = util + forecastRate * hoursLeft
  // 🔴 ЗАПАС РАСТЁТ, КОГДА ОБЪЕКТ ГОРЯЧЕЕ ОЖИДАНИЯ (калибровка 12.11: при объекте ×1.5–×2
  // время у стены росло до 3.8–6%, потому что θ̂ копится десятками шагов). Отношение
  // измеренной скорости к ожидаемой — мгновенный признак «горячее»; запас умножается на него
  // (не меньше 1, не больше 4). Холодный объект запас не уменьшает: тормозить раньше безопасно.
  const hotRatio = load > 1e-6 ? clamp(state.derivFiltered / load, 1, 4) : 1
  const braked = forecast >= target.targetUtil - limits.brakeMargin * hotRatio

  const p = gains.kp * adaptMul * error
  const d = -gains.kd * state.derivFiltered
  const ff = gains.kff * slopePerHour
  // Anti-windup: копим, только если есть приток и выход не насыщен в сторону ошибки.
  const saturatedHigh = state.lastOutput >= limits.wMax - 1e-9 && error > 0
  const saturatedLow = state.lastOutput <= 1e-9 && error < 0
  if (dtH > 0 && input.inflowSinceLast && !braked && !saturatedHigh && !saturatedLow) {
    state.integral = clamp(state.integral + error * dtH, -limits.integralMax, limits.integralMax)
  }
  const i = gains.ki * adaptMul * state.integral

  let u = braked ? 0 : p + i + d + ff
  u = clamp(u, 0, limits.wMax)
  // Ограничение скорости изменения: вес не прыгает (кроме тормоза — он действует сразу).
  if (!braked && dtH > 0) {
    const maxStep = limits.slewPerHour * dtH
    u = clamp(u, state.lastOutput - maxStep, state.lastOutput + maxStep)
  }

  state.lastOutput = u
  state.lastUtil = util
  state.lastMs = nowMs

  const fmt = (v: number) => (v * 100).toFixed(1) + '%'
  const reason = braked
    ? `тормоз: посаженные дотянут до ${fmt(forecast)} к сроку (цель ${fmt(target.targetUtil)}) — новых не шлём`
    : `линия ${fmt(setpoint)}, факт ${fmt(util)}, отставание ${(error * 100).toFixed(1)} п.п. → вес ${u.toFixed(2)}`
  return { weight: u, reason, terms: { setpoint, error, p, i, d, ff, adapt: adaptMul, forecast }, braked }
}
