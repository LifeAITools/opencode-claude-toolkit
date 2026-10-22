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
  provider: 'zhipu' | 'zai' | 'go'
  /**
   * Время запроса, полная точность (ISO): ценз реестра 300 секунд, часовое
   * округление во второй половине часа читалось бы протухшим. Эпоху-число
   * реестр не принимает — перевод в ISO на нашей стороне (см. resetAt ниже).
   */
  measuredAt: string
  limits: ProviderQuotaLimit[]
  /** Окна по отображению владельца ядра (ниже): TIME_LIMIT сюда не входит вовсе. */
  windows: ProviderQuotaWindow[]
  /**
   * ОТКУДА ВЗЯТЫ ОКНА — и это не догадка потребителя, а слово самого производителя.
   * `subscription` — первоисточник (дверь провайдера → файл квоты); `spend-estimate` — наша
   * оценка по расходу, годная ТОЛЬКО как резерв. Потребителю это нужно, чтобы назвать источник
   * в подвале (`quotaSource`), а не выводить его эвристикой по имени счётчика.
   */
  source?: 'subscription' | 'spend-estimate'
}

/**
 * Отображение лимитов в окна — дословно по строке владельца ядра:
 * TOKENS_LIMIT + unit 3 → 5h; + unit 6 → 7d; другой unit → tokens-uN как есть;
 * TIME_LIMIT — НЕ окна (месячный allowance MCP-вызовов, работа моделей по нему
 * не gate'ится). Неизвестное молча не роняется — едет отдельным окном.
 */
/**
 * Окно квоты поставщика для общего провода. Форма — слова владельца ядра 06.10
 * (доки + живой фикстур): вид сначала по type, потом по unit. resetAt — только
 * ISO-строка (эпоху реестр не принимает); measuredAt — время запроса с точностью
 * до секунды (ценз 300 секунд).
 */
export interface ProviderQuotaWindow {
  kind: string
  /** percentage 0..100, делённый на 100. */
  util: number
  resetAt?: string
  measuredAt: string
}

export function mapLimitsToWindows(limits: ProviderQuotaLimit[], measuredAt: string): ProviderQuotaWindow[] {
  const out: ProviderQuotaWindow[] = []
  for (const l of limits) {
    if (l.type !== 'TOKENS_LIMIT') continue
    const kind = l.unit === 3 ? '5h' : l.unit === 6 ? '7d' : typeof l.unit === 'number' ? `tokens-u${l.unit}` : 'tokens-unknown'
    const w: ProviderQuotaWindow = { kind, util: l.percentage / 100, measuredAt }
    if (l.resetAt) w.resetAt = l.resetAt
    out.push(w)
  }
  return out
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
    const measuredAt = now.toISOString()
    return { provider, measuredAt, limits, windows: mapLimitsToWindows(limits, measuredAt) }
  } catch {
    return null
  }
}

/**
 * СВОДКА ДЛЯ ЖУРНАЛА — и она обязана называть ОБА поля, а не одно.
 *
 * 🔴 ЗАМЕР 22.10.2026 (нашёл владелец signal-wire): живая строка печатала
 * `go:0` — то есть `limits.length`. У записей Go `limits` пуст ПО УСТРОЙСТВУ (окна едут в
 * `windows`), поэтому строка читалась как «у Go ноль окон», хотя окон было три. ДВА человека
 * за час прочитали её в одну и ту же ложную сторону и едва не доложили фаундеру «фикс не доехал».
 *
 * Это тот же класс, что мы ловили весь день: прибор отвечает правдоподобно не про то — только
 * теперь в журнале, который читает СЛЕДУЮЩИЙ агент и делает вывод в самом опасном направлении.
 *
 * Форма: `<provider>[<source>]:l<лимиты>/w<окна>`. Примеры: `go[subscription]:l0/w3`,
 * `zai:l3/w0`. Она сама отвечает на вопрос «доехали ли данные» и заодно видна, кто победил —
 * подписка или резерв.
 */
export function describeProviderQuota(quotas: readonly ProviderQuota[] | null | undefined): string[] {
  return (quotas ?? []).map((q) => {
    const source = q.source ? `[${q.source}]` : ''
    const limits = q.limits?.length ?? 0
    const windows = q.windows?.length ?? 0
    return `${q.provider}${source}:l${limits}/w${windows}`
  })
}
