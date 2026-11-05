/**
 * Тесты реестра провайдеров. Проверяют не «парсится», а РЕШЕНИЕ:
 * куда идти за моделью, и что будет, если предпочтённый провайдер недоступен.
 */
import { describe, expect, test } from 'bun:test'
import { parseProviderRegistry, resolveModel, modelMatches, ProviderRegistryError, modelsOf } from './provider-registry.js'

const YAML = `
version: 1
providers:
  - id: opencode-go
    kind: oauth-cli
    quota: { adapter: opencode-go-refresher }
    models: [deepseek-v4.1-flash-go, qwen3.8-flash]
  - id: open-design
    kind: static-key
    accounts: [a@b.c]
    quota: { adapter: open-design-preflight }
    models: [deepseek-v4.1-flash-od]
model_preferences:
  - match: deepseek-v4.1-flash
    order: [open-design, opencode-go]
    on_unavailable: fail
    why: на Go эта модель работает плохо
  - match: qwen3.8-flash
    order: [opencode-go]
    on_unavailable: fail
`

describe('provider-registry', () => {
  const reg = parseProviderRegistry(YAML)

  test('провайдеры и их модели разобраны', () => {
    expect(reg.providers.map(p => p.id)).toEqual(['opencode-go', 'open-design'])
    expect(reg.providers[1].kind).toBe('static-key')
    expect(reg.providers[1].accounts).toEqual(['a@b.c'])
    expect(modelsOf(reg, 'open-design')).toEqual(['deepseek-v4.1-flash-od'])
  })

  test('семейство матчится префиксом, но не произвольно', () => {
    expect(modelMatches('deepseek-v4.1-flash', 'deepseek-v4.1-flash-od')).toBe(true)
    expect(modelMatches('deepseek-v4.1-flash', 'deepseek-v4.1-flash')).toBe(true)
    expect(modelMatches('deepseek-v4.1-flash', 'deepseek-v4.1-flashX')).toBe(false)
    expect(modelMatches('qwen', 'qwen3.8-flash')).toBe(false)
  })

  test('DeepSeek уходит в OpenDesign первым, Go остаётся вторым', () => {
    const r = resolveModel(reg, 'deepseek-v4.1-flash')!
    expect(r.order).toEqual(['open-design', 'opencode-go'])
    expect(r.preferredModel).toBe('deepseek-v4.1-flash-od')
    expect(r.modelByProvider).toEqual({ 'open-design': 'deepseek-v4.1-flash-od', 'opencode-go': 'deepseek-v4.1-flash-go' })
    expect(r.onUnavailable).toBe('fail')
  })

  test('запрос по конкретному имени ведёт туда же, что и по семейству', () => {
    expect(resolveModel(reg, 'deepseek-v4.1-flash-go')!.preferredModel).toBe('deepseek-v4.1-flash-od')
  })

  test('модель без предпочтения — null, а не выдуманный порядок', () => {
    expect(resolveModel(reg, 'glm-5.3')).toBeNull()
  })

  test('предпочтение на несуществующего провайдера — отказ реестра, а не тихий пропуск', () => {
    expect(() => parseProviderRegistry(`
providers:
  - id: a
    models: [m]
model_preferences:
  - match: m
    order: [a, ghost]
`)).toThrow(ProviderRegistryError)
  })

  test('пустой реестр — отказ', () => {
    expect(() => parseProviderRegistry('providers: []')).toThrow(ProviderRegistryError)
  })
})
