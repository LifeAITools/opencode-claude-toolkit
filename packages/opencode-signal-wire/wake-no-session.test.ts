/**
 * A wake with NO known session must reach a turn, not queue forever — and must never
 * start a SECOND conversation next to a window.
 *
 * Measured 2026-09-25 by home-relishev-general's probe (pid 2894815): the listener
 * accepted the wake, logged "no session ID yet", queued it and answered
 * {accepted, queued} — the router counted it delivered, no turn ever came.
 *
 * Measured 2026-09-30 by vibe-yjs-todo-sync-owner: the listener opened a session for a
 * wake NEXT TO the window's own (`ses_f0da8e6f…` beside `ses_f0e72908…`), and one agent
 * answered from two conversations at once, contradicting itself. So: with a window the
 * wake goes INTO the window (it opens its own session if it has none); a session is
 * opened by the listener only when there is no window (`opencode serve`).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { _setInjectStateForTests, _injectWakeEventForTests } from './wake-listener'
import type { WakeEvent } from './wake-types'

const DIR = '/work/agent-dir'
const event = { eventId: 'e1', type: 'channel_message', source: 'test', priority: 'normal', payload: {} } as unknown as WakeEvent

const WINDOW = ['opencode', '-m', 'x']
const HEADLESS = ['opencode', 'serve']

function fakeClient(existing: Array<{ id: string; directory: string }>) {
  const calls = { create: 0, prompt: [] as string[], window: [] as string[] }
  let draft = ''
  const client = {
    tui: {
      appendPrompt: async (o: any) => { draft += o.body.text; return {} },
      submitPrompt: async () => { calls.window.push(draft); draft = ''; return {} },
    },
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
  test('window, no session known → the wake goes into the window; no second session is opened', async () => {
    const { client, calls } = fakeClient([{ id: 'other', directory: '/elsewhere' }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR, argv: WINDOW })
    expect(await _injectWakeEventForTests(event, 'unknown')).toBe('ok')
    expect(calls.create).toBe(0)
    expect(calls.prompt).toEqual([])
    expect(calls.window).toHaveLength(1)
  })

  test('window, several sessions in the directory → still the window, never a guess', async () => {
    const { client, calls } = fakeClient([{ id: 'a', directory: DIR }, { id: 'b', directory: DIR }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR, argv: WINDOW })
    expect(await _injectWakeEventForTests(event, 'unknown')).toBe('ok')
    expect(calls.create).toBe(0)
    expect(calls.prompt).toEqual([])
    expect(calls.window).toHaveLength(1)
  })

  test('no window (serve), no session in the directory → one is opened and the wake lands there', async () => {
    const { client, calls } = fakeClient([{ id: 'other', directory: '/elsewhere' }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR, argv: HEADLESS })
    expect(await _injectWakeEventForTests(event, 'unknown')).toBe('ok')
    expect(calls.create).toBe(1)
    expect(calls.prompt).toEqual(['new-session'])
  })

  test('no window, several sessions → ambiguous, nothing is opened, reason no_session', async () => {
    const { client, calls } = fakeClient([{ id: 'a', directory: DIR }, { id: 'b', directory: DIR }])
    _setInjectStateForTests({ sdkClient: client, agentDirectory: DIR, argv: HEADLESS })
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
