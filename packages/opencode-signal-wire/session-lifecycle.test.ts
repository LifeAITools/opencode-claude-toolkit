/**
 * Дыры доктрины: старт сессии и провал вызова (session-lifecycle.ts).
 * Формы событий — из типов SDK opencode (created: properties.info;
 * part.updated: properties.part со state).
 */
import { describe, expect, test } from 'bun:test'
import { createSessionStartTracker, extractSessionId, failureFromPartUpdated } from './session-lifecycle'

describe('старт сессии из session.created', () => {
  test('номер берётся из любой оболочки (info/session/плоское)', () => {
    expect(extractSessionId({ type: 'session.created', properties: { info: { id: 'ses_a' } } })).toBe('ses_a')
    expect(extractSessionId({ type: 'session.created', properties: { session: { id: 'ses_b' } } })).toBe('ses_b')
    expect(extractSessionId({ type: 'x', properties: { sessionID: 'ses_c' } })).toBe('ses_c')
    expect(extractSessionId({ type: 'x', payload: { sessionId: 'ses_d' } })).toBe('ses_d')
    expect(extractSessionId({ type: 'x', properties: {} })).toBeNull()
    expect(extractSessionId(null)).toBeNull()
  })

  test('первый created — старт, повторы и unknown — нет', () => {
    const first = createSessionStartTracker()
    expect(first('ses_a')).toBe(true)
    expect(first('ses_a')).toBe(false)
    expect(first('ses_b')).toBe(true)
    expect(first('unknown')).toBe(false)
    expect(first(null)).toBe(false)
    expect(first('')).toBe(false)
  })
})

describe('провал вызова из message.part.updated', () => {
  const errPart = (state: any, extra: any = {}) => ({
    type: 'message.part.updated',
    properties: { part: { type: 'tool', sessionID: 'ses_p', messageID: 'm', callID: 'c1', tool: 'Bash', state, ...extra } },
  })

  test('error-часть → tool.failure канонической формы', () => {
    expect(failureFromPartUpdated(errPart({ status: 'error', input: { command: 'false' }, error: 'exit 1' }))).toEqual({
      sessionId: 'ses_p', tool: 'Bash', callID: 'c1', args: { command: 'false' }, error: 'exit 1',
    })
  })

  test('не ошибка, не tool, чужое событие — null', () => {
    expect(failureFromPartUpdated(errPart({ status: 'completed' }))).toBeNull()
    expect(failureFromPartUpdated(errPart({ status: 'running' }))).toBeNull()
    expect(failureFromPartUpdated({ type: 'message.part.updated', properties: { part: { type: 'text' } } })).toBeNull()
    expect(failureFromPartUpdated({ type: 'message.updated', properties: {} })).toBeNull()
    expect(failureFromPartUpdated({ type: 'message.part.updated', properties: {} })).toBeNull()
  })

  test('пустой текст ошибки и отсутствующий ввод — заглушки, а не падение', () => {
    expect(failureFromPartUpdated(errPart({ status: 'error' }))).toMatchObject({ error: expect.any(String), args: null })
    expect(failureFromPartUpdated(errPart({ status: 'error', error: '' }, { tool: '' }))).toBeNull()
  })
})

describe('ошибка сессии дословно', () => {
  test('session.error с объектом ошибки — как есть', async () => {
    const { errorFromSessionError } = await import('./session-lifecycle')
    const err = { type: 'ApiError', message: 'boom' }
    expect(errorFromSessionError({ type: 'session.error', properties: { sessionID: 'ses_e', error: err } }))
      .toEqual({ sessionId: 'ses_e', error: err })
  })

  test('чужое событие, нет сессии, нет ошибки — null', async () => {
    const { errorFromSessionError } = await import('./session-lifecycle')
    expect(errorFromSessionError({ type: 'session.idle', properties: {} })).toBeNull()
    expect(errorFromSessionError({ type: 'session.error', properties: {} })).toBeNull()
    expect(errorFromSessionError({ type: 'session.error', properties: { sessionID: 's' } })).toBeNull()
  })
})

describe('человек и конец (PRP 08)', () => {
  test('asked без инструмента, answered с видом из памяти, end без причины', async () => {
    const m = await import('./session-lifecycle')
    expect(m.askedFromPermissionUpdated({
      type: 'permission.updated',
      properties: { id: 'p1', sessionID: 'ses_h', title: 'Run bun test?' },
    })).toEqual({ sessionId: 'ses_h', kind: 'permission', message: 'Run bun test?', requestId: 'p1' })
    expect(m.askedFromPermissionUpdated({ type: 'permission.updated', properties: {} })).toBeNull()
    const mem = m.createPermissionKindMemory(2)
    mem.remember('p1', 'permission')
    expect(m.answeredFromPermissionReplied(
      { type: 'permission.replied', properties: { sessionID: 'ses_h', permissionID: 'p1', response: 'allow-once' } },
      mem.recall,
    )).toEqual({ sessionId: 'ses_h', kind: 'permission', outcome: 'allow-once', requestId: 'p1' })
    expect(m.answeredFromPermissionReplied(
      { type: 'permission.replied', properties: { sessionID: 'ses_h', permissionID: 'nope', response: 'deny' } },
      mem.recall,
    )).toMatchObject({ kind: 'permission', outcome: 'deny' })
    expect(m.endFromSessionDeleted({ type: 'session.deleted', properties: { info: { id: 'ses_gone' } } }))
      .toEqual({ sessionId: 'ses_gone' })
    expect(m.endFromSessionDeleted({ type: 'session.deleted', properties: {} })).toBeNull()
  })

  test('память видов вытесняет старые', async () => {
    const m = await import('./session-lifecycle')
    const mem = m.createPermissionKindMemory(2)
    mem.remember('a', 'permission')
    mem.remember('b', 'permission')
    mem.remember('c', 'permission')
    expect(mem.recall('a')).toBeNull()
    expect(mem.recall('c')).toBe('permission')
  })
})

describe('след потока (PRP 09)', () => {
  test('текстовая дельта и конец сообщения', async () => {
    const m = await import('./session-lifecycle')
    expect(m.streamDeltaFromPartUpdated({
      type: 'message.part.updated',
      properties: { part: { type: 'text', sessionID: 'ses_s', text: 'helloworld' }, delta: 'world' },
    })).toEqual({ sessionId: 'ses_s', text: 'world' })
    expect(m.streamDeltaFromPartUpdated({
      type: 'message.part.updated', properties: { part: { type: 'text', sessionID: 's', text: 'x' } },
    })).toBeNull()
    expect(m.streamDeltaFromPartUpdated({
      type: 'message.part.updated',
      properties: { part: { type: 'tool', sessionID: 's', state: { status: 'error' } }, delta: 'x' },
    })).toBeNull()
    expect(m.messageEndFromMessageUpdated({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: 'ses_s', time: { created: 1, completed: 2 } } },
    })).toEqual({ sessionId: 'ses_s' })
    expect(m.messageEndFromMessageUpdated({
      type: 'message.updated',
      properties: { info: { role: 'assistant', sessionID: 'ses_s', time: { created: 1 } } },
    })).toBeNull()
    expect(m.messageEndFromMessageUpdated({
      type: 'message.updated',
      properties: { info: { role: 'user', sessionID: 'ses_s', time: { created: 1, completed: 2 } } },
    })).toBeNull()
  })
})
