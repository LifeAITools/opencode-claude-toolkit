/**
 * Режим человека (FR-7) — `auto` / `away-until` / `off`.
 *
 * Держит главное свойство: ОТКАЗ ЧЕЛОВЕКА СИЛЬНЕЕ ПОЛИТИКИ. `off` разрешает
 * потратить ход вопреки сторожу всегда, `away-until` — пока время не прошло,
 * `auto`/нет записи — не разрешает (решает сторож). `away-until` без времени не
 * означает «навсегда»: это ошибка ввода, и она не должна превращаться в вечное
 * разрешение.
 */

import { describe, test, expect } from 'bun:test'
import { humanModeAllowsSpend } from '../src/proxy-client.js'

const NOW = 1_700_000_000_000

describe('режим человека (FR-7) — отказ человека сильнее политики', () => {
  test('нет записи / auto — решает сторож, а не человек', () => {
    expect(humanModeAllowsSpend(undefined, NOW)).toBe(false)
    expect(humanModeAllowsSpend({ mode: 'auto', until: null }, NOW)).toBe(false)
  })

  test('off — разрешает трату всегда', () => {
    expect(humanModeAllowsSpend({ mode: 'off', until: null }, NOW)).toBe(true)
  })

  test('away-until — разрешает до срока и не разрешает после', () => {
    expect(humanModeAllowsSpend({ mode: 'away-until', until: NOW + 60_000 }, NOW)).toBe(true)
    expect(humanModeAllowsSpend({ mode: 'away-until', until: NOW - 1 }, NOW)).toBe(false)
    // ровно в срок — уже НЕ разрешает (окно закрылось)
    expect(humanModeAllowsSpend({ mode: 'away-until', until: NOW }, NOW)).toBe(false)
  })

  test('away-until без времени — НЕ «навсегда»', () => {
    expect(humanModeAllowsSpend({ mode: 'away-until', until: null }, NOW)).toBe(false)
  })
})
