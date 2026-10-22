/**
 * v2-register — провал регистрации обязан НАЗЫВАТЬ СЕБЯ.
 *
 * Прежний `try/catch` вокруг `reg.add` в `plugin-v2.ts` делал ошибку невидимой:
 * модель просто «недоступна», и причину нельзя было узнать ни из лога opencode,
 * ни из ответа. Здесь закреплено: текст ошибки + провайдер + модель уходят в
 * канал ошибок, а провал `add` пробрасывается наверх.
 */
import { describe, expect, test } from 'bun:test'
import { registerV2Provider, type ProviderEditorLike } from '../v2-register'
import type { V1ProviderLike } from '../v2-model'

const v1Provider: V1ProviderLike = {
  id: 'claude-max',
  name: 'Claude Max/Pro',
  api: 'http://127.0.0.1:5050',
  npm: 'file:///x/provider.js',
  models: {
    'claude-sonnet-5': {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5 (Max)',
      capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
      cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
      limit: { context: 1_000_000, output: 64_000 },
      status: 'active',
    },
  },
}

function editor(onAdd?: (definition: any) => void): { editor: ProviderEditorLike; added: any[] } {
  const added: any[] = []
  return {
    added,
    editor: {
      add(definition) {
        added.push(definition)
        onAdd?.(definition)
      },
    },
  }
}

describe('registerV2Provider — успешная запись', () => {
  test('кладёт info + массив моделей, возвращает их число', () => {
    const { editor: reg, added } = editor()
    const debug: string[] = []
    const count = registerV2Provider(reg, 'claude-max', v1Provider, {
      packageName: 'aisdk:file:///x/provider.ts',
      onError: (message) => { throw new Error(`unexpected error: ${message}`) },
      onDebug: (message) => debug.push(message),
    })
    expect(count).toBe(1)
    expect(added).toHaveLength(1)
    expect(added[0].info).toMatchObject({
      id: 'claude-max',
      activation: 'auto',
      package: 'aisdk:file:///x/provider.ts',
    })
    expect(Array.isArray(added[0].models)).toBe(true)
    expect(added[0].models[0]).toMatchObject({
      id: 'claude-sonnet-5',
      modelID: 'claude-sonnet-5',
      providerID: 'claude-max',
      enabled: true,
      status: 'active',
    })
    expect(debug[0]).toContain('add ok claude-max models=1')
  })
})

describe('registerV2Provider — провал называется', () => {
  test('add бросил → текст ошибки, провайдер и первая модель в канале ошибок, исключение наверх', () => {
    const errors: string[] = []
    const reg: ProviderEditorLike = {
      add() {
        throw new Error('e.map is not a function')
      },
    }
    expect(() =>
      registerV2Provider(reg, 'claude-max', v1Provider, {
        packageName: 'aisdk:file:///x/provider.ts',
        onError: (message) => errors.push(message),
      }),
    ).toThrow('e.map is not a function')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('add failed claude-max')
    expect(errors[0]).toContain('first=claude-sonnet-5')
    expect(errors[0]).toContain('package=aisdk:file:///x/provider.ts')
    expect(errors[0]).toContain('e.map is not a function')
  })

  test('модель без id не уносит остальные, но называется поимённо', () => {
    const errors: string[] = []
    const { editor: reg, added } = editor()
    const count = registerV2Provider(
      reg,
      'claude-max',
      { ...v1Provider, models: { broken: { name: 'no id' }, ...v1Provider.models } },
      { packageName: 'p', onError: (message) => errors.push(message) },
    )
    expect(count).toBe(1)
    expect(added[0].models).toHaveLength(1)
    expect(errors[0]).toContain('model map failed claude-max/broken')
    expect(errors[0]).toContain('no string id')
  })

  test('ни одной валидной модели → регистрация не идёт, причина названа', () => {
    const errors: string[] = []
    const { editor: reg, added } = editor()
    const count = registerV2Provider(
      reg,
      'claude-max',
      { ...v1Provider, models: { broken: { name: 'no id' } } },
      { packageName: 'p', onError: (message) => errors.push(message) },
    )
    expect(count).toBe(0)
    expect(added).toHaveLength(0)
    expect(errors.some((line) => line.includes('registration skipped claude-max'))).toBe(true)
  })

  test('провайдер без package → причина названа, в реестр ничего не уходит', () => {
    const errors: string[] = []
    const { editor: reg, added } = editor()
    const count = registerV2Provider(
      reg,
      'claude-max',
      { ...v1Provider, npm: undefined },
      { packageName: '', onError: (message) => errors.push(message) },
    )
    expect(count).toBe(0)
    expect(added).toHaveLength(0)
    expect(errors[0]).toContain('provider map failed claude-max')
    expect(errors[0]).toContain('no package')
  })
})
