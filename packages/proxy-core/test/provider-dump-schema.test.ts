/**
 * provider-dump/v1 — контракт схемы дампа в коде (FR-21/D6).
 *
 * Валидатор держит НЕСУЩИЕ поля — те, по которым сборщик картины судит и
 * группирует. Последнее испытание читает ЖИВУЮ запись с машины: контракт обязан
 * проходить на том, что реально пишут двери (нет дампа — испытание пропускается,
 * чтобы прогон не зависел от машины).
 */

import { describe, test, expect } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { validateDumpRecord, DUMP_SCHEMA_VERSION, SECRET_HEADERS } from '../src/provider-dump-schema.js'

function goodRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: DUMP_SCHEMA_VERSION,
    ts: '2026-10-15T22:03:00.000Z',
    host: 'local',
    door: 'proxy:opencode-go',
    provider: 'opencode-go',
    call_kind: 'real',
    request: { method: 'POST' },
    response: { status: 200 },
    usage_norm: {},
    quota_seen: {},
    timing: {},
    error: null,
    ...over,
  }
}

describe('provider-dump/v1 — контракт в коде (FR-21/D6)', () => {
  test('хорошая запись проходит без единой ошибки', () => {
    expect(validateDumpRecord(goodRecord())).toEqual({ ok: true, errors: [] })
  })

  test('не объект — отказ, а не тихий пропуск', () => {
    expect(validateDumpRecord(null).ok).toBe(false)
    expect(validateDumpRecord('x').ok).toBe(false)
    expect(validateDumpRecord([]).ok).toBe(false)
  })

  test('чужая версия схемы НАЗВАНА (это и есть точка подъёма версии)', () => {
    const v = validateDumpRecord(goodRecord({ v: 2 }))
    expect(v.ok).toBe(false)
    expect(v.errors.join(' ')).toContain(`v должен быть ${DUMP_SCHEMA_VERSION}`)
  })

  test('call_kind вне словаря назван', () => {
    const v = validateDumpRecord(goodRecord({ call_kind: 'bogus' }))
    expect(v.ok).toBe(false)
    expect(v.errors.join(' ')).toContain('call_kind')
  })

  test('несущие поля: пустые door/provider — ошибки с именами', () => {
    expect(validateDumpRecord(goodRecord({ door: '' })).errors).toContain('door — непустая строка')
    expect(validateDumpRecord(goodRecord({ provider: '' })).errors).toContain('provider — непустая строка')
  })

  test('секретные заголовки объявлены контрактом (писатель режет по нему)', () => {
    for (const h of ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']) {
      expect(SECRET_HEADERS.has(h)).toBe(true)
    }
  })

  test('ЖИВАЯ запись с машины проходит (нет дампа — пропуск)', () => {
    const dir = join(homedir(), '.claude-local', 'provider-dump')
    if (!existsSync(dir)) return
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'))
    if (files.length === 0) return
    let checked = 0
    for (const f of files.slice(-3)) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue
        expect(validateDumpRecord(JSON.parse(line)).errors).toEqual([])
        checked++
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})
