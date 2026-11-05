/**
 * Реестр: поле `provider` у записи (стадия 2 — одна дверь на несколько провайдеров).
 *
 * 🔴 Зачем это отдельным тестом: без провайдера выбор организации смешал бы Go и OpenDesign,
 * и организация Go могла бы быть выбрана для маршрута OpenDesign (и наоборот) — это тот же
 * класс ошибки, что 02.11 дал 1444 отказа.
 */
import { describe, expect, test } from 'bun:test'
import { parseRegistry, orgsOfProvider, pickOrgForProvider, GoOrgError, GoRegistryError } from './go-registry.js'

const REG = `
active: org-b
orgs:
  - name: org-b
    workspace: wrk_B
    auth: console
    base_url: https://example.invalid/v1
`

describe('провайдер у записи реестра (стадия 2)', () => {
  test('без поля provider — opencode-go, прежний реестр читается как раньше', () => {
    const reg = parseRegistry(REG)
    expect(reg.orgs.every(o => o.provider === 'opencode-go')).toBe(true)
  })

  test('поле provider читается и не смешивается', () => {
    const reg = parseRegistry(`
active: od-1
orgs:
  - name: od-1
    provider: open-design
    auth: api_key
    env: OPEN_DESIGN_API_KEY
    base_url: https://amr-link.open-design.ai/v1
  - name: go-1
    auth: console
    base_url: https://example.invalid/v1
`)
    expect(reg.orgs.find(o => o.name === 'od-1')!.provider).toBe('open-design')
    expect(reg.orgs.find(o => o.name === 'go-1')!.provider).toBe('opencode-go')
  })
})

describe('выбор внутри провайдера (шаг 2 стадии 2)', () => {
  const REG2 = `
active: go-1
orgs:
  - name: go-1
    auth: console
    base_url: https://example.invalid/v1
  - name: od-2
    provider: open-design
    auth: api_key
    env: OPEN_DESIGN_API_KEY_2
    base_url: https://amr-link.open-design.ai/v1
    priority: 2
  - name: od-1
    provider: open-design
    auth: api_key
    env: OPEN_DESIGN_API_KEY
    base_url: https://amr-link.open-design.ai/v1
    priority: 1
`
  const reg = parseRegistry(REG2)

  test('организации не смешиваются между провайдерами', () => {
    expect(orgsOfProvider(reg, 'open-design').map(o => o.name)).toEqual(['od-2', 'od-1'])
    expect(orgsOfProvider(reg, 'opencode-go').map(o => o.name)).toEqual(['go-1'])
  })

  test('active принадлежит другому провайдеру — берётся своя по priority, а не чужая', () => {
    expect(pickOrgForProvider(reg, 'open-design').name).toBe('od-1')
  })

  test('названная внутри провайдера находится; чужая — отказ без подмены', () => {
    expect(pickOrgForProvider(reg, 'open-design', 'od-2').name).toBe('od-2')
    expect(() => pickOrgForProvider(reg, 'open-design', 'go-1')).toThrow(GoOrgError)
  })

  test('провайдер без организаций — отказ, а не пустая дверь', () => {
    expect(() => pickOrgForProvider(reg, 'nope')).toThrow(GoRegistryError)
  })
})
