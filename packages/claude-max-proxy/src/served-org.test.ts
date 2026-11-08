/**
 * `GET /admin/served-org` — кто РЕАЛЬНО обслужил сессию. Повод: подвал агента брал организацию
 * из `KIBEROS_GO_ORG` процесса, а у части агентов переменной нет — и печаталась организация по
 * членству, не совпадающая с фактической (замер 26.10: карточка `ruslan@elishev.com`,
 * обслуга `luxeresit@gmail.com`).
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { servedOrgOf, servedOrgBatch, SERVED_ORG_BATCH_MAX } from './modules/admin.js'

const day = () => new Date().toISOString().slice(0, 10)

describe('обслуженная организация из журнала двери', () => {
  test('берётся ПОСЛЕДНЯЯ запись сессии, а не первая', () => {
    const dir = mkdtempSync(join(tmpdir(), 'served-'))
    process.env.PROVIDER_DUMP_DIR = dir
    writeFileSync(join(dir, `${day()}.jsonl`), [
      JSON.stringify({ session_id: 'ses_x', org_id: 'hello@a.com', org_source: 'quota', ts: new Date().toISOString() }),
      JSON.stringify({ session_id: 'ses_other', org_id: 'hello@b.com', org_source: 'pin', ts: new Date().toISOString() }),
      JSON.stringify({ session_id: 'ses_x', org_id: 'hello@c.com', org_source: 'pin', ts: new Date().toISOString() }),
    ].join('\n'))
    const r = servedOrgOf('ses_x')
    expect(r.found).toBe(true)
    expect(r.org).toBe('hello@c.com')
    expect(r.source).toBe('pin')
  })

  test('нет записи — честное found:false, а не организация по умолчанию', () => {
    const dir = mkdtempSync(join(tmpdir(), 'served-'))
    process.env.PROVIDER_DUMP_DIR = dir
    writeFileSync(join(dir, `${day()}.jsonl`), '')
    expect(servedOrgOf('ses_none')).toEqual({ found: false, session: 'ses_none' })
  })

  // 06.11.2026: у OpenDesign своей двери Go нет, и `org_id` писала только она — такие
  // сессии навсегда оставались found:false. Теперь дверь OpenDesign пишет ту же запись,
  // и контракт отвечает одинаково, не зная, какая дверь обслужила.
  test('запись двери OpenDesign отвечает тем же контрактом: org_id — аккаунт человека', () => {
    const dir = mkdtempSync(join(tmpdir(), 'served-'))
    process.env.PROVIDER_DUMP_DIR = dir
    writeFileSync(join(dir, `${day()}.jsonl`), JSON.stringify({
      v: 1, ts: new Date().toISOString(), host: 'local',
      door: 'proxy:open-design', provider: 'open-design',
      org_id: 'relishev@gmail.com', org_source: 'pin',
      model: 'deepseek-v4.1-flash', session_id: 'ses_od',
    }) + '\n')
    const r = servedOrgOf('ses_od')
    expect(r.found).toBe(true)
    expect(r.org).toBe('relishev@gmail.com')
    expect(r.source).toBe('pin')
  })
})

describe('батч: 105 сессий одним проходом, отсутствие НАЗВАНО', () => {
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), 'served-batch-'))
    process.env.PROVIDER_DUMP_DIR = dir
    return dir
  }

  test('каждый запрошенный id в ответе; ненайденное — в unknown, со статусом no_choice_yet', () => {
    const dir = fresh()
    const now = new Date().toISOString()
    writeFileSync(join(dir, `${day()}.jsonl`), [
      JSON.stringify({ session_id: 'ses_a', org_id: 'hello@a.com', org_source: 'pin', ts: now }),
      JSON.stringify({ session_id: 'ses_b', org_id: 'hello@b.com', org_source: 'quota', ts: now }),
    ].join('\n'))
    const r = servedOrgBatch(['ses_a', 'ses_b', 'ses_missing'])
    expect(r.results.map(e => e.session)).toEqual(['ses_a', 'ses_b', 'ses_missing'])
    expect(r.results[0].org).toBe('hello@a.com')
    expect(r.results[1].source).toBe('quota')
    expect(r.results[2]).toEqual({ found: false, session: 'ses_missing', status: 'no_choice_yet' })
    expect(r.unknown).toEqual(['ses_missing'])
  })

  test('берётся ПОСЛЕДНЯЯ запись каждой сессии — как и одиночный путь', () => {
    const dir = fresh()
    const now = new Date().toISOString()
    writeFileSync(join(dir, `${day()}.jsonl`), [
      JSON.stringify({ session_id: 'ses_x', org_id: 'hello@old.com', org_source: 'quota', ts: now }),
      JSON.stringify({ session_id: 'ses_y', org_id: 'hello@y.com', org_source: 'pin', ts: now }),
      JSON.stringify({ session_id: 'ses_x', org_id: 'hello@new.com', org_source: 'pin', ts: now }),
    ].join('\n'))
    const r = servedOrgBatch(['ses_x', 'ses_y'])
    expect(r.results[0].org).toBe('hello@new.com')
    expect(r.results[0].status).toBe('found')
  })

  test('запись есть, а организации в ней нет — статус unknown, а не no_choice_yet', () => {
    const dir = fresh()
    const now = new Date().toISOString()
    writeFileSync(join(dir, `${day()}.jsonl`), JSON.stringify({ session_id: 'ses_nul', org_id: null, ts: now }) + '\n')
    const r = servedOrgBatch(['ses_nul'])
    expect(r.results[0].found).toBe(false)
    expect(r.results[0].status).toBe('unknown')
    expect(r.unknown).toEqual(['ses_nul'])
  })

  test('пустые и повторные id не раздувают ответ', () => {
    const dir = fresh()
    writeFileSync(join(dir, `${day()}.jsonl`), '')
    const r = servedOrgBatch(['', 'ses_a', 'ses_a', '  '])
    expect(r.results.map(e => e.session)).toEqual(['ses_a'])
  })

  test('потолок батча ограничивает работу', () => {
    const dir = fresh()
    writeFileSync(join(dir, `${day()}.jsonl`), '')
    const ids = Array.from({ length: SERVED_ORG_BATCH_MAX + 5 }, (_, i) => `ses_${i}`)
    const r = servedOrgBatch(ids)
    expect(r.results.length).toBe(SERVED_ORG_BATCH_MAX)
  })
})
