/**
 * Дешёвая проверка по тексту обязана быть СТРОГО равносильна разбору тела.
 *
 * 🔴 ЧЕМ КУПЛЕНО (29.08.2026). Родной Claude Code шлёт тела в среднем по 1.98 МБ
 * (замер по 200 самым крупным настоящим телам, максимум 3.3 МБ), и на каждом ходу
 * мы разбирали такое тело в объектное дерево ради одной поправки. Замер на живом
 * теле 3.3 МБ: разбор со сборкой обратно — 8.3 мс и +58.5 МБ занятой памяти на ход,
 * проверка по тексту — 0.48 мс и ноль выделений. При этом поправлять было нечего ни
 * в одном из 200 тел.
 *
 * Повод пришёл от соседа: их экземпляр убило ядро за память при потолке в гигабайт,
 * и они намерили ~30 МБ пика на ход. Это была первая работа, которую можно убрать
 * целиком, ничего не потеряв.
 *
 * Равносильность держится на одном: понизить усилие движок может ТОЛЬКО когда оно
 * выше 'high'. Значит текст без xhigh и без max разбирать незачем — здесь это и
 * проверяется, включая случаи, где легко ошибиться: усилие есть, но обычное;
 * размышление выключено, но усилие в норме; чужой клиент печатает с отступами.
 */

import { describe, test, expect } from 'bun:test'
import { EFFORT_ABOVE_HIGH_RE } from '../src/modules/anthropic.js'
import { clampEffortIfThinkingDisabled } from '@life-ai-tools/claude-code-sdk'

/** Тело, каким его шлёт клиент: без отступов. */
const body = (o: Record<string, unknown>) => JSON.stringify(o)

const cases: Array<{ имя: string; raw: string; ждём: 'разбирать' | 'пропустить' }> = [
  { имя: 'xhigh при выключенном размышлении — тот самый случай',
    raw: body({ model: 'claude-opus-5', thinking: { type: 'disabled' }, output_config: { effort: 'xhigh' } }),
    ждём: 'разбирать' },
  { имя: 'max при отсутствующем размышлении',
    raw: body({ model: 'claude-opus-5', output_config: { effort: 'max' } }),
    ждём: 'разбирать' },
  { имя: 'обычное high — понижать нечего',
    raw: body({ model: 'claude-opus-5', thinking: { type: 'disabled' }, output_config: { effort: 'high' } }),
    ждём: 'пропустить' },
  { имя: 'усилия нет вовсе',
    raw: body({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'привет' }] }),
    ждём: 'пропустить' },
  { имя: 'размышление включено, усилие xhigh — разбираем, но правки не будет',
    raw: body({ model: 'claude-opus-5', thinking: { type: 'enabled', budget_tokens: 1024 }, output_config: { effort: 'xhigh' } }),
    ждём: 'разбирать' },
  { имя: 'чужой клиент с отступами',
    raw: JSON.stringify({ output_config: { effort: 'xhigh' } }, null, 2),
    ждём: 'разбирать' },
]

describe('пропуск разбора тела равносилен разбору', () => {
  for (const c of cases) {
    test(c.имя, () => {
      expect(EFFORT_ABOVE_HIGH_RE.test(c.raw) ? 'разбирать' : 'пропустить').toBe(c.ждём)
    })
  }

  test('ГЛАВНОЕ: то, что мы пропускаем, поправки бы и не получило', () => {
    for (const c of cases) {
      if (EFFORT_ABOVE_HIGH_RE.test(c.raw)) continue
      // Пропущенное тело: разбери мы его, движок всё равно вернул бы «нечего делать».
      expect(clampEffortIfThinkingDisabled(JSON.parse(c.raw))).toBeNull()
    }
  })

  test('а то, что разбираем, поправляется ровно там, где должно', () => {
    const clamped = JSON.parse(cases[0]!.raw)
    expect(clampEffortIfThinkingDisabled(clamped)).toBe('xhigh')
    expect((clamped.output_config as { effort: string }).effort).toBe('high')

    const untouched = JSON.parse(cases[4]!.raw)  // размышление включено
    expect(clampEffortIfThinkingDisabled(untouched)).toBeNull()
    expect((untouched.output_config as { effort: string }).effort).toBe('xhigh')
  })
})
