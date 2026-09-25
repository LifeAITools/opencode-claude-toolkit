/**
 * Имя агента доезжает до правил в opencode (договор стыка signal-wire, часть 2:
 * /home/relishev/packages/signal-wire-core/docs/harness-adapter-contract.md).
 *
 * Правило может быть адресовано одному агенту условием `runtime_meta_is: {agentName}` (ядро ≥ 0.12.0,
 * первое такое — строка «доступ мёртв» для владельца torq). В Claude Code имя кладёт батч хука, а
 * в opencode `runtimeMeta.agentName` не заполнял никто — адресованное правило здесь молчало всегда.
 * Под kiberos `SYNQTASK_AGENT_ID` — ИМЯ агента в окружении этого же процесса.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'
const saved = process.env.SYNQTASK_AGENT_ID
afterEach(() => {
  if (saved === undefined) delete process.env.SYNQTASK_AGENT_ID
  else process.env.SYNQTASK_AGENT_ID = saved
})

const dir = mkdtempSync(join(tmpdir(), 'oc-agent-name-'))
const rulesPath = join(dir, 'rules.json')
writeFileSync(rulesPath, JSON.stringify({
  rules: [{
    id: 'только-для-адресата',
    events: ['chat.message'],
    match: { runtime_meta_is: { agentName: 'vibe-torq-platform-owner' } },
    actions: [{ type: 'hint', text: 'АДРЕСОВАНО {agentName}' }],
  }],
}))

function make(): SignalWire {
  return new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId: 'ses_agentname', rulesPath, platform: 'opencode' })
}
function event() {
  return { source: 'plugin', type: 'chat.message', sessionId: 'ses_agentname', timestamp: Date.now(), payload: { message: { role: 'user' }, channels: { user_text: 'привет' } } } as any
}
function hints(results: any[]): string {
  return results.filter((r) => r?.type === 'hint').map((r) => r.hintText ?? '').join('\n')
}

describe('opencode: имя агента в runtimeMeta', () => {
  test('под kiberos имя едет в runtimeMeta.agentName', () => {
    process.env.SYNQTASK_AGENT_ID = 'vibe-torq-platform-owner'
    expect(make().getCurrentRuntimeMeta().agentName).toBe('vibe-torq-platform-owner')
  })

  test('без имени в окружении поля нет — «не знаю», а не выдуманное имя', () => {
    delete process.env.SYNQTASK_AGENT_ID
    expect('agentName' in make().getCurrentRuntimeMeta()).toBe(false)
  })

  test('правило, адресованное агенту, срабатывает у него и молчит у другого', async () => {
    process.env.SYNQTASK_AGENT_ID = 'vibe-torq-platform-owner'
    expect(hints(await make().evaluateHook(event()))).toContain('АДРЕСОВАНО vibe-torq-platform-owner')
    process.env.SYNQTASK_AGENT_ID = 'packages-signal-wire-core-owner'
    expect(hints(await make().evaluateHook(event()))).not.toContain('АДРЕСОВАНО')
  })
})

process.on('exit', () => rmSync(dir, { recursive: true, force: true }))
