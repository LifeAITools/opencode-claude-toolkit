/**
 * stream-timing — рисунок прихода потока: пачки или по одному событию.
 *
 * 🔴 ЗАЧЕМ (вопрос владельца deepseek-harness 11.11.2026): его UI считал скорость как
 * токены ÷ (первый кадр → последний кадр) и получал «167 тыс. токенов/с». Причина —
 * кадры приходят ПАЧКАМИ: 33 SSE-события в 9 сетевых чтениях, внутри чтения по 6–8
 * событий сразу, медианный зазор 0 мс. Вопрос был «кто буферизует — LiteLLM или
 * поставщик», и разграничить это можно только замером НА КАЖДОМ ХОПЕ.
 *
 * Наш хоп — прокси: здесь видно, СКОЛЬКО РАЗ `reader.read()` вернул данные и какие
 * между ними зазоры. Если у нас тоже 9 чтений с пачками — пачкует поставщик; если у нас
 * 33 отдельных — пачкует (или склеивает TCP на) сторона клиента.
 *
 * ЧЕСТНАЯ ГРАНИЦА: время внутри одного чтения неизвестно по построению — байты уже
 * склеены. Поэтому «0 мс» между событиями одной пачки — артефакт доставки, а не факт
 * о скорости модели.
 */

export interface ChunkTiming {
  /** Сколько раз чтение вернуло данные. */
  chunks: number
  /** Медиана зазоров между чтениями, мс. `null` — было меньше двух чтений. */
  medianGapMs: number | null
  maxGapMs: number | null
  /** Сколько зазоров ровно нулевые: столько чтений «догнали» предыдущее в ту же миллисекунду. */
  zeroGaps: number
  /** Суммарная длительность от первого чтения до последнего, мс. */
  spanMs: number | null
}

export function chunkTiming(arrivalsMs: number[]): ChunkTiming {
  const n = arrivalsMs.length
  if (n === 0) return { chunks: 0, medianGapMs: null, maxGapMs: null, zeroGaps: 0, spanMs: null }
  if (n === 1) return { chunks: 1, medianGapMs: null, maxGapMs: null, zeroGaps: 0, spanMs: 0 }
  const gaps: number[] = []
  for (let i = 1; i < n; i++) gaps.push(Math.max(0, arrivalsMs[i] - arrivalsMs[i - 1]))
  const sorted = [...gaps].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const medianGapMs = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
  return {
    chunks: n,
    medianGapMs,
    maxGapMs: Math.max(...gaps),
    zeroGaps: gaps.filter(g => g === 0).length,
    spanMs: arrivalsMs[n - 1] - arrivalsMs[0],
  }
}
