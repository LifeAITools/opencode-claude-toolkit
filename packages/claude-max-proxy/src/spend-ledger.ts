/**
 * spend-ledger — расход в РЕАЛЬНОМ ВРЕМЕНИ по собственным записям, а не по 5-минутному опросу.
 *
 * 🔴 ВОПРОС ФАУНДЕРА 11.11.2026: «что значит ряды замеров раз в пять минут? у нас через прокси
 * проходит куча запросов… можем в реальном времени писать журнал и понимать решение на базе
 * записанного». Верно: 5 минут — это шаг ОПРОСА КВОТЫ у поставщика (другого источника у нас
 * нет), а не наш выбор точности. Но токены каждого вызова дверь видит САМА, в момент ответа,
 * и пишет их в журнал (`provider-dump`). Здесь они складываются в скользящее окно — это и есть
 * настоящая производная, без пятиминутного запаздывания.
 *
 * 🔴 ЧЕГО НЕЛЬЗЯ СКАЗАТЬ БЕЗ ПРОСТАВКИ: токены ≠ доля окна. Поставщик сообщает остаток плана
 * только опросом, поэтому перевод «токены/час → доля окна/час» берётся ИЗ ДВУХ ИЗМЕРЕНИЙ:
 * доля (опрос) на токены (наши записи) за один и тот же промежуток. Нет проставки — возвращаем
 * долю из опроса как есть; выдумывать курс нельзя.
 */

export interface SpendEntry {
  /** Момент завершения вызова, мс эпохи. */
  at: number
  /** Токены вызова: input + output (то, что поставщик считает в окне). */
  tokens: number
}

/** Сколько храним: производная считается по 10 минутам, проставка — по 30. Часа хватает с запасом. */
export const SPEND_KEEP_MS = 60 * 60 * 1000

/** Отбросить всё, что старше `keep` от `nowMs`. Чистая функция — возвращает НОВЫЙ массив. */
export function compactSpend(entries: SpendEntry[], nowMs: number, keepMs = SPEND_KEEP_MS): SpendEntry[] {
  const cutoff = nowMs - keepMs
  return entries.filter(e => e.at >= cutoff)
}

/** Токены за скользящее окно (включая границу). */
export function tokensInWindow(entries: SpendEntry[], nowMs: number, windowMs: number): number {
  const since = nowMs - windowMs
  let sum = 0
  for (const e of entries) if (e.at >= since && e.at <= nowMs) sum += Math.max(0, e.tokens)
  return sum
}

/**
 * Токены в час за явный промежуток [fromMs, toMs] — для проставки.
 *
 * 🔴 ПРОСТАВКА ТРЕБУЕТ ОДНОГО И ТОГО ЖЕ ПРОМЕЖУТКА С ОБЕИХ СТОРОН: доля окна берётся из
 * опроса за конкретный интервал, и токены должны считаться РОВНО за него, а не за
 * «номинальные 30 минут». Замер 11.11.2026: сразу после перезапуска в окне было 9 минут
 * записей, а делили на все 30 — проставка завышалась втрое, и мгновенная скорость
 * показывала всплеск, которого нет. Нет полного промежутка — это «не измерено».
 */
export function tokensRateInRange(entries: SpendEntry[], fromMs: number, toMs: number): number | null {
  if (!(toMs > fromMs)) return null
  const spanMs = toMs - fromMs
  if (spanMs < 60_000) return null
  let sum = 0
  let any = false
  for (const e of entries) {
    if (e.at >= fromMs && e.at <= toMs) { sum += Math.max(0, e.tokens); any = true }
  }
  if (!any) return null
  return sum / (spanMs / 3_600_000)
}

/**
 * Токены в час за окно (мгновенная скорость).
 *
 * 🔴 ДЕЛИТЕЛЬ НЕ ВРЁТ: `null`, если записей нет ИЛИ ряд покрывает меньше 80% окна.
 * После перезапуска прокси первые минуты окно не покрыто — честнее сказать «не измерено»,
 * чем делить частичный ряд на полное окно и занизить скорость.
 */
export function tokensPerHour(entries: SpendEntry[], nowMs: number, windowMs: number): number | null {
  const inWindow = entries.filter(e => e.at >= nowMs - windowMs && e.at <= nowMs)
  if (inWindow.length === 0) return null
  const oldest = Math.min(...inWindow.map(e => e.at))
  if (nowMs - oldest < windowMs * 0.8) return null
  return tokensInWindow(entries, nowMs, windowMs) / (windowMs / 3_600_000)
}

/**
 * Проставка «доля окна на токен»: сколько доли окна приходится на один токен.
 * Оба числа обязаны быть за ОДИН промежуток, иначе курс врёт. `null` — считать не из чего.
 */
export function fractionPerToken(sampleFractionPerHour: number | null | undefined, sampledTokensPerHour: number | null | undefined): number | null {
  if (typeof sampleFractionPerHour !== 'number' || !Number.isFinite(sampleFractionPerHour)) return null
  if (typeof sampledTokensPerHour !== 'number' || !Number.isFinite(sampledTokensPerHour) || sampledTokensPerHour <= 0) return null
  return sampleFractionPerHour / sampledTokensPerHour
}

/**
 * Доля окна в час В РЕАЛЬНОМ ВРЕМЕНИ: токены за последние 10 минут × проставка.
 * Проставки нет — возвращаем `null` (вызывающий возьмёт долю из опроса, а не выдумку).
 */
export function realtimeFractionPerHour(
  recentTokensPerHour: number | null,
  ratio: number | null,
): number | null {
  if (recentTokensPerHour === null || ratio === null) return null
  if (!Number.isFinite(recentTokensPerHour) || recentTokensPerHour <= 0) return null
  return recentTokensPerHour * ratio
}

/** Токены вызова из нормализованного usage двери: input + output (кэш-чтение уже внутри input). */
export function spendTokensOfUsage(u: { input?: number | null; output?: number | null } | null | undefined): number | null {
  if (!u) return null
  const input = typeof u.input === 'number' && Number.isFinite(u.input) ? Math.max(0, u.input) : null
  const output = typeof u.output === 'number' && Number.isFinite(u.output) ? Math.max(0, u.output) : null
  if (input === null && output === null) return null
  return (input ?? 0) + (output ?? 0)
}
