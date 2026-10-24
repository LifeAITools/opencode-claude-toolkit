/**
 * ОДИН РЕЕСТР НА ВСЕ МАРШРУТЫ — а не «хардкодим каждый раз».
 *
 * Слово фаундера 24.10.2026: «разве нет реестра провайдеров, моделей и так далее
 * централизованного? или мы каждый раз всё это вручную хардкодим?» До этого реестр знал
 * ТОЛЬКО Claude, а модели Go жили в конфиге посредника с ценами, подогнанными руками.
 *
 * Здесь проверяется ГРАНИЦА, без которой объединение опасно: реестр один, но маршрутов два,
 * и потребитель, регистрирующий модели Claude у провайдера, обязан пропускать чужие.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_MODELS, getModelMetadata } from '@life-ai-tools/claude-code-sdk'

const goIds = Object.entries(MAX_MODELS)
  .filter(([, m]) => m.provider === 'opencode-go')
  .map(([id]) => id)

const claudeIds = Object.entries(MAX_MODELS)
  .filter(([, m]) => m.provider !== 'opencode-go')
  .map(([id]) => id)

describe('единый реестр моделей: Claude + Go', () => {
  test('модели Go ЕСТЬ в реестре, и их не ноль', () => {
    expect(goIds.length).toBeGreaterThan(0)
    expect(goIds).toContain('deepseek-v4.1-flash-go')
    expect(goIds).toContain('muse-spark-1.3-contributor')
  })

  test('модели Claude по-прежнему без provider (историческое поле не появилось молча)', () => {
    expect(claudeIds.length).toBeGreaterThan(0)
    for (const id of claudeIds) expect(getModelMetadata(id)?.provider).toBeUndefined()
  })

  test('у каждой модели Go есть цена и СВОИ пороги сторожа', () => {
    for (const id of goIds) {
      const m = getModelMetadata(id)!
      expect(m.cost.input).toBeGreaterThan(0)
      expect(m.cost.output).toBeGreaterThan(0)
      expect(m.context).toBeGreaterThan(0)
      // Порог и срок кэша — поля МОДЕЛИ, а не одна настройка на всех.
      expect(typeof m.cacheTtlSec).toBe('number')
      expect(typeof m.rewriteMinTokens).toBe('number')
      expect(m.cacheTtlSec!).toBeGreaterThan(0)
      expect(m.rewriteMinTokens!).toBeGreaterThan(0)
    }
  })

  test('два маршрута не пересекаются по именам', () => {
    for (const id of goIds) expect(claudeIds).not.toContain(id)
  })
})
