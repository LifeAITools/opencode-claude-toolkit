/**
 * v2-model — ЕДИНСТВЕННЫЙ шов перевода метаданных модели из формы v1 в `Model.Info`
 * OpenCode 2.0 (сверено с тегом upstream `v2.0.27`, `packages/schema/src/model.ts:122-146`).
 *
 * Зачем отдельный файл: v1-хук `config` отдаёт модели в своей форме, и каждая новая
 * модель (а их 11) должна проходить через ОДНУ функцию, а не через копию кода в
 * plugin-v2. Здесь же лежит вся арифметика, которую легко проверить тестом без v2.
 *
 * Что именно ломало каталог до этого файла (измерено, не предположено):
 *   - без `enabled: true` модель отфильтровывается `model.ts:221` → `Model unavailable`;
 *   - `time.released` строкой рвёт энкодер `GET /api/model` путём `time.released`;
 *   - `capabilities.input` объектом (v1) даёт `TypeError: .some is not a function`;
 *   - `cost` объектом даёт `costs.filter is not a function` при учёте токенов;
 *   - `variants` объектом не находится через `variants.find(...)` (`-m …#high`).
 *
 * Ни одно поле здесь не выдумано: значения либо переносятся из v1, либо берутся из
 * дефолта самой схемы v2 (`Model.Info.default`), либо вычисляются из id/наличия
 * возможностей. Где значение неизвестно — ставится `0`/`[]`, как это делает сам v2
 * (`packages/core/src/models-dev.ts:134-137`, `model.ts:120`).
 */

/** Форма v1-модели, которую отдаёт `index.ts` (описана структурно, без импорта v1). */
export interface V1ModelLike {
  id?: unknown
  name?: unknown
  modelID?: unknown
  providerID?: unknown
  enabled?: unknown
  status?: unknown
  family?: unknown
  reasoning?: unknown
  modalities?: { input?: unknown; output?: unknown }
  capabilities?: {
    toolcall?: unknown
    input?: Record<string, unknown>
    output?: Record<string, unknown>
    interleaved?: unknown
  }
  cost?: unknown
  limit?: { context?: unknown; output?: unknown }
  variants?: unknown
  options?: unknown
  headers?: unknown
  time?: { released?: unknown }
  released?: unknown
  /** v1 кладёт сюда `{id,url,npm}`; в v2 такого поля нет — источник адреса/пакета провайдер. */
  api?: unknown
  [key: string]: unknown
}

export interface V2Capabilities {
  tools: boolean
  input: string[]
  output: string[]
}

export interface V2Variant {
  id: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  body?: Record<string, unknown>
}

export interface V2Cost {
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  capabilities: V2Capabilities
  variants: V2Variant[]
  time: { released: number }
  cost: V2Cost[]
  status: 'alpha' | 'beta' | 'deprecated' | 'active'
  enabled: boolean
  limit: { context: number; output: number }
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  compatibility?: { reasoningField?: string }
  family?: string
}

/** Дефолты схемы v2 (`Model.Info.default`, `packages/schema/src/model.ts:150-165`). */
export const V2_DEFAULT_LIMIT = { context: 200_000, output: 32_000 } as const
export const V2_DEFAULT_INPUT = ['text', 'image'] as const
export const V2_DEFAULT_OUTPUT = ['text'] as const

const STATUSES = ['alpha', 'beta', 'deprecated', 'active'] as const
type Status = (typeof STATUSES)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `time.released` — `Schema.Finite` (число unix-ms). v1 хранит дату строкой (или не
 * хранит вовсе). Неизвестное/битое значение → `0`, ровно как в v2 (`models-dev.ts:134-137`).
 * NaN наружу не выходит ни при каком входе.
 */
