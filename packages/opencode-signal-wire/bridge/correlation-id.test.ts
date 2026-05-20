import { describe, test, expect } from 'bun:test'
import {
  generateCorrelationId,
  propagateCorrelationId,
  readInheritedCorrelationId,
  resolveOrGenerateCorrelationId,
} from './correlation-id'
import { CORRELATION_ID_ENV_VAR } from '../domain-constants'

describe('correlation-id', () => {
  test('generateCorrelationId produces 12-char base32 string', () => {
    const id = generateCorrelationId()
    expect(id).toHaveLength(12)
    expect(id).toMatch(/^[A-Z2-7]{12}$/)
  })

  test('two consecutive generations differ (collision-free in practice)', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(generateCorrelationId())
    expect(ids.size).toBe(1000)
  })

  test('propagateCorrelationId injects env var, preserves others', () => {
    const env = propagateCorrelationId({ HOME: '/home/x', PATH: '/usr/bin' }, 'ABCDEFGH2345')
    expect(env[CORRELATION_ID_ENV_VAR]).toBe('ABCDEFGH2345')
    expect(env.HOME).toBe('/home/x')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('propagateCorrelationId drops undefined values', () => {
    const env = propagateCorrelationId({ FOO: 'bar', BAZ: undefined }, 'AAAAAAAAAAAA')
    expect(env.FOO).toBe('bar')
    expect('BAZ' in env).toBe(false)
  })

  test('readInheritedCorrelationId returns valid ID from env', () => {
    const result = readInheritedCorrelationId({ [CORRELATION_ID_ENV_VAR]: 'ABCDEFGH2345' })
    expect(result).toBe('ABCDEFGH2345')
  })

  test('readInheritedCorrelationId rejects invalid format (lowercase, wrong length, special chars)', () => {
    expect(readInheritedCorrelationId({ [CORRELATION_ID_ENV_VAR]: 'too-short' })).toBeUndefined()
    expect(readInheritedCorrelationId({ [CORRELATION_ID_ENV_VAR]: 'abcdefgh2345' })).toBeUndefined()  // lowercase
    expect(readInheritedCorrelationId({ [CORRELATION_ID_ENV_VAR]: 'ABCDEFGH!@#$' })).toBeUndefined()  // special
    expect(readInheritedCorrelationId({})).toBeUndefined()
  })

  test('resolveOrGenerateCorrelationId returns inherited when present', () => {
    const r = resolveOrGenerateCorrelationId({ [CORRELATION_ID_ENV_VAR]: 'INHERITED234' })
    expect(r).toBe('INHERITED234')
  })

  test('resolveOrGenerateCorrelationId falls back to fresh when env empty', () => {
    const r = resolveOrGenerateCorrelationId({})
    expect(r).toMatch(/^[A-Z2-7]{12}$/)
  })

  test('round-trip: generate → propagate → read returns same ID', () => {
    const fresh = generateCorrelationId()
    const childEnv = propagateCorrelationId({}, fresh)
    const inherited = readInheritedCorrelationId(childEnv)
    expect(inherited).toBe(fresh)
  })
})
