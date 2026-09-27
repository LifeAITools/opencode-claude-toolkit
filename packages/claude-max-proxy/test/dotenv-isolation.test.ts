/**
 * Лаунчер запускается в папке проекта агента и НЕ должен читать её .env:
 * иначе ключ самого сервиса (ANTHROPIC_API_KEY) доезжает до claude, и тот
 * встаёт на вопрос «использовать этот ключ?» (kiberos-app, 27.09, 45 минут).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { parseEnvironBlock } from '../bin/dotenv-isolation.ts'

const LAUNCHER = resolve(import.meta.dir, '..', 'bin', 'claude-max')

describe('лаунчер не читает .env папки, где его запустили', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cm-dotenv-'))
    writeFileSync(join(dir, '.env'), 'PROXY_PORT=9999\n')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const prefPort = (cmd: string[], extraEnv: Record<string, string> = {}) => {
    const env = { ...process.env, ...extraEnv } as Record<string, string>
    if (!('PROXY_PORT' in extraEnv)) delete env.PROXY_PORT
    const r = Bun.spawnSync({ cmd, cwd: dir, env })
    return r.stdout.toString().split('\n').find(l => l.includes('PREF_PORT'))?.trim()
  }

  test('запуск по шебангу', () => {
    expect(prefPort([LAUNCHER, 'config'])).toBe('PREF_PORT          5050 (default)')
  })

  test('запуск через `bun claude-max` — шебанг обойдён, лаунчер перезапускает себя', () => {
    expect(prefPort([process.execPath, LAUNCHER, 'config'])).toBe('PREF_PORT          5050 (default)')
  })

  test('переменная, заданная явно, по-прежнему действует', () => {
    expect(prefPort([process.execPath, LAUNCHER, 'config'], { PROXY_PORT: '7777' })).toBe('PREF_PORT          7777 (from env)')
  })
})

describe('разбор блока окружения', () => {
  test('значение со знаком «=» и пустые записи', () => {
    expect(parseEnvironBlock('A=1\0B=x=y\0\0=bad\0C=\0')).toEqual({ A: '1', B: 'x=y', C: '' })
  })
})
