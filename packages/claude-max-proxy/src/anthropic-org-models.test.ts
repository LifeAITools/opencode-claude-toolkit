import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anthropicOrgModelRules } from './anthropic-org-models.js'

const dir = mkdtempSync(join(tmpdir(), 'anth-org-models-'))
const yaml = (orgModels: string) => `
version: 1
providers:
  - id: anthropic
    kind: oauth-cli
    models: [claude-opus-5-5, claude-fable-5-2]
${orgModels}
`

describe('правило моделей Anthropic из реестра', () => {
  test('нет файла — пустое правило', () => {
    expect(anthropicOrgModelRules(join(dir, 'none.yaml'))()).toEqual({})
  })

  test('org_models разобраны; правка файла берётся без перезапуска', () => {
    const p = join(dir, 'reg.yaml')
    writeFileSync(p, yaml('    org_models:\n      - org: o1\n        models: [claude-fable-5-2]'))
    const read = anthropicOrgModelRules(p)
    expect(read()).toEqual({ o1: ['claude-fable-5-2'] })
    writeFileSync(p, yaml('    org_models:\n      - org: o2\n        models: [claude-fable-5-2]'))
    utimesSync(p, new Date(), new Date(Date.now() + 5000))
    expect(read()).toEqual({ o2: ['claude-fable-5-2'] })
  })

  test('битый реестр — прежнее правило остаётся, причина названа один раз', () => {
    const p = join(dir, 'broken.yaml')
    writeFileSync(p, yaml('    org_models:\n      - org: o1\n        models: [claude-fable-5-2]'))
    const errors: string[] = []
    const read = anthropicOrgModelRules(p, m => errors.push(m))
    expect(read()).toEqual({ o1: ['claude-fable-5-2'] })
    writeFileSync(p, yaml('    org_models:\n      - org: o1\n        models: [claude-nope]'))
    utimesSync(p, new Date(), new Date(Date.now() + 10000))
    expect(read()).toEqual({ o1: ['claude-fable-5-2'] })
    read()
    expect(errors).toHaveLength(1)
  })
})
