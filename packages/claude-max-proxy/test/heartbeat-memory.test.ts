/**
 * Строка здоровья обязана нести память — иначе смерть по памяти нечем объяснить.
 *
 * 🔴 ЧЕМ КУПЛЕНО (28.08.2026). Экземпляр прокси у соседнего проекта убило ядро за
 * память: exit 137 при потолке 1 ГБ, контейнер поднялся заново, и всё, что было
 * до смерти, ушло вместе с процессом. Регулярная строка здоровья несла сессии,
 * срабатывания и чтение кэша — но НЕ несла память, и две противоположные причины
 * («течёт понемногу» против «один чудовищный запрос взял всё разом») оказались по
 * ней неразличимы.
 *
 * Отсюда два требования, которые здесь и проверяются: чисел ДВА (сейчас и пик),
 * и пик берётся у ядра, а не считается по нашим же замерам раз в полминуты —
 * всплеск между двумя замерами выборка не увидит, а ядро помнит его точно.
 */

import { describe, test, expect } from 'bun:test'
import { sampleMemory } from '../src/heartbeat.js'

describe('память в строке здоровья', () => {
  test('оба числа названы и оба положительные', () => {
    const m = sampleMemory()
    expect(m.rssMb).toBeGreaterThan(0)
    expect(m.peakRssMb).toBeGreaterThan(0)
    expect(m.heapUsedMb).toBeGreaterThan(0)
  })

  test('пик не может быть меньше того, что занято сейчас', () => {
    const m = sampleMemory()
    expect(m.peakRssMb).toBeGreaterThanOrEqual(m.rssMb)
  })

  test('на Linux пик приходит ОТ ЯДРА, а не из наших замеров', () => {
    const m = sampleMemory()
    // Тест бежит на Linux; где /proc нет, честный ответ — 'sampled',
    // и поле обязано это назвать, а не молча выдать выборку за истину.
    expect(['kernel', 'sampled']).toContain(m.peakSource)
    if (process.platform === 'linux') expect(m.peakSource).toBe('kernel')
  })

  test('пик ПОМНИТ всплеск, который к следующему замеру уже отпущен', () => {
    const before = sampleMemory()
    // Взять и отпустить заметный кусок: к моменту второго замера занятое
    // вернётся примерно к прежнему, а пик обязан остаться поднятым.
    let hog: Uint8Array | null = new Uint8Array(160 * 1024 * 1024)
    hog.fill(7)
    const atPeak = sampleMemory()
    hog = null
    expect(atPeak.peakRssMb).toBeGreaterThanOrEqual(before.peakRssMb + 100)
    const after = sampleMemory()
    expect(after.peakRssMb).toBeGreaterThanOrEqual(atPeak.peakRssMb)
  })
})
