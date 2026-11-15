import { test, expect } from 'bun:test'
import { join } from 'node:path'
import { loadProviderRegistry } from '../packages/claude-max-proxy/src/provider-registry.ts'

// Реестр в репозитории обязан читаться: иначе дверь OpenDesign отвечает 503 (инцидент 15.11.2026).
test('config/providers.yaml читается разборщиком службы', () => {
  const p = join(import.meta.dir, '..', 'packages', 'claude-max-proxy', 'config', 'providers.yaml')
  expect(() => loadProviderRegistry(p)).not.toThrow()
})
