/**
 * Правило «организация Anthropic → её модели» для распределителя SDK — из реестра провайдеров.
 *
 * Слово фаундера 13.11.2026 (TG 85158): «у каждого провайдера … и соответствующих организаций
 * есть предоставляемые модели, чтобы балансировщик мог понимать, куда можно сажать». Знание живёт
 * в одном месте — `config/providers.yaml`, поставщик `anthropic`, поле `org_models`; клиент SDK
 * получает его через `orgModelRules` и сам чужой файл не читает (зависимость сверху вниз).
 *
 * Читается на каждый выбор, перечитывается только при смене mtime — правка реестра действует
 * без перезапуска. Файла нет / не разбирается — пустое правило: прежнее поведение, а ПРИЧИНА
 * печатается один раз в журнал (молчаливая потеря правила выглядела бы как «правило не работает»).
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadProviderRegistry, orgModelRulesFor } from './provider-registry.js'

export function providerRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PROVIDER_REGISTRY_PATH ?? join(import.meta.dir, '..', 'config', 'providers.yaml')
}

export function anthropicOrgModelRules(
  path: string,
  onError: (msg: string) => void = () => {},
): () => Record<string, string[]> {
  let cache: { mtimeMs: number; rules: Record<string, string[]> } | null = null
  let lastError: string | null = null
  return () => {
    try {
      if (!existsSync(path)) return {}
      const m = statSync(path).mtimeMs
      if (cache && cache.mtimeMs === m) return cache.rules
      const rules = orgModelRulesFor(loadProviderRegistry(path), 'anthropic')
      cache = { mtimeMs: m, rules }
      lastError = null
      return rules
    } catch (e: any) {
      const msg = String(e?.message ?? e)
      if (msg !== lastError) { lastError = msg; onError(msg) }
      // Битый реестр не отменяет прежнее правило: держим последнее удачно разобранное.
      return cache?.rules ?? {}
    }
  }
}
