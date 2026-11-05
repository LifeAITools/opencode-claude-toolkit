/**
 * Реестр провайдеров — кто такие провайдеры, какие у них модели и КУДА идти за моделью.
 *
 * 🔴 ЗАЧЕМ ЭТО ОТДЕЛЬНО ОТ КОДА ДВЕРИ (слово фаундера 05.11.2026): «бывает провайдер
 * такой, бывает такой, бывает модель такая, бывает сякая — всё это держать, и
 * балансировщик мог с этим работать». Файл `config/providers.yaml` — объявление;
 * этот модуль — его разбор и РАЗРЕШЕНИЕ предпочтения. Знание не должно быть зашито
 * ни в дверь, ни в LiteLLM: иначе новый провайдер = правка кода.
 *
 * 🔴 ПОЧЕМУ ПРЕДПОЧТЕНИЕ ВООБЩЕ НУЖНО. У модели бывает несколько провайдеров, и они НЕ
 * равноценны: `deepseek-v4.1-flash` на OpenCode Go есть по квоте, но работает очень
 * плохо (слово фаундера 05.11.2026). Порядок провайдеров у модели — это факт о качестве,
 * а не про загрузку. И он несёт `on_unavailable`: `fail` означает «откажись вслух»,
 * `next` — «возьми следующего». Молчаливый откат на медленного провайдера запрещён,
 * потому что для человека это выглядит как «модель тормозит», и искать он будет не там.
 */
import { readFileSync } from 'fs'

export type ProviderKind = 'oauth-cli' | 'static-key'

export interface ProviderDecl {
  id: string
  kind: ProviderKind
  /** Модели, которые провайдер обслуживает — имена, которыми их зовёт LiteLLM/дверь. */
  models: string[]
  /** Аккаунты/организации этого провайдера (у Go — ссылкой на реестр, у прочих — списком). */
  accounts?: string[]
  accountsFrom?: string
  registryFrom?: string
  quota?: { adapter: string } & Record<string, unknown>
}

export interface ModelPreference {
  /** Каноническая модель. Совпадает с именем точно или как префикс (`X` → `X-go`, `X-od`). */
  match: string
  /** Провайдеры по предпочтению. ПЕРВЫЙ — куда идём. */
  order: string[]
  onUnavailable: 'fail' | 'next'
  preferLogical?: string
  why?: string
}

export interface ProviderRegistry {
  version: number
  providers: ProviderDecl[]
  modelPreferences: ModelPreference[]
  accountOverrides: AccountOverride[]
}

/** Как обходиться с конкретным аккаунтом. Это ФЛАГ, а не удаление из списка. */
export type AccountMode = 'preferred' | 'normal' | 'avoid' | 'blocked'

export interface AccountOverride {
  provider: string
  /** Имя аккаунта/организации ровно как в файле квоты (`org`). */
  account: string
  mode: AccountMode
  /** Временная блокировка: до этого момента. Пусто — бессрочно (до снятия флага). */
  until?: string
  /** Основание. Без него флаг через месяц неотличим от забытой правки. */
  why?: string
}

