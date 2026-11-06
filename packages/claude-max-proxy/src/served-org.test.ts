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
import { servedOrgOf } from './modules/admin.js'

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
