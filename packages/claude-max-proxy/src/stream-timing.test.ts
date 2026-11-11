/**
 * Рисунок потока: пачки против по-одному.
 *
 * Живой случай 11.11.2026 (вопрос владельца deepseek-harness): 33 SSE-события пришли в
 * 9 сетевых чтениях, внутри чтений по 6–8 событий сразу, медианный зазор между событиями
 * 0 мс. Вопрос «кто пачкует» решается замером на КАЖДОМ хопе, а не догадкой.
 */
import { describe, expect, test } from 'bun:test'
import { chunkTiming } from './stream-timing.js'

describe('рисунок прихода потока', () => {
  test('пустой поток — пусто, а не «ноль зазоров»', () => {
    expect(chunkTiming([])).toEqual({ chunks: 0, medianGapMs: null, maxGapMs: null, zeroGaps: 0, spanMs: null })
  })

  test('одно чтение — зазоров нет', () => {
    expect(chunkTiming([1000]).chunks).toBe(1)
    expect(chunkTiming([1000]).medianGapMs).toBeNull()
    expect(chunkTiming([1000]).spanMs).toBe(0)
  })

  test('пачки: 9 чтений, часть в одну миллисекунду', () => {
    // Девять чтений: 0, 1640, 1640, 2341, 2341, 3000, 3600, 4200, 4800.
    const t = chunkTiming([0, 1640, 1640, 2341, 2341, 3000, 3600, 4200, 4800])
    expect(t.chunks).toBe(9)
    expect(t.zeroGaps).toBe(2)
    expect(t.maxGapMs).toBe(1640)
    expect(t.spanMs).toBe(4800)
    expect(t.medianGapMs).not.toBeNull()
  })

  test('медиана зазоров — середина отсортированного ряда, а не среднее', () => {
    // Зазоры: 10, 20, 30 → медиана 20.
    expect(chunkTiming([0, 10, 30, 60]).medianGapMs).toBe(20)
    // Зазоры: 10, 20 → медиана (10+20)/2 = 15.
    expect(chunkTiming([0, 10, 30]).medianGapMs).toBe(15)
  })

  test('отрицательный зазор (часы назад) не ломает: считается нулём', () => {
    expect(chunkTiming([100, 100, 50]).zeroGaps).toBe(2)
  })
})
