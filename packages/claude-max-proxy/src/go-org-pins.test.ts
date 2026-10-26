/**
 * Выдачи переживают перезапуск двери. Полюс измерен 26.10.2026: память процесса стиралась
 * каждым выпуском прокси, и живая сессия с уже выданной организацией выбиралась заново —
 * в следе это `pin → quota → pin`, то есть холодная перезапись префикса на ровном месте.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { savePins, restorePinsForTest } from './modules/go-door.js'

describe('выдачи организации на диске', () => {
  test('свежая выдача попадает в файл, просроченная — нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'))
    const path = join(dir, 'pins.json')
    const now = Date.now()
    restorePinsForTest([
      ['ses_fresh', { org: 'hello@sealform.dev', at: now }],
      ['ses_old', { org: 'hello@foody7.com', at: now - 13 * 3600 * 1000 }],
    ])
    savePins(path)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    expect(Object.keys(doc.pins)).toEqual(['ses_fresh'])
    expect(doc.pins.ses_fresh.org).toBe('hello@sealform.dev')
  })

  test('файл читается обратно тем же форматом', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pins-'))
    const path = join(dir, 'pins.json')
    const now = Date.now()
    restorePinsForTest([['ses_a', { org: 'hello@kiberos.app', at: now }]])
    savePins(path)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    expect(doc.version).toBe(1)
    expect(doc.pins.ses_a).toEqual({ org: 'hello@kiberos.app', at: now })
  })
})
