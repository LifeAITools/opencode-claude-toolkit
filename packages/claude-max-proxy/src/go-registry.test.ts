/**
 * Реестр: поле `provider` у записи (стадия 2 — одна дверь на несколько провайдеров).
 *
 * 🔴 Зачем это отдельным тестом: без провайдера выбор организации смешал бы Go и OpenDesign,
 * и организация Go могла бы быть выбрана для маршрута OpenDesign (и наоборот) — это тот же
 * класс ошибки, что 02.11 дал 1444 отказа.
 */
import { describe, expect, test } from 'bun:test'
import { parseRegistry } from './go-registry.js'

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