export class ProviderRegistryError extends Error {}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function parseProviderRegistry(text: string): ProviderRegistry {
  const raw = (Bun.YAML.parse(text) ?? {}) as Record<string, any>
  const providers: ProviderDecl[] = []
  for (const p of raw.providers ?? []) {
    if (!p || typeof p !== 'object') continue
    const id = str(p.id)
    if (!id) continue
    providers.push({
      id,
      kind: p.kind === 'static-key' ? 'static-key' : 'oauth-cli',
      models: Array.isArray(p.models) ? p.models.map(str).filter(Boolean) : [],
      accounts: Array.isArray(p.accounts) ? p.accounts.map(str).filter(Boolean) : undefined,
      accountsFrom: p.accounts_from ? str(p.accounts_from) : undefined,
      registryFrom: p.registry_from ? str(p.registry_from) : undefined,
      quota: p.quota && typeof p.quota === 'object' ? { adapter: str(p.quota.adapter), ...p.quota } : undefined,
    })
  }
  if (!providers.length) throw new ProviderRegistryError('реестр провайдеров пуст')
  const ids = new Set(providers.map(p => p.id))
  const prefs: ModelPreference[] = []
  for (const m of raw.model_preferences ?? []) {
    if (!m || typeof m !== 'object') continue
    const match = str(m.match)
    const order = Array.isArray(m.order) ? m.order.map(str).filter(Boolean) : []
    if (!match || !order.length) continue
    for (const p of order) {
      if (!ids.has(p)) throw new ProviderRegistryError(`предпочтение «${match}» называет провайдера «${p}», которого нет в реестре`)
    }
    prefs.push({
      match,
      order,
      onUnavailable: m.on_unavailable === 'next' ? 'next' : 'fail',
      preferLogical: m.prefer_logical ? str(m.prefer_logical) : undefined,
      why: m.why ? str(m.why) : undefined,
    })
  }
  const accountOverrides: AccountOverride[] = []
  for (const o of raw.account_overrides ?? []) {
    if (!o || typeof o !== 'object') continue
    const provider = str(o.provider)
    const account = str(o.account)
    if (!provider || !account) continue
    if (!ids.has(provider)) throw new ProviderRegistryError(`флаг аккаунта ссылается на провайдера «${provider}», которого нет в реестре`)
    const mode: AccountMode = o.mode === 'preferred' ? 'preferred' : o.mode === 'avoid' ? 'avoid' : o.mode === 'blocked' ? 'blocked' : 'normal'
    accountOverrides.push({ provider, account, mode, until: o.until ? str(o.until) : undefined, why: o.why ? str(o.why) : undefined })
  }
  return { version: Number(raw.version ?? 1), providers, modelPreferences: prefs, accountOverrides }
}

export function loadProviderRegistry(path: string): ProviderRegistry {
  return parseProviderRegistry(readFileSync(path, 'utf8'))
}

/** Совпадение канонической модели с конкретным именем: точно либо как префикс семейства. */
export function modelMatches(match: string, model: string): boolean {
  return model === match || model.startsWith(`${match}-`)
}

export interface ResolvedPreference {
  match: string
  /** Провайдеры по порядку предпочтения. */
  order: string[]
  onUnavailable: 'fail' | 'next'
  /** Конкретное имя модели у каждого провайдера, если оно известно. */
  modelByProvider: Record<string, string | null>
  /** Итоговое имя для первого провайдера — то, что называет агент. */
  preferredModel: string | null
  why?: string
}

/**
 * Разрешает модель в порядок провайдеров. `null` — предпочтение не задано, и это НЕ ошибка:
 * значит модель живёт там, где её объявил LiteLLM, и выдумывать за неё порядок нельзя.
 */
export function resolveModel(reg: ProviderRegistry, model: string): ResolvedPreference | null {
  const pref = reg.modelPreferences.find(p => modelMatches(p.match, model))
  if (!pref) return null
  const modelByProvider: Record<string, string | null> = {}
  for (const id of pref.order) {
    const provider = reg.providers.find(p => p.id === id)
    const own = provider?.models.find(m => modelMatches(pref.match, m)) ?? null
    modelByProvider[id] = own
  }
  const first = pref.order[0]
  const preferredModel = pref.preferLogical ?? modelByProvider[first] ?? null
  return {
    match: pref.match,
    order: [...pref.order],
    onUnavailable: pref.onUnavailable,
    modelByProvider,
    preferredModel,
    why: pref.why,
  }
}

/** Все модели провайдера — для проверки «а эту модель он вообще обслуживает». */
export function modelsOf(reg: ProviderRegistry, providerId: string): string[] {
  return reg.providers.find(p => p.id === providerId)?.models ?? []
}

