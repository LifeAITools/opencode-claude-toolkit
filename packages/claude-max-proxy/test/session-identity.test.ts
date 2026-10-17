/**
 * session-identity — единое правило опознания сессии по поставщику (FR-19 / D3).
 *
 * Двери узнают разговор разными носителями, но правило одно: заголовок → тело →
 * производный номер → честное «не опознан». Эти испытания держат ПРАВИЛО, а не
 * двери: порядок дверей, отказ читать тело, когда победил заголовок, и то, что
 * «не опознан» — отдельный исход, а не выдуманный номер.
 */

import { describe, test, expect } from 'bun:test'
import { resolveSessionIdentity, toEngineIdSource } from '../src/session-identity.js'

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
