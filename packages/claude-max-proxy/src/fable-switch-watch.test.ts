import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySwitch, decide, type SwitchConfig } from './fable-switch-watch.js'

const cfg = (over: Partial<SwitchConfig> = {}): SwitchConfig => ({
  armed: true, watchOrg: 'f9420373', model: 'Fable', dropBy: 0.3, minPrev: 0.5,
  apply: { orgModels: { b3219c9b: ['claude-fable-5-2'] } }, lastUtil: 0.86, ...over,
})

describe('решение по замеру счётчика Fable', () => {
  test('резкое падение с высокого уровня — сброс', () => {
    expect(decide(cfg(), 0.02)).toEqual({ kind: 'fire', util: 0.02, prev: 0.86 })
  })
  test('рост и обычная работа — только запомнить', () => {
    expect(decide(cfg(), 0.9)).toEqual({ kind: 'record', util: 0.9 })
    expect(decide(cfg({ lastUtil: 0.3 }), 0.31)).toEqual({ kind: 'record', util: 0.31 })
  })
  test('малое падение или падение с низкого уровня — не сброс', () => {
    expect(decide(cfg(), 0.7).kind).toBe('record')
    expect(decide(cfg({ lastUtil: 0.2 }), 0.0).kind).toBe('record')
  })
  test('«не измерено» — не сброс и не запись: состояние не меняем', () => {
    expect(decide(cfg(), null).kind).toBe('skip')
    expect(decide(cfg(), NaN).kind).toBe('skip')
  })
  test('не взведён — ничего не делает, даже при падении', () => {
    expect(decide(cfg({ armed: false }), 0.0).kind).toBe('skip')
  })
  test('первый замер (прошлого нет) только запоминается', () => {
    expect(decide(cfg({ lastUtil: null }), 0.0)).toEqual({ kind: 'record', util: 0 })
  })
})

describe('применение правила к placement.json', () => {
  test('заменяет orgModels целиком, остальное не трогает, оставляет резервную копию', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fsw-'))
    const p = join(dir, 'placement.json')
    writeFileSync(p, JSON.stringify({ enabled: true, weekBrakeUtil: 0.98, orgModels: { f9420373: ['claude-fable-5-2'], b3219c9b: ['org-closed-no-model'] } }))
    const backup = applySwitch(p, cfg(), new Date('2026-11-27T17:00:00Z'))
    const after = JSON.parse(readFileSync(p, 'utf8'))
    expect(after.orgModels).toEqual({ b3219c9b: ['claude-fable-5-2'] })
    expect(after.enabled).toBe(true)
    expect(after.weekBrakeUtil).toBe(0.98)
    expect(String(after._comment_fable_switch)).toContain('Откат')
    expect(JSON.parse(readFileSync(backup, 'utf8')).orgModels.f9420373).toEqual(['claude-fable-5-2'])
    expect(readdirSync(dir).some(f => f.includes('backup-fable-switch'))).toBe(true)
  })
})
