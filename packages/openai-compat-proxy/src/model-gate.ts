/**
 * model-gate — модель, которой нет в /models апстрима, получает громкий отказ, а не тихий счёт.
 *
 * 🔴 ЧЕМ КУПЛЕНО (01.10.2026). В провайдере opencode с ключом Token Plan стоял датированный
 * снимок `deepseek-v4-pro-0813`. Подписка его НЕ перечисляет в GET /models (там только
 * `deepseek-v4-pro`), но по имени отвечает — и списывает мимо подписки. Ошибку нашли через
 * девять дней, по письму Alibaba о почти выбранной бесплатной квоте; за это время через
 * прослойку прошло 192 вызова, 40.8 млн входа. Тот, кто выбирает модель, узнаёт о промахе
 * только в первом же вызове — значит, в первом же вызове и надо сказать.
 *
 * Список берётся у САМОГО апстрима тем же ключом, что пришёл с запросом: состав зависит от
 * ключа, а не от адреса. Держится в памяти TTL_MS. Не удалось получить список (сеть, 401,
 * пустой ответ) — запрос проходит как раньше: сбой проверки не должен ронять работу.
 */
import { createHash } from 'crypto'

const TTL_MS = 10 * 60_000

type Fetcher = (url: string, init: RequestInit) => Promise<Response>

interface Entry { at: number; ids: Set<string> | null }

export class UpstreamModelGate {
  private cache = new Map<string, Entry>()

  constructor(private readonly fetcher: Fetcher = fetch, private readonly now: () => number = Date.now) {}

  /** Модели апстрима для этого ключа, или null, если список получить не удалось. */
  async models(base: string, authorization: string | null): Promise<Set<string> | null> {
    const key = base + '|' + createHash('sha256').update(authorization ?? '').digest('hex')
    const hit = this.cache.get(key)
    if (hit && this.now() - hit.at < TTL_MS) return hit.ids
    let ids: Set<string> | null = null
    try {
      const res = await this.fetcher(base.replace(/\/+$/, '') + '/v1/models', {
        method: 'GET',
        headers: authorization ? { authorization } : {},
      })
      if (res.ok) {
        const body = (await res.json()) as { data?: Array<{ id?: unknown }> }
        const list = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
        if (list.length > 0) ids = new Set(list)
      }
    } catch {
      ids = null
    }
    this.cache.set(key, { at: this.now(), ids })
    return ids
  }

  /**
   * null — пропустить. Response — отказ 400 с именем модели и тем, что апстрим предлагает.
   */
  async check(base: string, authorization: string | null, model: string | undefined): Promise<Response | null> {
    if (!model) return null
    const ids = await this.models(base, authorization)
    if (!ids || ids.has(model)) return null
    const offered = [...ids].sort()
    const message =
      `model "${model}" is not in this upstream's GET /models for your key, so it is not part of the plan ` +
      `and would be billed outside it. Offered: ${offered.join(', ')}. ` +
      `(openai-compat-proxy model gate; set PROXY_ENFORCE_MODELS=0 to disable)`
    console.error(`[openai-compat-proxy] MODEL_NOT_IN_PLAN model=${model} base=${base}`)
    return new Response(
      JSON.stringify({ error: { type: 'model_not_in_plan', code: 'model_not_in_plan', message, model, offered } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )
  }
}
