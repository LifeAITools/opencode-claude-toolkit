import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compareVersions, detectInstalledCcVersion, resolveCompatVersion } from '../src/cc-version.js'

describe('версия для чужих клиентов', () => {
  test('сравнение по числам, а не по строкам', () => {
    expect(compareVersions('2.1.280', '2.1.177')).toBeGreaterThan(0)
    expect(compareVersions('2.1.99', '2.1.100')).toBeLessThan(0)
    expect(compareVersions('2.1.177', '2.1.177')).toBe(0)
  })
  test('установленная новее настройки — берём установленную (замок Opus 5.5)', () => {
    expect(resolveCompatVersion('2.1.177', '2.1.280')).toEqual({ version: '2.1.280', source: 'installed' })
  })
  test('настройка — пол: старый установленный её не понижает, отсутствие не ломает', () => {
    expect(resolveCompatVersion('2.1.280', '2.1.177')).toEqual({ version: '2.1.280', source: 'config' })
    expect(resolveCompatVersion('2.1.177', null)).toEqual({ version: '2.1.177', source: 'config' })
  })
  test('находит версию от исполняемого файла вверх по ссылке', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccv-'))
    const pkg = join(root, 'lib/node_modules/@anthropic-ai/claude-code')
    mkdirSync(join(pkg, 'bin'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '9.9.9' }))
    writeFileSync(join(pkg, 'bin/claude.exe'), '')
    symlinkSync(join(pkg, 'bin/claude.exe'), join(root, 'claude'))
    expect(detectInstalledCcVersion([join(root, 'missing'), join(root, 'claude')])).toBe('9.9.9')
  })
  test('чужой package.json по пути не выдаётся за Claude Code', () => {
    const root = mkdtempSync(join(tmpdir(), 'ccv-'))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'something-else', version: '1.0.0' }))
    writeFileSync(join(root, 'claude'), '')
    expect(detectInstalledCcVersion([join(root, 'claude')])).toBeNull()
  })
})
