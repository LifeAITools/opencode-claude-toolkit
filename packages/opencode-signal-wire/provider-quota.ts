/**
 * ДВЕРИ ЛИМИТОВ ПОСТАВЩИКОВ — Zhipu (bigmodel.cn) и Z.ai (api.z.ai).
 *
 * ЗАЧЕМ. У этих подписок нет входа в личный кабинет с нашей стороны, но есть
 * официальная дверь `GET /api/monitor/usage/quota/limit` со своим ключом: в ответе
 * потрачено/всего, остаток и обратный отсчёт. Образец переходника — открытый плагин
 * opencode-mystatus (vbgate/opencode-mystatus, plugin/lib/zhipu.ts): внутрь по
 * платформе своё, наружу одинаковая фигура. Замерено живьём 06.10 обеими дверями.
 *
 * ЧЕСТНЫЕ ГРАНИЦЫ. Ключ читается из auth.json в момент запроса, нигде не хранится
 * и ни в какой журнал не едет (даже обрезанным). `unit`/`number` ответа в виды окон
 * НЕ толкуем — что означает unit 3/number 5, из ответа не следует; везём как есть,
 * толкует потребитель. Нет ключа или дверь не отвечает — null, а не нули.
 */

export interface ProviderQuotaLimit {
  type: 'TOKENS_LIMIT' | 'TIME_LIMIT'
  /** Занятость 0..100, как отдала дверь. */
  percentage: number
  used?: number
  total?: number
  remaining?: number
  /** ISO-строка сброса, когда дверь её назвала. */
  resetAt?: string
  /** Сырые unit/number двери — без толкования, для того кто знает их смысл. */
  unit?: number
  number?: number
}

export interface ProviderQuota {
  provider: 'zhipu' | 'zai'
  measuredAt: string
  limits: ProviderQuotaLimit[]
}

export const PROVIDER_QUOTA_ENDPOINTS = {
  zhipu: 'https://bigmodel.cn/api/monitor/usage/quota/limit',
  zai: 'https://api.z.ai/api/monitor/usage/quota/limit',
} as const

interface LimitItem {
  type?: unknown
  usage?: unknown
  currentValue?: unknown
  remaining?: unknown
  percentage?: unknown
  nextResetTime?: unknown
  unit?: unknown
  number?: unknown
}

const finiteNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined

function normalizeLimit(item: LimitItem): ProviderQuotaLimit | null {
  if (item.type !== 'TOKENS_LIMIT' && item.type !== 'TIME_LIMIT') return null
  const percentage = finiteNum(item.percentage)
  if (percentage == null) return null
  const out: ProviderQuotaLimit = { type: item.type, percentage }
  const used = finiteNum(item.currentValue)
  const total = finiteNum(item.usage)
  const remaining = finiteNum(item.remaining)
  const resetMs = finiteNum(item.nextResetTime)
  const unit = finiteNum(item.unit)
  const number = finiteNum(item.number)
  if (used != null) out.used = used
  if (total != null) out.total = total
  if (remaining != null) out.remaining = remaining
  if (resetMs != null && resetMs > 0) out.resetAt = new Date(resetMs).toISOString()
  if (unit != null) out.unit = unit
  if (number != null) out.number = number
  return out
}

/**
 * Один запрос к двери лимитов. fetch инжектится (испытания подменяют сеть).
 * Любая неудача — null: двери нет, ключа нет, дверь отказала.
 */
export async function queryProviderQuota(
  fetchFn: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
    text: () => Promise<string>
  }>,
  provider: 'zhipu' | 'zai',
  apiKey: string,
  now: Date = new Date(),
): Promise<ProviderQuota | null> {
  if (!apiKey) return null
  try {
    const res = await fetchFn(PROVIDER_QUOTA_ENDPOINTS[provider], {
      method: 'GET',
      headers: { Authorization: apiKey, 'Content-Type': 'application/json' },
    })
    if (!res.ok) return null
    const body = (await res.json()) as { code?: unknown; success?: unknown; data?: { limits?: unknown } }
    if (body.code !== 200 || body.success !== true) return null
    const raw = body.data?.limits
    if (!Array.isArray(raw)) return null
    const limits: ProviderQuotaLimit[] = []
    for (const item of raw) {
      const l = normalizeLimit(item as LimitItem)
      if (l) limits.push(l)
    }
    if (limits.length === 0) return null
    return { provider, measuredAt: now.toISOString(), limits }
  } catch {
    return null
  }
}
