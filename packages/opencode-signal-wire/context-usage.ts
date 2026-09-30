/**
 * ЗАПОЛНЕНИЕ КОНТЕКСТА АГЕНТА OPENCODE — из данных самого opencode, а не из счётчиков прокси.
 *
 * ЗАЧЕМ. Адаптер знал размер контекста только из журнала claude-max-proxy (claude-max-stats.jsonl), а
 * агент opencode может ходить к модели мимо прокси: пилот SynqTalk 30.09 работал на
 * zai-coding-plan/glm-5.3, и его отметка жизни, стартовый тег и присутствие несли «не измерено»
 * (замер vibe-yjs-todo-sync-owner). Без числа не срабатывают порог самоперезапуска, потолок контекста
 * у спасателей и подпись фаундеру.
 *
 * ОТКУДА. Каждый ответ модели opencode присылает событием `message.updated`: у сообщения ассистента
 * `tokens.input` + `tokens.cache.read` + `tokens.cache.write` — это размер запроса ПОСЛЕДНЕГО шага, то
 * есть текущее заполнение (замер 30.09 по базе opencode: 281 088 → 293 952 от ответа к ответу,
 * плавно — сумма шагов прыгала бы). Окно модели — из каталога opencode (`config.providers`,
 * `limit.context`): для glm-5.3 там 1 000 000, а нашей таблицы Claude-моделей эта модель не знает.
 */

export interface AssistantUsage {
  sessionId: string
  providerId: string
  modelId: string
  /** Сколько токенов ушло в запрос последнего шага — текущее заполнение контекста. */
  promptTokens: number
}

/** Замер из события `message.updated`; всё, что не ответ ассистента с токенами, — null. */
export function usageFromMessageEvent(event: any): AssistantUsage | null {
  if (event?.type !== 'message.updated') return null
  const info = event?.properties?.info
  if (!info || info.role !== 'assistant') return null
  const t = info.tokens
  if (!t || typeof t !== 'object') return null
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const promptTokens = n(t.input) + n(t.cache?.read) + n(t.cache?.write)
  if (promptTokens <= 0) return null  // шаг ещё идёт — число придёт следующим событием
  if (typeof info.sessionID !== 'string' || typeof info.modelID !== 'string') return null
  return { sessionId: info.sessionID, providerId: String(info.providerID ?? ''), modelId: info.modelID, promptTokens }
}

/**
 * Окно модели из каталога opencode. Каталог запрашивается один раз на процесс и кэшируется; сбой
 * запроса не кэшируется — следующий ответ спросит снова. Неизвестная модель — null, а не догадка.
 */
export function createModelWindowResolver(
  fetchProviders: () => Promise<{ data?: { providers?: Array<{ id: string; models?: Record<string, { limit?: { context?: number } }> }> } } | undefined>,
): (providerId: string, modelId: string) => Promise<number | null> {
  let catalog: Map<string, number> | null = null
  return async (providerId, modelId) => {
    if (!catalog) {
      try {
        const r = await fetchProviders()
        const providers = r?.data?.providers
        if (!Array.isArray(providers)) return null
        const m = new Map<string, number>()
        for (const p of providers) {
          for (const [id, model] of Object.entries(p.models ?? {})) {
            const ctx = model?.limit?.context
            if (typeof ctx === 'number' && ctx > 0) m.set(`${p.id}/${id}`, ctx)
          }
        }
        catalog = m
      } catch {
        return null
      }
    }
    return catalog.get(`${providerId}/${modelId}`) ?? null
  }
}
