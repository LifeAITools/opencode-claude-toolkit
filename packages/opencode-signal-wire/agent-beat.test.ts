/**
 * Переходы хода в дверь `context agent beat` (заявка lat-context + signal-wire, 13.11.2026).
 * Испытания без единого настоящего вызова `context`: запуск подменяется, кроме одного, где
 * дверь заменена скриптом-неудачником — чтобы проверить, что провал НАЗЫВАЕТСЯ в журнале.
 */
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentBeatArgs, emitAgentBeat } from './agent-beat'

function fakeSpawn(calls: Array<{ cmd: string; args: string[]; opts: any }>) {
  return ((cmd: string, args: string[], opts: any) => {
    calls.push({ cmd, args, opts })
    const ch = new EventEmitter() as any
    ch.unref = () => {}
    return ch
  }) as any
}

describe('agent beat — форма и границы', () => {
  test('форма двери: --binding, --event, --cwd', () => {
    expect(agentBeatArgs('b1', 'chat.message', '/p')).toEqual(
      ['agent', 'beat', '--binding', 'b1', '--event', 'chat.message', '--cwd', '/p'])
    expect(agentBeatArgs('b1', 'session.idle')).toEqual(['agent', 'beat', '--binding', 'b1', '--event', 'session.idle'])
  })

  test('без привязки — ни вызова, ни строки в журнале (простой opencode)', () => {
    const calls: any[] = []; const logs: any[] = []
    const ok = emitAgentBeat('chat.message', {
      env: {}, resolveBin: () => '/x/context', log: (s, d) => logs.push([s, d]), spawn: fakeSpawn(calls),
    })
    expect(ok).toBe(false); expect(calls).toHaveLength(0); expect(logs).toHaveLength(0)
  })

  test('с привязкой — фоновый запуск под timeout, отвязанный от процесса', () => {
    const calls: any[] = []
    const ok = emitAgentBeat('session.idle', {
      env: { KIBEROS_BINDING_ID: 'vibe_x_owner_01' }, resolveBin: () => '/x/context', cwd: '/proj',
      log: () => {}, spawn: fakeSpawn(calls),
    })
    expect(ok).toBe(true)
    expect(calls[0].cmd).toBe('timeout')
    expect(calls[0].args).toEqual(['5', '/x/context', 'agent', 'beat', '--binding', 'vibe_x_owner_01', '--event', 'session.idle', '--cwd', '/proj'])
    expect(calls[0].opts).toMatchObject({ detached: true, stdio: 'ignore' })
  })

  test('нет `context` — провал назван, ход не падает', () => {
    const logs: any[] = []
    const ok = emitAgentBeat('chat.message', {
      env: { KIBEROS_BINDING_ID: 'b' }, resolveBin: () => null, log: (s, d) => logs.push([s, d]),
    })
    expect(ok).toBe(false)
    expect(logs[0][0]).toBe('AGENT_BEAT_FAILED')
    expect(logs[0][1]).toMatchObject({ reason: 'context_not_found', event: 'chat.message' })
  })

  test('запуск бросил — провал назван, исключение не вылетает', () => {
    const logs: any[] = []
    const ok = emitAgentBeat('session.start', {
      env: { KIBEROS_BINDING_ID: 'b' }, resolveBin: () => '/x/context',
      log: (s, d) => logs.push([s, d]), spawn: (() => { throw new Error('EMFILE') }) as any,
    })
    expect(ok).toBe(false)
    expect(logs[0][1]).toMatchObject({ reason: 'throw', error: 'EMFILE' })
  })

  test('дверь вернула ненулевой код — провал назван в журнале (настоящий запуск)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-beat-'))
    const bin = join(dir, 'context')
    writeFileSync(bin, '#!/bin/sh\nexit 3\n'); chmodSync(bin, 0o755)
    const logs: any[] = []
    const done = new Promise<void>(resolve => {
      emitAgentBeat('chat.message', {
        env: { KIBEROS_BINDING_ID: 'b' }, resolveBin: () => bin,
        log: (s, d) => { logs.push([s, d]); resolve() },
      })
    })
    await Promise.race([done, new Promise(r => setTimeout(r, 3000))])
    expect(logs[0]?.[1]).toMatchObject({ reason: 'nonzero_exit', code: 3 })
  })
})
