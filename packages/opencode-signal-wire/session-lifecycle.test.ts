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
