/**
 * identity-bootstrap: личность из окружения kiberos и запоминание отказа роутера.
 *
 * Повод — замер vibe-yjs-todo-sync-owner 2026-09-24: 3 088 отказов `invalid_name` за 11 часов,
 * потому что модуль не читал личность из окружения и повторял отвергнутый запрос на каждом
 * запуске `opencode serve`. HOME подменяется ДО загрузки модуля: кэш личностей и router.json
 * ложатся во временный каталог (OPENCODE_SW_HOME), настоящий ~/.opencode не трогается.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const home = mkdtempSync(join(tmpdir(), 'ocsw-idb-'))
const savedHome = process.env.OPENCODE_SW_HOME
let calls = 0
let server: ReturnType<typeof Bun.serve>
let bootstrapIdentity: typeof import('./identity-bootstrap').bootstrapIdentity

beforeAll(async () => {
  process.env.OPENCODE_SW_HOME = home
  server = Bun.serve({
    port: 0,
    fetch() {
      calls++
      return new Response(JSON.stringify({ error: 'invalid_name' }), { status: 400 })
    },
  })
  mkdirSync(join(home, '.opencode', 'wake'), { recursive: true })
  writeFileSync(join(home, '.opencode', 'wake', 'router.json'),
    JSON.stringify({ host: '127.0.0.1', port: server.port, bootstrapKey: 'k', pid: 1, startedAt: '', version: 't' }))
  ;({ bootstrapIdentity } = await import('./identity-bootstrap'))
})
afterAll(() => {
  server?.stop(true)
  if (savedHome === undefined) delete process.env.OPENCODE_SW_HOME; else process.env.OPENCODE_SW_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
})

const cwd = '/home/x/projects/vibe/odoo-agent-surface'

describe('личность из окружения kiberos', () => {
  test('есть номер и секрет — берётся она, роутер не зовётся', async () => {
    const before = calls
    const id = await bootstrapIdentity({
      cwd,
      envOverride: { SYNQTASK_AGENT_ID: 'vibe-odoo-agent-surface-developer', SYNQTASK_AGENT_UUID: 'uuid-1', SYNQTASK_AGENT_SECRET: 's' },
    })
    expect(id?.memberId).toBe('uuid-1')
    expect(id?.secret).toBe('s')
    expect(calls).toBe(before)
  })

  test('запущен через kiberos без номера — новую личность НЕ заводим, роутер не зовётся', async () => {
    const before = calls
    const id = await bootstrapIdentity({ cwd, envOverride: { SYNQTASK_AGENT_ID: 'vibe-odoo-agent-surface-developer' } })
    expect(id).toBeNull()
    expect(calls).toBe(before)
  })
})

describe('отказ роутера запоминается', () => {
  test('первый запуск зовёт роутер и получает отказ; второй — роутер не зовётся', async () => {
    const before = calls
    expect(await bootstrapIdentity({ cwd, envOverride: {} })).toBeNull()
    expect(calls).toBe(before + 1)
    const files = readdirSync(join(home, '.opencode', 'agent-identity'), { recursive: true }).map(String)
    expect(files.some((f) => f.endsWith('.refused.json'))).toBe(true)
    expect(await bootstrapIdentity({ cwd, envOverride: {} })).toBeNull()
    expect(calls).toBe(before + 1)
  })

  test('настоящий ~/.opencode не тронут', () => {
    expect(existsSync(join(home, '.opencode', 'agent-identity'))).toBe(true)
  })
})

describe('имя по общему правилу SynqTask (@kiberos/signal-wire-core/naming)', () => {
  test('длинное имя укорачивается ровно как у kiberos — эталон из ядра', async () => {
    const { computeDeterministicKey } = await import('./identity-bootstrap')
    const { key } = computeDeterministicKey('/home/relishev/projects/vibe/odoo-agent-surface', { cwd: '/x', envOverride: {} })
    expect(key).toBe('vibe-odoo-agent-developer-1ae2a0')
    expect(key.length).toBeLessThanOrEqual(32)
  })
  test('короткое имя не меняется', async () => {
    const { computeDeterministicKey } = await import('./identity-bootstrap')
    const { key } = computeDeterministicKey('/home/relishev/packages/signal-wire-core', { cwd: '/x', envOverride: { SYNQTASK_AGENT_ROLE: 'owner' } })
    expect(key).toBe('packages-signal-wire-core-owner')
  })
})
