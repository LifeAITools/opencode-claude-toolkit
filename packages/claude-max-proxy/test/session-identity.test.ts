/**
 * session-identity — единое правило опознания сессии по поставщику (FR-19 / D3).
 *
 * Двери узнают разговор разными носителями, но правило одно: заголовок → тело →
 * производный номер → честное «не опознан». Эти испытания держат ПРАВИЛО, а не
 * двери: порядок дверей, отказ читать тело, когда победил заголовок, и то, что
 * «не опознан» — отдельный исход, а не выдуманный номер.
 */

import { describe, test, expect } from 'bun:test'
import { resolveSessionIdentity, toEngineIdSource, readCallerSession } from '../src/session-identity.js'

describe('resolveSessionIdentity — одна точка на все двери (FR-19/D3)', () => {
  test('заголовок — первая дверь, тело при этом НЕ читается', () => {
    let called = false
    const id = resolveSessionIdentity({
      headerValue: 'hdr-1',
      bodyText: '{"metadata":{"user_id":"u"}}',
      bodyExtractor: () => { called = true; return 'body-1' },
    })
    expect(id).toEqual({ sessionId: 'hdr-1', source: 'header' })
    expect(called).toBe(false)
  })

  test('тело — вторая дверь (у Anthropic это metadata.user_id)', () => {
    const id = resolveSessionIdentity({
      headerValue: null,
      bodyText: '{"metadata":{"user_id":"u-9"}}',
      bodyExtractor: () => 'u-9',
    })
    expect(id).toEqual({ sessionId: 'u-9', source: 'body' })
  })

  test('производный номер — законный исход двери совместимости, но НАЗВАН derived', () => {
    const id = resolveSessionIdentity({ headerValue: '  ', derive: () => 'openai-abcd1234' })
    expect(id).toEqual({ sessionId: 'openai-abcd1234', source: 'derived' })
  })

  test('нет ничего → честное «не опознан», а не выдуманный номер', () => {
    expect(resolveSessionIdentity({ headerValue: null })).toEqual({ sessionId: null, source: 'none' })
    expect(resolveSessionIdentity({ headerValue: '', bodyText: 'x', bodyExtractor: () => null }))
      .toEqual({ sessionId: null, source: 'none' })
    expect(resolveSessionIdentity({ derive: () => '   ' })).toEqual({ sessionId: null, source: 'none' })
  })

  test('тела нет — это «носителя нет», извлекатель не зовётся', () => {
    let called = false
    const id = resolveSessionIdentity({
      headerValue: null,
      bodyText: null,
      bodyExtractor: () => { called = true; return 'x' },
    })
    expect(id.source).toBe('none')
    expect(called).toBe(false)
  })

  test('toEngineIdSource: «не опознан» → none (прогрев на нём не вооружается)', () => {
    expect(toEngineIdSource('none')).toBe('none')
    expect(toEngineIdSource('header')).toBe('header')
    expect(toEngineIdSource('body')).toBe('body')
    expect(toEngineIdSource('derived')).toBe('header')
  })
})

describe('readCallerSession — имена зовущего, ИЗМЕРЕННЫЕ дампом заголовков 19.10.2026', () => {
  const h = (map: Record<string, string>) => ({ get: (n: string) => map[n] ?? null })

  test('пускатель агентов: x-opencode-session-id — узнан', () => {
    expect(readCallerSession(h({ 'x-opencode-session-id': 'ses_abc' })))
      .toEqual({ sessionId: 'ses_abc', header: 'x-opencode-session-id' })
  })

  test('дверь чата: x-litellm-session-id — узнана', () => {
    expect(readCallerSession(h({ 'x-litellm-session-id': 'ses_chat' })))
      .toEqual({ sessionId: 'ses_chat', header: 'x-litellm-session-id' })
  })

  test('🔴 x-opencode-session (без -id) — НЕ имя зовущего: дамп показал, что так не приходит', () => {
    // Прежнее чтение этой двери; разница в два знака молча оставляла сессию пускателя неопознанной.
    expect(readCallerSession(h({ 'x-opencode-session': 'ses_wrong' })))
      .toEqual({ sessionId: null, header: null })
  })

  test('имя заголовка возвращается — агентскую сессию можно отличить от разговора', () => {
    const both = readCallerSession(h({ 'x-opencode-session-id': 'ses_agent', 'x-litellm-session-id': 'ses_chat' }))
    expect(both).toEqual({ sessionId: 'ses_agent', header: 'x-opencode-session-id' })
  })

  test('пустой/пробельный заголовок — не имя; ничего нет — не опознан', () => {
    expect(readCallerSession(h({ 'x-opencode-session-id': '   ' })).sessionId).toBeNull()
    expect(readCallerSession(h({}))).toEqual({ sessionId: null, header: null })
  })
})