export function parseReleased(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function intOr(value: unknown, fallback: number): number {
  return Math.trunc(finiteOr(value, fallback))
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/** v1: `{text:true, image:true, pdf:false, …}` → v2: `['text', 'image']`. */
function trueKeys(value: unknown): string[] | undefined {
  if (!isRecord(value)) return undefined
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true)
    .map(([key]) => key)
}

/**
 * v1 кладёт модальности в `modalities` (это читал v1), а `capabilities.input/output`
 * там — объекты булевых флагов. v2 читает ТОЛЬКО `capabilities.input/output` как
 * массив строк, поэтому источников два, в порядке доверия.
 */
function modalities(v1: V1ModelLike, key: 'input' | 'output'): string[] {
  const fromV1Modalities = v1.modalities?.[key]
  if (Array.isArray(fromV1Modalities)) {
    const strings = fromV1Modalities.filter((item): item is string => typeof item === 'string')
    if (strings.length) return strings
  }
  const fromCapabilities = trueKeys(v1.capabilities?.[key])
  if (fromCapabilities?.length) return fromCapabilities
  return key === 'input' ? [...V2_DEFAULT_INPUT] : [...V2_DEFAULT_OUTPUT]
}

/** v1: `{low:{thinking:{…}}, high:{…}}` → v2: `[{id:'low', settings:{thinking:{…}}}, …]`. */
export function toV2Variants(value: unknown): V2Variant[] {
  if (Array.isArray(value)) {
    const out: V2Variant[] = []
    for (const item of value) {
      if (!isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) continue
      out.push({
        id: item.id,
        ...(isRecord(item.settings) ? { settings: { ...item.settings } } : {}),
        ...(isRecord(item.headers) ? { headers: asStringRecord(item.headers) } : {}),
        ...(isRecord(item.body) ? { body: { ...item.body } } : {}),
      })
    }
    return out
  }
  if (!isRecord(value)) return []
  const out: V2Variant[] = []
  for (const [id, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    // v1 пишет `{thinking:{…}}` прямо в варианте — у v2 это `settings.thinking`.
    const settings = isRecord(raw.settings) ? { ...raw.settings } : { ...raw }
    out.push({ id, settings })
  }
  return out
}

/** v1: `{input,output,cache:{read,write}}` → v2: `[{…}]` (`Schema.Array(Cost)`). */
export function toV2Cost(value: unknown): V2Cost[] {
  if (Array.isArray(value)) {
    const out: V2Cost[] = []
    for (const item of value) {
      const cost = costEntry(item)
      if (cost) out.push(cost)
    }
    return out
  }
  const cost = costEntry(value)
  return cost ? [cost] : []
}

function costEntry(value: unknown): V2Cost | undefined {
  if (!isRecord(value)) return undefined
  const cache = isRecord(value.cache) ? value.cache : {}
  return {
    input: finiteOr(value.input, 0),
    output: finiteOr(value.output, 0),
    cache: {
      read: finiteOr(cache.read, 0),
      write: finiteOr(cache.write, 0),
    },
  }
}

function asStringRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
}

function toStatus(value: unknown): Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value) ? (value as Status) : 'active'
}

/**
 * Маппер, ради которого существует файл: одна запись v1 → одна валидная `Model.Info` v2.
 * Бросает только на записи без `id` — назвать модель в журнале иначе невозможно.
 */
export function toV2Model(v1: V1ModelLike, providerID: string): V2ModelInfo {
  if (typeof v1.id !== 'string' || v1.id.length === 0) {
    throw new Error(`v1 model has no string id (name=${String(v1.name)})`)
  }
  const interleaved = isRecord(v1.capabilities?.interleaved) ? v1.capabilities.interleaved : undefined
  const reasoningField = typeof interleaved?.field === 'string' ? interleaved.field : undefined
  const settings = isRecord(v1.options) && Object.keys(v1.options).length > 0 ? { ...v1.options } : undefined
  const headers = isRecord(v1.headers) && Object.keys(v1.headers).length > 0 ? asStringRecord(v1.headers) : undefined

  return {
    id: v1.id,
    modelID: stringOr(v1.modelID, v1.id),
    providerID,
    name: stringOr(v1.name, v1.id),
    capabilities: {
      // v1-флаг называется `toolcall`; отсутствие флага трактуем как поддержку (v1 ставил true).
      tools: v1.capabilities?.toolcall !== false,
      input: modalities(v1, 'input'),
      output: modalities(v1, 'output'),
    },
    variants: toV2Variants(v1.variants),
    time: { released: parseReleased(v1.time?.released ?? v1.released) },
    cost: toV2Cost(v1.cost),
    status: toStatus(v1.status),
    // v1 не знает поля `enabled`: у него модель всегда присутствует. Дефолт — включена;
    // явный `enabled: false` (если кто-то его поставит) уважается.
    enabled: v1.enabled !== false,
    limit: {
      context: intOr(v1.limit?.context, V2_DEFAULT_LIMIT.context),
      output: intOr(v1.limit?.output, V2_DEFAULT_LIMIT.output),
    },
    ...(settings ? { settings } : {}),
    ...(headers ? { headers } : {}),
    ...(reasoningField ? { compatibility: { reasoningField } } : {}),
    ...(typeof v1.family === 'string' && v1.family ? { family: v1.family } : {}),
  }
}

/** Провайдер v1 (`{id,name,api,npm,models}`) → `Provider.Info` v2. */
export interface V1ProviderLike {
  id?: unknown
  name?: unknown
  api?: unknown
  npm?: unknown
  models?: unknown
  [key: string]: unknown
}

export interface V2ProviderInfo {
  id: string
  name: string
  activation: 'auto'
  package: string
  settings?: Record<string, unknown>
}

/**
 * @param packageOverride — чем регистрировать провайдера. `file://…/dist/provider.js` —
 *   нативный путь v2; `aisdk:<name>` — путь AI SDK (для нашего случая, см. plugin-v2).
 */
export function toV2Provider(
  v1: V1ProviderLike,
  options: { id?: string; package?: string } = {},
): V2ProviderInfo {
  const id = options.id ?? stringOr(v1.id, '')
  if (!id) throw new Error('v1 provider has no string id')
  const packageName = options.package ?? stringOr(v1.npm, '')
  if (!packageName) throw new Error(`provider ${id} has no package (v1 npm/${'package'} field)`)
  return {
    id,
    name: stringOr(v1.name, id),
    // `auto` даёт доступность тогда и только тогда, когда у провайдера нет одноимённой
    // интеграции, — это ровно наш случай (`core/src/provider.ts:407-420`).
    activation: 'auto',
    package: packageName,
    ...(typeof v1.api === 'string' && v1.api ? { settings: { baseURL: v1.api } } : {}),
  }
}
