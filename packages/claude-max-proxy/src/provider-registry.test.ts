/**
 * Тесты реестра провайдеров. Проверяют не «парсится», а РЕШЕНИЕ:
 * куда идти за моделью, и что будет, если предпочтённый провайдер недоступен.
 */
import { describe, expect, test } from 'bun:test'
import { parseProviderRegistry, resolveModel, modelMatches, ProviderRegistryError, modelsOf, resolveCandidates } from './provider-registry.js'

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

describe('флаги аккаунтов вместо правки списка (слово фаундера 05.11.2026)', () => {
  const Y = `
version: 1
providers:
  - id: opencode-go
    models: [deepseek-v4.1-flash-go]
  - id: open-design
    models: [deepseek-v4.1-flash-od]
model_preferences:
  - match: deepseek-v4.1-flash
    order: [open-design, opencode-go]
    on_unavailable: fail
account_overrides:
  - provider: opencode-go
    account: vip@x
    mode: preferred
    why: личная организация фаундера
  - provider: opencode-go
    account: dead@x
    mode: blocked
    why: месяц 100%
  - provider: opencode-go
    account: old@x
    mode: blocked
    until: 2026-11-01T00:00:00Z
    why: временная блокировка истекла
`
  const reg = parseProviderRegistry(Y)
  const accs = [
    { provider: 'opencode-go', account: 'vip@x', status: 'active' as const, windows: [{ name: 'week' as const, usedFraction: 0.9 }] },
    { provider: 'opencode-go', account: 'dead@x', status: 'active' as const, windows: [{ name: 'month' as const, usedFraction: 0.1 }] },
    { provider: 'opencode-go', account: 'old@x', status: 'active' as const, windows: [{ name: 'week' as const, usedFraction: 0.2 }] },
    { provider: 'opencode-go', account: 'plain@x', status: 'active' as const, windows: [{ name: 'week' as const, usedFraction: 0.05 }] },
    { provider: 'open-design', account: 'od@x', status: 'active' as const, windows: [{ name: '5h' as const, usedFraction: 0.3 }] },
    { provider: 'opencode-go', account: 'spent@x', status: 'exhausted' as const, windows: [{ name: 'month' as const, usedFraction: 1 }] },
  ]

  test('флаги разобраны, чужая организация в флаге — отказ реестра', () => {
    expect(reg.accountOverrides).toHaveLength(3)
    expect(() => parseProviderRegistry('providers:\n  - id: a\n    models: [m]\naccount_overrides:\n  - provider: ghost\n    account: x@y\n    mode: blocked')).toThrow(ProviderRegistryError)
  })

  test('провайдер по предпочтению — первым, blocked исключён, preferred выше normal', () => {
    const c = resolveCandidates(reg, 'deepseek-v4.1-flash', accs, new Date('2026-11-05T10:00:00Z'))
    expect(c[0].provider).toBe('open-design')
    const go = c.filter(x => x.provider === 'opencode-go').map(x => x.account)
    expect(go).not.toContain('dead@x')      // blocked
    expect(go).not.toContain('spent@x')     // exhausted
    expect(go[0]).toBe('vip@x')             // preferred, хотя запас хуже
    expect(go).toContain('old@x')           // блокировка истекла — снова в строю
    expect(c.at(-1)!.account).toBe('old@x')   // самый занятый из оставшихся (0.2 против 0.05)
  })

  test('у каждого кандидата названа причина и конкретное имя модели', () => {
    const c = resolveCandidates(reg, 'deepseek-v4.1-flash', accs, new Date('2026-11-05T10:00:00Z'))
    expect(c[0].model).toBe('deepseek-v4.1-flash-od')
    expect(c.find(x => x.account === 'vip@x')!.why).toContain('личная организация')
  })
})
