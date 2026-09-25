/**
 * Конец хода opencode доходит до правил флота (договор стыка signal-wire, часть 2).
 *
 * До 2026-09-25 плагин отдавал общий поток `event` только привязке сессии, и правила флота на конце
 * хода у агентов opencode не срабатывали: сохранение памяти, сверка реестра сессий, зеркало памяти,
 * подсказка session-stop-review. Плагин теперь шлёт `session.idle` в тот же `evaluateHook`, что и
 * `chat.message`; этот тест проверяет вторую половину — что такое событие на боевом наборе поднимает
 * именно эти правила. Команды правил выключены (SW_EXEC_OFF): тест не должен действовать в мире.
 */
import { describe, expect, test } from 'bun:test'
import { getBundledRulesPath } from '@kiberos/signal-wire-core'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'

describe('opencode: session.idle на боевом наборе', () => {
  test('поднимает правила флота на конце хода', async () => {
    const sw = new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_idle_probe', rulesPath: getBundledRulesPath(), platform: 'opencode' })
    const results = await sw.evaluateHook({ source: 'plugin', type: 'session.idle', sessionId: 'ses_idle_probe', timestamp: Date.now(), payload: {} } as any)
    const fired = new Set(results.map((r: any) => r?.ruleId).filter(Boolean))
    for (const id of ['memory-session-autostore', 'session-reconcile-on-event', 'memory-mirror-on-stop']) {
      expect(fired.has(id)).toBe(true)
    }
  })
})
