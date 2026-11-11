/**
 * placement-rates — производная расхода квоты по ряду сэмплов.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 11.11.2026): «мы же понимаем скорость расходования квоты…
 * в моменте может быть, она ещё не занята, но если мы сейчас опять у всех агентов на неё
 * повесим, то через пять-десять минут она будет самой занята». Средняя с начала окна этого
 * не видит: если организация разогналась последние 20 минут, средняя за 4 часа молчит.
 *
 * Источник — ряд, который и так копится: `~/.claude-local/quota-samples.jsonl`, одна строка
 * на провайдера за проход (таймер `claude-max-placement-sample`, шаг 5 минут). Файл — данные,
 * не код: нет файла — нет производной, анализатор вернётся к средней.
 *
 * ЧЕСТНАЯ ГРАНИЦА: это разность двух замеров, а не сглаженная производная с фильтром. Ряд
 * 5-минутный, поэтому короткий всплеск внутри пяти минут виден только следующим замером.
 * Отрицательная разность — это СБРОС окна (util упал), а не «расход в обратную сторону»:
 * такой участок даёт 0, а не отрицательную скорость.
 */

export interface RateSample {
  ts?: string
  ms?: number
  provider?: string
  orgs?: Array<{ name?: string; windows?: Array<{ window?: string; util?: number }> }>
}

/** Разбор ряда: по одной записи на строку, битые строки пропускаются без шума. */
export function parseRateSamples(text: string): RateSample[] {
  const out: RateSample[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object') out.push(v as RateSample)
    } catch { /* одна битая строка не должна ронять весь ряд */ }
  }
  return out
}

export interface RateSpan { fromMs: number; toMs: number }

export interface RecentRatesOptions {
  provider: string
  nowMs: number
  /**
   * Куда положить ГРАНИЦЫ промежутка, за который считалась доля — по каждой организации
   * и окну. Проставка «доля на токен» обязана считать токены РОВНО за этот промежуток.
   */
  spansOut?: Map<string, Record<string, RateSpan>>
  /** Насколько глубоко назад смотрим. По умолчанию 30 минут — «последние несколько замеров». */
  windowMs?: number
  /** Короче этого промежутка производную не считаем: два замера в одну секунду — не скорость. */
  minSpanMs?: number
}

/**
 * Скорость расхода по каждой организации и окну, в ДОЛЯХ ОКНА В ЧАС.
 * Возвращает только то, что действительно измеримо: организацию без двух замеров не выдумываем.
 */
export function recentRatesFromSamples(
  text: string,
  opts: RecentRatesOptions,
): Map<string, Record<string, number>> {
  const windowMs = opts.windowMs ?? 30 * 60 * 1000
  const minSpanMs = opts.minSpanMs ?? 4 * 60 * 1000
  const since = opts.nowMs - windowMs

  const samples = parseRateSamples(text)
    .map(s => ({ ms: typeof s.ms === 'number' ? s.ms : Date.parse(String(s.ts ?? '')), s }))
    .filter(x => x.s.provider === opts.provider && Number.isFinite(x.ms) && x.ms >= since)
    .sort((a, b) => a.ms - b.ms)

  const first = new Map<string, { ms: number; util: number }>()
  const last = new Map<string, { ms: number; util: number }>()
  for (const { ms, s } of samples) {
    for (const org of (s.orgs ?? [])) {
      const name = typeof org?.name === 'string' ? org.name : null
      if (!name) continue
      for (const w of (org.windows ?? [])) {
        const wn = typeof w?.window === 'string' ? w.window : null
        const util = w?.util
        if (!wn || typeof util !== 'number' || !Number.isFinite(util)) continue
        const key = `${name}\u0000${wn}`
        if (!first.has(key)) first.set(key, { ms, util })
        last.set(key, { ms, util })
      }
    }
  }

  const out = new Map<string, Record<string, number>>()
  for (const [key, end] of last) {
    const start = first.get(key)
    if (!start) continue
    const spanMs = end.ms - start.ms
    if (spanMs < minSpanMs) continue
    const delta = end.util - start.util
    // util упал → окно сбросилось; расход вперёд по этому участку неизвестен, не выдумываем.
    const rate = delta <= 0 ? 0 : delta / (spanMs / 3_600_000)
    const [name, win] = key.split('\u0000')
    const rec = out.get(name) ?? {}
    rec[win] = rate
    out.set(name, rec)
    if (opts.spansOut) {
      const sr = opts.spansOut.get(name) ?? {}
      sr[win] = { fromMs: start.ms, toMs: end.ms }
      opts.spansOut.set(name, sr)
    }
  }
  return out
}
