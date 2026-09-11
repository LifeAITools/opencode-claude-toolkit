/**
 * СНЯТЬ ИЗ УЧЁТА ЗАВЕДОМО МЁРТВУЮ ЗАПИСЬ — ДВЕРЬ, КОТОРОЙ НЕ БЫЛО.
 *
 * Учёт стоящих сессий умеет ставить на учёт и снимать сам (по мёртвому
 * процессу или по потолку в двое суток), но НЕ умеет принять решение человека
 * «этой сессии не существует, убери её». Замер 11.09.2026: в живом учёте
 * висела aaf2acbd — 190 часов, 18 напоминаний, процесс за ней не числится
 * вовсе, и снять её было нечем: ждать сутки до потолка или править живой файл
 * машины руками. Правка руками — ровно то, чем эта смена уже обожглась
 * (тестовый прогон дважды переписал боевое состояние, инцидент 11.09).
 *
 * Цена пробела не в мусоре, а в доверии: тревога зовёт человека разрешить
 * сессию, которой нет, нажатие уходит впустую, и человек перестаёт читать
 * карточки — ломается ровно то, ради чего вся цепь и строилась.
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startLocalAlert, dropStuck, stuckSessionState, _stuckState } from '../src/local-alert.js'

let stop: (() => void) | null = null
let dir: string | null = null

afterEach(() => {
  try { stop?.() } catch { /* уже остановлена */ }
  stop = null
  if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* ушёл сам */ } }
  dir = null
  _stuckState.clear()
})

/** Поднимает тревогу на СВОЁМ файле состояния — живой файл машины не в игре. */
function arm(): string {
  dir = mkdtempSync(join(tmpdir(), 'drop-stuck-'))
  const statePath = join(dir, 'blocked-sessions.json')
  stop = startLocalAlert(() => ({ pid: null, cwd: null }), { statePath })
  return statePath
}

describe('снятие стоящей сессии по решению человека', () => {
  test('снятая сессия исчезает из учёта и говорит, сколько простояла', () => {
    arm()
    _stuckState.put('s-gone', { since: Date.now() - 3_600_000, lastBlockAt: Date.now() - 3_600_000, announcedAt: 0, announcements: 3, reason: 'проверка', tokens: 1000 })

    expect(stuckSessionState('s-gone').stuck).toBe(true)
    const r = dropStuck('s-gone')

    expect(r.dropped).toBe(true)
    expect(r.wasStuck).toBe(true)
    expect(r.stuckForSec).toBeGreaterThanOrEqual(3599)
    expect(stuckSessionState('s-gone').stuck).toBe(false)
  })

  test('снятие того, кого в учёте нет, — не ошибка, но и не выдумка', () => {
    // Карточке нужно РАЗЛИЧАТЬ «убрал» и «нечего было убирать»: одно слово на
    // оба случая — это как раз то, из-за чего человек перестаёт верить ответу.
    arm()
    const r = dropStuck('s-never-existed')

    expect(r.dropped).toBe(false)
    expect(r.wasStuck).toBe(false)
    expect(r.stuckForSec).toBeNull()
  })

  test('снятие переживает перезапуск — оно ложится на диск, а не только в память', () => {
    const statePath = arm()
    _stuckState.put('s-persist', { since: Date.now() - 60_000, lastBlockAt: Date.now() - 60_000, announcedAt: 0, announcements: 1, reason: 'проверка', tokens: 10 })
    dropStuck('s-persist')

    expect(existsSync(statePath)).toBe(true)
    const onDisk = JSON.parse(readFileSync(statePath, 'utf8'))
    expect(Object.keys(onDisk)).not.toContain('s-persist')
  })

  test('снимается названная сессия и только она', () => {
    arm()
    _stuckState.put('s-keep', { since: Date.now() - 60_000, lastBlockAt: Date.now() - 60_000, announcedAt: 0, announcements: 1, reason: 'проверка', tokens: 10 })
    _stuckState.put('s-drop', { since: Date.now() - 60_000, lastBlockAt: Date.now() - 60_000, announcedAt: 0, announcements: 1, reason: 'проверка', tokens: 10 })

    dropStuck('s-drop')

    expect(stuckSessionState('s-drop').stuck).toBe(false)
    expect(stuckSessionState('s-keep').stuck).toBe(true)
  })
})
