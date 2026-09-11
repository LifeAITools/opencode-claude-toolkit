/**
 * Ни один набор тестов не смеет писать в ЖИВОЙ учёт стоящих сессий.
 *
 * 🔴 ЗАМЕР 11.09.2026: два набора из трёх подменяли путь переменной окружения,
 * которая читается ОДИН РАЗ при загрузке модуля. В одиночку зелено, в общем
 * прогоне подмена молча не срабатывает — и в боевой файл попали выдуманные
 * стоящие сессии. Фаундер получил бы карточки про агентов, которых нет.
 *
 * Этот сторож проверяет не поведение, а ИСХОДНИКИ: каждый зов тревоги в тестах
 * обязан нести свой `statePath`. Он краснеет на новом тесте ДО того, как тот
 * первый раз испортит живой файл.
 */

import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('тесты не трогают боевой учёт стоящих', () => {
  test('каждый зов startLocalAlert в тестах несёт свой statePath', () => {
    const dir = import.meta.dir
    const offenders: string[] = []
    // Себя сторож не судит: в его собственном коде имена ищутся строками, и он
    // покраснел бы на самом себе — прибор, ломающийся о собственное отражение.
    const self = 'local-alert-never-writes-live-state.test.ts'
    for (const f of readdirSync(dir).filter(f => f.endsWith('.test.ts') && f !== self)) {
      const src = readFileSync(join(dir, f), 'utf8')
      for (const line of src.split('\n')) {
        if (!line.includes('startLocalAlert(')) continue
        if (line.includes('statePath')) continue
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
        if (line.includes('import ')) continue
        offenders.push(`${f}: ${line.trim()}`)
      }
    }
    expect(offenders).toEqual([])
  })

  test('подмена через переменную окружения в тестах запрещена — она не работает в общем прогоне', () => {
    const dir = import.meta.dir
    const offenders: string[] = []
    const self2 = 'local-alert-never-writes-live-state.test.ts'
    for (const f of readdirSync(dir).filter(f => f.endsWith('.test.ts') && f !== self2)) {
      const src = readFileSync(join(dir, f), 'utf8')
      if (/process\.env\.(PROXY_BLOCKED_STATE_PATH|CLAUDE_KEEPALIVE_CONFIG_PATH)\s*=/.test(src)) {
        offenders.push(f)
      }
    }
    expect(offenders).toEqual([])
  })
})
