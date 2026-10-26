/**
 * Спут тела переехал из хука посредника (его снимут) в дверь 26.10.2026: хук узнавал Go-модели
 * по credential-имени, которого у модели больше нет. Полюс — тот же: последнее тело на сессию
 * есть единственный ответ на «что именно изменилось в префиксе».
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spoolPayload, spoolSweep, spoolWrite } from './modules/go-door.js'

const body = (over: Record<string, unknown> = {}) => ({
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'x' }],
  tools: [{ type: 'function' }],
  max_tokens: 10,
  stream: true,
  api_key: 'SECRET',
  metadata: { secret: 1 },
  ...over,
})

describe('спут тела: только поля префикса', () => {
  test('служебное и секреты в файл не едут', () => {
    const p = spoolPayload(body())
    expect(p).toBeTruthy()
    expect(p!.model).toBe('deepseek-v4.1-flash')
    expect(p!.messages).toBeTruthy()
    expect('stream' in p!).toBe(false)
    expect('api_key' in p!).toBe(false)
    expect('metadata' in p!).toBe(false)
  })

  test('тело без сообщений и без system не пишется', () => {
    expect(spoolPayload({ model: 'm', max_tokens: 1 })).toBeNull()
    expect(spoolPayload(null)).toBeNull()
  })

  test('пишется последнее на сессию, предыдущее уезжает в .prev', () => {
    const d = mkdtempSync(join(tmpdir(), 'spool-'))
    spoolWrite(d, 'ses_A', spoolPayload(body({ max_tokens: 1 }))!)
    spoolWrite(d, 'ses_A', spoolPayload(body({ max_tokens: 2 }))!)
    const names = readdirSync(d).sort()
    expect(names).toEqual(['ses_A.json', 'ses_A.prev.json'])
    expect(JSON.parse(readFileSync(join(d, 'ses_A.json'), 'utf8')).max_tokens).toBe(2)
    expect(JSON.parse(readFileSync(join(d, 'ses_A.prev.json'), 'utf8')).max_tokens).toBe(1)
  })

  test('уборка уносит старое по TTL', () => {
    const d = mkdtempSync(join(tmpdir(), 'spool-'))
    const f = join(d, 'old.json')
    writeFileSync(f, '{}')
    const longAgo = (Date.now() - 10 * 3600 * 1000) / 1000
    utimesSync(f, longAgo, longAgo)
    spoolWrite(d, 'fresh', spoolPayload(body())!)
    spoolSweep(d, Date.now())
    expect(readdirSync(d).sort()).toEqual(['fresh.json'])
  })
})
