/**
 * Файловая дверь побудки opencode (wake-file-door.ts). Письмо, оставленное роутером файлом, доходит
 * ходом в единственную сессию агента и получает квитанцию; пока агент занят или сессии нет — лежит.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pollFileDoor, type FileDoorDeps } from './wake-file-door'

function setup(): { home: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'oc-file-door-'))
  const dir = join(home, '.kiberos', 'signals', 'bind_01')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'wake-0001.json')
  writeFileSync(file, JSON.stringify({ summary: 'письмо до подъёма', content: 'текст', member_id: 'm', event_id: 'e1' }))
  return { home, file }
}

function deps(home: string, over: Partial<FileDoorDeps> = {}) {
  const sent: Array<[string, string]> = []
  const receipts: string[] = []
  const d: FileDoorDeps = {
    home,
    bindingId: () => 'bind_01',
    knownSessionId: () => null,
    isBusy: async () => false,
    resolveSession: async () => 'ses_one',
    openSession: async () => null,
    send: async (sid, text) => { sent.push([sid, text]); return true },
    receipt: (w) => { receipts.push(String(w.event_id)) },
    ...over,
  }
  return { d, sent, receipts }
}

describe('opencode: файловая дверь побудки', () => {
  test('письмо доходит в сессию, квитанция уходит, файл убран', async () => {
    const { home, file } = setup()
    const { d, sent, receipts } = deps(home)
    const out = await pollFileDoor(d)
    expect(out.kind).toBe('drained')
    expect(sent).toHaveLength(1)
    expect(sent[0]![0]).toBe('ses_one')
    expect(sent[0]![1]).toContain('письмо до подъёма')
    expect(receipts).toEqual(['e1'])
    expect(existsSync(file)).toBe(false)
  })

  test('opencode не принял текст или отправка упала — письмо лежит, квитанции нет', async () => {
    for (const send of [async () => false, async () => { throw new Error('сервер недоступен') }]) {
      const { home, file } = setup()
      const { d, receipts } = deps(home, { send })
      const out = await pollFileDoor(d)
      expect(out.kind).toBe('drained')
      expect(existsSync(file)).toBe(true)
      expect(receipts).toHaveLength(0)
    }
  })

  test('агент занят — письмо лежит в файле, сервер о сессии не спрашивают', async () => {
    const { home, file } = setup()
    let asked = false
    const { d, sent } = deps(home, { isBusy: async () => true, resolveSession: async () => { asked = true; return 'ses_one' } })
    expect(await pollFileDoor(d)).toEqual({ kind: 'kept', reason: 'busy' })
    expect(asked).toBe(false)
    expect(sent).toHaveLength(0)
    expect(existsSync(file)).toBe(true)
  })

  test('сессии нет и открыть нельзя (их несколько) — письмо лежит', async () => {
    const { home, file } = setup()
    const { d, sent } = deps(home, { resolveSession: async () => null, openSession: async () => null })
    expect(await pollFileDoor(d)).toEqual({ kind: 'kept', reason: 'no_session' })
    expect(sent).toHaveLength(0)
    expect(existsSync(file)).toBe(true)
  })

  test('сессии нет — дверь открывает её и доставляет туда же', async () => {
    const { home } = setup()
    const { d, sent } = deps(home, { resolveSession: async () => null, openSession: async () => 'ses_new' })
    await pollFileDoor(d)
    expect(sent[0]![0]).toBe('ses_new')
  })

  test('писем нет — opencode не спрашивают ни о чём', async () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-file-door-empty-'))
    let touched = false
    const { d } = deps(home, { isBusy: async () => { touched = true; return false } })
    expect(await pollFileDoor(d)).toEqual({ kind: 'idle' })
    expect(touched).toBe(false)
  })

  test('без привязки и без сессии каталогов нет — idle', async () => {
    const { home } = setup()
    const { d } = deps(home, { bindingId: () => null })
    expect(await pollFileDoor(d)).toEqual({ kind: 'idle' })
  })
})
