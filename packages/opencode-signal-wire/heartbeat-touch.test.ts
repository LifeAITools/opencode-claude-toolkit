/**
 * След жизни сессии opencode (договор стыка signal-wire, часть 5:
 * /home/relishev/packages/signal-wire-core/docs/harness-adapter-contract.md).
 *
 * Без отметки поверхность Telegram отвечала фаундеру «агента сейчас нет» про живого агента
 * opencode (пилот vibe-synqtalk-owner, 30.09.2026): у Claude Code и dsh файлы
 * session-heartbeat-*.json были, у opencode — ни одного.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { heartbeatPath } from '@kiberos/signal-wire-core'
import { SignalWire } from './signal-wire'

process.env.SW_EXEC_OFF = '1'

function dir(): string {
  return process.env.SW_HEARTBEAT_DIR!
}
function make(sessionId: string): SignalWire {
  return new SignalWire({ serverUrl: 'http://127.0.0.1:0', sessionId, rulesPath: join(dir(), 'none.json'), platform: 'opencode' })
}
function event(sessionId: string, type = 'chat.message') {
  return { source: 'plugin', type, sessionId, timestamp: Date.now(), payload: {} } as any
}

describe('opencode: след жизни на каждом событии', () => {
  test('прогон пишет в песочницу, а не в общий каталог флота', () => {
    expect(dir()).toBeTruthy()
    expect(dir()).not.toBe(join(homedir(), '.claude', 'hooks', 'state'))
  })

  test('событие конвейера кладёт отметку с harness=opencode и своим событием', async () => {
    const sid = 'ses_heartbeat_test'
    const sw = make(sid)
    await sw.evaluateHook(event(sid, 'tool.after'))
    const p = heartbeatPath(dir(), sid)
    expect(existsSync(p)).toBe(true)
    const hb = JSON.parse(readFileSync(p, 'utf-8'))
    expect(hb.harness).toBe('opencode')
    expect(hb.session_id).toBe(sid)
    expect(hb.event).toBe('tool.after')
    expect(hb.cwd).toBe(process.cwd())
    expect(hb.context_measured).toBe(false)
  })

  test('замеренный контекст едет в отметку числами', async () => {
    const sid = 'ses_heartbeat_ctx'
    const sw = make(sid)
    sw.trackModel('claude-sonnet-5')
    sw.trackTokens({ inputTokens: 1000, cacheReadInputTokens: 49000 })
    await sw.evaluateHook(event(sid))
    const hb = JSON.parse(readFileSync(heartbeatPath(dir(), sid), 'utf-8'))
    expect(hb.context_measured).toBe(true)
    expect(hb.context_tokens).toBe(50000)
    expect(hb.context_model).toBe('claude-sonnet-5')
  })

  test('без номера сессии отметки нет', async () => {
    const sw = make('unknown')
    await sw.evaluateHook(event('unknown'))
    expect(existsSync(heartbeatPath(dir(), 'unknown'))).toBe(false)
  })
})
