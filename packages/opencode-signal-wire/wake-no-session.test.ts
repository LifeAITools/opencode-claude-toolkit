/**
 * A wake to an opencode window with NO session must open one, not queue forever.
 *
 * Measured 2026-09-25 by home-relishev-general's probe (pid 2894815): the listener
 * accepted the wake, logged "no session ID yet", queued it and answered
 * {accepted, queued} — the router counted it delivered, no turn ever came.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { _setInjectStateForTests, _injectWakeEventForTests } from './wake-listener'
import type { WakeEvent } from './wake-types'

const DIR = '/work/agent-dir'
const event = { eventId: 'e1', type: 'channel_message', source: 'test', priority: 'normal', payload: {} } as unknown as WakeEvent

function fakeClient(existing: Array<{ id: string; directory: string }>) {
  const calls = { create: 0, prompt: [] as string[] }
  const client = {
    session: {
      list: async () => ({ data: existing }),
      create: async (o: any) => { calls.create++; expect(o.query.directory).toBe(DIR); return { data: { id: 'new-session' } } },
      promptAsync: async (o: any) => { calls.prompt.push(o.path.id); return {} },
    },
  }
  return { client, calls }
}

afterEach(() => _setInjectStateForTests(null))

describe('wake into a window with no session', () => {
  test('no session in the directory → one is opened and the wake lands there', async () => {
    const { client, calls } = fakeClient([{ id: 'other', directory: '/elsewhere' }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR })
    expect(await _injectWakeEventForTests(event, 'unknown')).toBe('ok')
    expect(calls.create).toBe(1)
    expect(calls.prompt).toEqual(['new-session'])
  })

  test('several sessions in the directory → ambiguous, nothing is opened, reason no_session', async () => {
    const { client, calls } = fakeClient([{ id: 'a', directory: DIR }, { id: 'b', directory: DIR }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR })
    expect(await _injectWakeEventForTests(event, 'unknown')).toBe('no_session')
    expect(calls.create).toBe(0)
    expect(calls.prompt).toEqual([])
  })

  test('a known session → used as is, nothing is opened', async () => {
    const { client, calls } = fakeClient([])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR })
    expect(await _injectWakeEventForTests(event, 'known-session')).toBe('ok')
    expect(calls.create).toBe(0)
    expect(calls.prompt).toEqual(['known-session'])
  })
})
