/**
 * След жизни сессии opencode (договор стыка signal-wire, часть 5:
 * /home/relishev/packages/signal-wire-core/docs/harness-adapter-contract.md).
 *
 * С ядра 0.16 отметку ставит сам конвейер (`lifeTrace`), адаптер только объявляет программу.
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
  test('прогон пишет в песочницу, а не в общий каталог флота, и не привязывает сессии', () => {
    expect(dir()).toBeTruthy()
    expect(dir()).not.toBe(join(homedir(), '.claude', 'hooks', 'state'))
    expect(process.env.KIBEROS_BINDING_ID).toBeUndefined()
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

  test('замеренный расход едет в отметку объектом дословно (ядро ≥0.24.0)', async () => {
    const sid = 'ses_heartbeat_spend'
    const sw = make(sid)
    sw.trackSpend({ inputTokens: 300, outputTokens: 30, reasoningTokens: 5, cost: 0.003, currency: 'USD', measuredAt: '2026-10-06T06:00:00.000Z' })
    await sw.evaluateHook(event(sid))
    const hb = JSON.parse(readFileSync(heartbeatPath(dir(), sid), 'utf-8'))
    expect(hb.spend).toEqual({ inputTokens: 300, outputTokens: 30, reasoningTokens: 5, cost: 0.003, currency: 'USD', measuredAt: '2026-10-06T06:00:00.000Z' })
  })

  test('без замера расхода ключа spend нет — а не ноль', async () => {
    const sid = 'ses_heartbeat_nospend'
    const sw = make(sid)
    await sw.evaluateHook(event(sid))
    const hb = JSON.parse(readFileSync(heartbeatPath(dir(), sid), 'utf-8'))
    expect('spend' in hb).toBe(false)
  })

  test('окна поставщиков едут в отметку из плоского ключа (ядро ≥0.25.0)', async () => {
    const sid = 'ses_heartbeat_windows'
    const sw = make(sid)
    const w1 = { kind: '5h', util: 0, measuredAt: '2026-10-06T06:00:00.000Z' }
    const w2 = { kind: '7d', util: 0.16, resetAt: '2026-10-07T00:00:00.000Z', measuredAt: '2026-10-06T06:00:00.000Z' }
    sw.trackProviderQuota([{ provider: 'zai', measuredAt: '2026-10-06T06:00:00.000Z', limits: [], windows: [w1, w2] }])
    await sw.evaluateHook(event(sid))
    const hb = JSON.parse(readFileSync(heartbeatPath(dir(), sid), 'utf-8'))
    expect(hb.windows).toEqual([w1, w2])
  })

  test('без лимитов ключа windows нет — а не пустой список', async () => {
    const sid = 'ses_heartbeat_nowindows'
    const sw = make(sid)
    await sw.evaluateHook(event(sid))
    const hb = JSON.parse(readFileSync(heartbeatPath(dir(), sid), 'utf-8'))
    expect('windows' in hb).toBe(false)
  })
  test('без номера сессии отметки нет — ни от заглушки unknown, ни от пустого', async () => {
    const sw = make('unknown')
    await sw.evaluateHook(event('unknown'))
    await sw.evaluate({ event: 'chat.message', prompt: 'x' } as any)
    await new Promise((r) => setTimeout(r, 20))
    expect(existsSync(heartbeatPath(dir(), 'unknown'))).toBe(false)
    expect(existsSync(heartbeatPath(dir(), 'opencode-claude'))).toBe(false)
  })

  test('след ставит конвейер ядра: harness объявлен один раз, а не своим вызовом адаптера', () => {
    const src = readFileSync(join(import.meta.dir, 'signal-wire.ts'), 'utf-8')
    expect(src).toContain('lifeTraceFromEnv(HARNESS.OPENCODE)')
    expect(src).not.toMatch(/touchHeartbeat\(/)
  })
})