// ─── Выбор аккаунта: флаги вместо правки списка ────────────────────────────────
//
// Слово фаундера 05.11.2026: «не убирать из списка, а сделать флаг преимущественного
// использования или временной блокировки… чтобы балансировщик предпочитал одну
// организацию другой, если на ней есть квота».
//
// Правило здесь — данные, а не код: `account_overrides` в providers.yaml. Балансировщик
// получает УЖЕ УПОРЯДОЧЕННЫЙ список кандидатов и причину для каждого; выдумывать
// порядок на месте он не имеет права.

export type AccountModeWeight = { preferred: 0; normal: 1; avoid: 2 }

export interface AccountQuotaView {
  provider: string
  account: string | null
  status: 'active' | 'absent' | 'exhausted' | 'unreadable'
  windows: Array<{ name: '5h' | 'week' | 'month'; usedFraction: number | null }>
}

export interface Candidate {
  provider: string
  model: string
  account: string | null
  mode: AccountMode
  /** Наибольшая занятость среди окон (меньше — лучше). null = не измерено. */
  worstUsedFraction: number | null
  rank: { provider: number; mode: number; headroom: number }
  why: string
}

const modeWeight = (m: AccountMode): number => (m === 'preferred' ? 0 : m === 'avoid' ? 2 : 1)

function overrideFor(reg: ProviderRegistry, provider: string, account: string | null, now: Date): AccountOverride | null {
  if (!account) return null
  const hit = reg.accountOverrides.find(o => o.provider === provider && o.account === account)
  if (!hit) return null
  if (hit.until) {
    const t = Date.parse(hit.until)
    // Истёкшая временная блокировка перестаёт действовать САМА — иначе «на два дня»
    // через месяц всё ещё держало бы аккаунт в стороне, и никто бы не понял почему.
    if (Number.isFinite(t) && now.getTime() > t) return null
  }
  return hit
}

/**
 * Упорядоченные кандидаты для модели: провайдер по предпочтению из `model_preferences`,
 * внутри провайдера — флаг аккаунта, затем запас (меньше занятость — выше).
 * Исключены: blocked, exhausted, absent, unreadable. `avoid` не исключён — он в конце.
 */
export function resolveCandidates(
  reg: ProviderRegistry,
  model: string,
  accounts: AccountQuotaView[],
  now = new Date(),
): Candidate[] {
  const pref = resolveModel(reg, model)
  const providerOrder = pref?.order ?? reg.providers.map(p => p.id)
  const out: Candidate[] = []
  for (const [pi, providerId] of providerOrder.entries()) {
    const declared = reg.providers.find(p => p.id === providerId)
    const modelName = declared?.models.find(m => modelMatches(pref?.match ?? model, m)) ?? (pref?.modelByProvider[providerId] ?? null)
    if (!modelName) continue
    const pool = accounts.filter(a => a.provider === providerId)
    if (!pool.length) continue
    for (const a of pool) {
      const ov = overrideFor(reg, providerId, a.account, now)
      const mode: AccountMode = ov?.mode ?? 'normal'
      if (mode === 'blocked') continue
      if (a.status !== 'active') continue
      const used = a.windows.map(w => w.usedFraction).filter((v): v is number => v !== null)
      const worst = used.length ? Math.max(...used) : null
      out.push({
        provider: providerId,
        model: modelName,
        account: a.account,
        mode,
        worstUsedFraction: worst,
        rank: { provider: pi, mode: modeWeight(mode), headroom: worst ?? 1 },
        why: ov?.why ?? (pref?.why ? `preference:${pref.match}` : 'no_preference'),
      })
    }
  }
  out.sort((x, y) =>
    x.rank.provider - y.rank.provider ||
    x.rank.mode - y.rank.mode ||
    x.rank.headroom - y.rank.headroom ||
    String(x.account).localeCompare(String(y.account)))
  return out
}
