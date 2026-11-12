/**
 * provider-dump — смена каталога между записями не теряет записи (12.11.2026).
 *
 * Прежний флаг «каталог создан» был булевым на весь процесс: после записи в один
 * каталог смена PROVIDER_DUMP_DIR пропускала mkdirSync, запись падала в catch и
 * исчезала молча. Так три испытания go-door проходили поодиночке и падали в полном
 * наборе. Испытание держит свойство: каждый НОВЫЙ каталог создаётся заново.
 */
import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeDump, _resetDumpForTests } from '../src/provider-dump.js'

const root = mkdtempSync(join(tmpdir(), 'dump-dir-'))
const prev = process.env.PROVIDER_DUMP_DIR
afterAll(() => {
  if (prev === undefined) delete process.env.PROVIDER_DUMP_DIR
  else process.env.PROVIDER_DUMP_DIR = prev
  _resetDumpForTests()
  rmSync(root, { recursive: true, force: true })
})

const rec = () => ({ v: 1, ts: new Date().toISOString(), door: 'test' }) as any
const settle = () => new Promise(r => setTimeout(r, 50))

describe('writeDump — каталог создаётся для каждого нового пути', () => {
  test('вторая запись после смены каталога доезжает', async () => {
    _resetDumpForTests()
    const a = join(root, 'a')
    const b = join(root, 'b')
    process.env.PROVIDER_DUMP_DIR = a
    writeDump(rec())
    process.env.PROVIDER_DUMP_DIR = b
    writeDump(rec())
    await settle()
    expect(readdirSync(a).length).toBe(1)
    expect(existsSync(b)).toBe(true)
    expect(readdirSync(b).length).toBe(1)
  })
})
