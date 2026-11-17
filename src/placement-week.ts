/**
 * placement-week — НЕДЕЛЬНАЯ ЦЕЛЬ с учётом ритма дня: успеть выбрать лимит к сбросу, не упираясь в стену.
 *
 * 🔴 СЛОВО ФАУНДЕРА 17.11.2026 (TG 89200/89208): «задача балансировщика — не просто усреднять
 * нагрузку, а максимизировать расход: недельную до 99%, условно даже до 100, не упираясь в стены;
 * учитывать рабочие часы — не оставлять на глубокую ночь объёмы, которые ночью точно не потратятся;
 * организацию, у которой сброс дальше всех, ставить последней, чтобы успеть дожечь остальные».
 *
 * ИДЕЯ. Расход не равномерен по часам: ночью (00–08 по Киеву) уходит ~10% ходов, днём — по 6–7% в час.
 * Поэтому «осталось до сброса 30 часов» не равно «осталось 30 часов работы». Время измеряется
 * МАССОЙ АКТИВНОСТИ — интегралом часового и недельного веса (`activity-profile.ts`), 1 = обычный час.
 *
 *   elapsedMass   — масса от начала окна до сейчас
 *   remainingMass — масса от сейчас до сброса
 *   rate          = util / elapsedMass            расход недели на единицу массы
 *   forecast      = util + rate · remainingMass   где окажемся к сбросу при нынешнем темпе
 *   deficit       = max(0, target − forecast)     сколько недели НЕ успеем выбрать
 *   need          = deficit / remainingMass       «какую интенсивность надо добавить на единицу массы»
 *
 * Организации с большей `need` кормим раньше: у неё мало «рабочего» времени до сброса, а остаток
 * ещё велик. Ночь в этом считается по заслугам: организация, у которой до сброса в основном ночь,
 * получает большую `need` СЕЙЧАС, днём — и выжигается, пока люди работают.
 *
 * ЧЕСТНЫЕ ГРАНИЦЫ. (1) Профиль — по часам UTC средний за июнь–ноябрь; это ритм ФЛОТА, не прогноз
 * на конкретный день (праздник, аврал). (2) Фоновый расход прогрева идёт ровно по часам, а не по
 * активности, и здесь отнесён к общему темпу — модель недооценивает ночной расход ровно на него.
 * (3) Прогноз линейный по массе: сессии, посаженные позже, его меняют; для этого он пересчитывается
 * на каждом рождении сессии. (4) Это ключ ВЫБОРА, а не гарантия: стену по-прежнему держит
 * `weekBrakeUtil`, а живые сессии не переносятся (рельса no-live-account-migration).
 *
 * Модуль чистый: время, профиль и цель — параметрами.
 */
import { HOURLY_WEIGHT_UTC, WEEKDAY_WEIGHT_UTC } from './activity-profile.js'

const HOUR = 3_600_000
const STEP = 15 * 60_000
export const WEEK_MS = 7 * 24 * HOUR

/** Цель недели по слову фаундера: 99% («условно даже до 100»); стену до 0.98 держит weekBrakeUtil. */
export const WEEK_TARGET_UTIL = 0.99

export interface ActivityProfile {
  hourly: readonly number[]
  weekday: readonly number[]
}
export const DEFAULT_PROFILE: ActivityProfile = { hourly: HOURLY_WEIGHT_UTC, weekday: WEEKDAY_WEIGHT_UTC }

/** Вес момента: часовой × недельный, оба со средним 1. */
export function activityWeightAt(ms: number, p: ActivityProfile = DEFAULT_PROFILE): number {
  const d = new Date(ms)
  return (p.hourly[d.getUTCHours()] ?? 1) * (p.weekday[d.getUTCDay()] ?? 1)
}

/** Масса активности между двумя моментами, в «обычных часах». Отрицательный интервал — 0. */
export function activityMass(fromMs: number, toMs: number, p: ActivityProfile = DEFAULT_PROFILE): number {
  if (!(toMs > fromMs)) return 0
  let sum = 0
  for (let t = fromMs; t < toMs; t += STEP) {
    const dt = Math.min(STEP, toMs - t)
    sum += activityWeightAt(t + dt / 2, p) * (dt / HOUR)
  }
  return sum
}

export interface WeekForecast {
  /** Где окажемся к сбросу при нынешнем темпе (может быть > 1: тогда упрёмся). */
  forecast: number
  /** Сколько недели не успеем выбрать до цели; 0 — успеем. */
  deficit: number
  /** Масса активности до сброса, в обычных часах. */
  remainingMass: number
  /** Нужная добавка интенсивности на единицу массы: deficit / remainingMass. */
  need: number
  /** Часы до сброса по часам (для сравнения с массой в журнале). */
  resetsInHours: number
}

/**
 * Прогноз недели. `null` — считать нечего: нет измерения / срока сброса, окно только началось
 * (меньше получаса массы — делить не на что), или сброс уже прошёл. Это «не знаю», а НЕ «ноль».
 */
export function forecastWeek(
  util: number | null, resetAtMs: number | null, nowMs: number,
  target = WEEK_TARGET_UTIL, p: ActivityProfile = DEFAULT_PROFILE,
): WeekForecast | null {
  if (typeof util !== 'number' || !Number.isFinite(util) || resetAtMs === null || !Number.isFinite(resetAtMs)) return null
  if (resetAtMs <= nowMs) return null
  const startMs = resetAtMs - WEEK_MS
  const elapsed = activityMass(startMs, nowMs, p)
  if (elapsed < 0.5) return null
  const remaining = activityMass(nowMs, resetAtMs, p)
  const rate = util / elapsed
  const forecast = util + rate * remaining
  const deficit = Math.max(0, target - forecast)
  return {
    forecast, deficit, remainingMass: remaining,
    need: remaining > 1e-9 ? deficit / remaining : 0,
    resetsInHours: (resetAtMs - nowMs) / HOUR,
  }
}
