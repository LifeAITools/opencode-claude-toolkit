/**
 * provider-dump/v1 — версионируемый КОНТРАКТ схемы дампа (FR-21 / D6).
 *
 * Схема: kiberos-app/PRPs/provider-layer/01-architecture.md §3.4.
 *
 * 🔴 ТИПЫ ЖИВУТ ЗДЕСЬ, А НЕ В ДОКУМЕНТЕ. Документ ссылается на них; писатель
 * (двери прокси) и читатель (сборщик картины) берут ОДИН контракт, поэтому
 * расхождение формы ловится валидатором, а не «договорились». До этого форма
 * жила в коде одной двери, и вторая дверь повторила бы её на память.
 *
 * Правила, которые нельзя ломать:
 *   - Поле, которого поставщик не даёт, — `null`, а не `0`. У Go нет «записано в кэш».
 *   - Секреты не пишутся никогда (см. SECRET_HEADERS); тело людей — только хэш.
 *   - `v` поднимается ТОЛЬКО на ломающее изменение формы.
 */

export const DUMP_SCHEMA_VERSION = 1 as const

/** Вид вызова: настоящий ход, прогрев, проба, обновление пропуска, заголовок. */
export type CallKind = 'real' | 'warm' | 'probe' | 'refresh' | 'title'

/** Класс ошибки — по нему сборщик отличает чужую перегрузку от нашего исчерпания. */
export type ErrorKind = 'network' | 'auth' | 'quota' | 'provider' | 'client'

export const CALL_KINDS: readonly CallKind[] = ['real', 'warm', 'probe', 'refresh', 'title']
export const ERROR_KINDS: readonly ErrorKind[] = ['network', 'auth', 'quota', 'provider', 'client']

/** Заголовки, значения которых не пишутся НИКОГДА. Часть контракта: писатель обязан
 *  резать по этому списку, читатель — знать, что `<redacted:Nb>` это скрытое значение. */
export const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization',
])

export interface UsageNorm {
  input: number | null
  output: number | null
  reasoning: number | null
  cache_read: number | null
  cache_write: number | null
  cache_write_1h: number | null
}

export interface DumpRecord {
  v: typeof DUMP_SCHEMA_VERSION
  ts: string
  host: string
  door: string
  provider: string
  org_id: string | null
  /** Откуда дверь взяла организацию: `named` (назвал клиент), `pin` (выдана ранее),
   *  `quota` (выбрана по времени до стены), `active` (откат). `null` — версия двери,
   *  которая этого ещё не сообщала; НЕ равно `quota` и не должно трактоваться как выбор. */
  org_source?: string | null
  provider_org_ref: string | null
  model: string | null
  session_id: string | null
  lineage: string | null
  call_kind: CallKind
  actor: string | null
  request: {
    method: string
    url: string
    headers: Record<string, string>
    body_sha256: string | null
    body_bytes: number | null
    body_ref: string | null
  }
  response: {
    status: number | null
    headers: Record<string, string>
    body: unknown | null
    chunks: Array<{ t_ms: number; bytes: number; text: string }> | null
  }
  usage_raw: unknown | null
  usage_norm: UsageNorm
  quota_seen: Record<string, string>
  timing: { ttfb_ms: number | null; total_ms: number | null }
  error: { kind: ErrorKind; provider_type: string | null } | null
}

export interface DumpValidation {
  ok: boolean
  errors: string[]
}

const isObj = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * Валидатор контракта. Проверяет НЕСУЩИЕ поля (те, по которым сборщик судит и
 * группирует), а не каждый лист: слишком строгий валидатор ломался бы на каждом
 * добавленном поле, а слишком слабый пропустил бы дрейф формы. Пустой ответ —
 * `{ ok: true, errors: [] }`; на отказе `errors` называет КАЖДОЕ расхождение.
 */
export function validateDumpRecord(rec: unknown): DumpValidation {
  const errors: string[] = []
  if (!isObj(rec)) return { ok: false, errors: ['запись не объект'] }

  if (rec.v !== DUMP_SCHEMA_VERSION) errors.push(`v должен быть ${DUMP_SCHEMA_VERSION}, пришло ${String(rec.v)}`)
  for (const k of ['ts', 'host', 'door', 'provider'] as const) {
    if (typeof rec[k] !== 'string' || !(rec[k] as string)) errors.push(`${k} — непустая строка`)
  }
  if (!CALL_KINDS.includes(rec.call_kind as CallKind)) {
    errors.push(`call_kind ∈ {${CALL_KINDS.join('|')}}`)
  }
  if (!isObj(rec.request)) errors.push('request — объект')
  else if (typeof (rec.request as Record<string, unknown>).method !== 'string') {
    errors.push('request.method — строка')
  }
  if (!isObj(rec.response)) errors.push('response — объект')
  else {
    const st = (rec.response as Record<string, unknown>).status
    if (st !== null && typeof st !== 'number') errors.push('response.status — число или null')
  }
  if (!isObj(rec.usage_norm)) errors.push('usage_norm — объект')
  if (!isObj(rec.quota_seen)) errors.push('quota_seen — объект')
  if (!isObj(rec.timing)) errors.push('timing — объект')
  if (rec.error !== null && rec.error !== undefined) {
    if (!isObj(rec.error)) errors.push('error — объект или null')
    else if (!ERROR_KINDS.includes((rec.error as Record<string, unknown>).kind as ErrorKind)) {
      errors.push(`error.kind ∈ {${ERROR_KINDS.join('|')}}`)
    }
  }
  return { ok: errors.length === 0, errors }
}
