/**
 * ДВЕРЬ USAGE ПОДПИСКИ GO/ZEN — opencode.ai/zen/go/v1/usage (provider-go-usage.ts).
 *
 * ЗАЧЕМ. Окна подписки (5h/неделя/месяц со сбросами) отдаёт только эта дверь;
 * в базе opencode их нет, а ключ opencode-go из auth.json дверь отвергает
 * (401 без схемы, 403 с Bearer — замер 06.10). Нужен ключ формы auth-login
 * (таблица credential или Zen-ключ) — его делает вход, см. ниже.
 *
 * ЧЕСТНАЯ ГРАНИЦА МОДУЛЯ. Форму успешного ответа живьём ещё никто не снимал:
 * модуль везёт сырой JSON как есть и НЕ выдумывает окна. Отображение в окна —
 * вторым шагом, когда первый успешный ответ покажет форму (факты, не догадка).
 * Ключи читаются в момент запроса (таблица credential, затем auth.json: Zen,
 * затем Go), нигде не хранятся и ни в какой журнал не едут.
 */

export const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'

export interface GoUsageRaw {
  provider: 'zen' | 'go'
  measuredAt: string
  /** Сырой JSON успешного ответа — форму покажет первый живой замер. */
  data: unknown
}

const finiteStr = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null

/**
 * Ключи рабочей области по порядку двери: сначала Zen, затем Go; сначала
 * таблица credential (форма auth-login), затем auth.json. Возвращает пары
 * {provider, key} без самих значений наружу — вызывающая сторона их не логирует.
 */
export function resolveWorkspaceKeys(
  dbRows: Array<{ integration_id?: unknown; value?: unknown }>,
  authJson: Record<string, { key?: unknown }>,
): Array<{ provider: 'zen' | 'go'; key: string }> {
  const out: Array<{ provider: 'zen' | 'go'; key: string }> = []
  const push = (provider: 'zen' | 'go', key: unknown) => {
    const k = finiteStr(key)
    if (k && !out.some((e) => e.key === k)) out.push({ provider, key: k })
  }
  for (const row of dbRows ?? []) {
    const id = typeof row.integration_id === 'string' ? row.integration_id.trim() : ''
    let key: unknown = null
    try { key = JSON.parse(String(row.value ?? '')).key } catch { key = null }
    if (id === 'opencode') push('zen', key)
    else if (id === 'opencode-go') push('go', key)
  }
  push('zen', authJson?.['opencode']?.key)
  push('zen', authJson?.['zen']?.key)
  push('go', authJson?.['opencode-go']?.key)
  // Порядок двери: Zen первым, затем Go.
  out.sort((a, b) => (a.provider === b.provider ? 0 : a.provider === 'zen' ? -1 : 1))
  return out
}

/**
 * Один опрос двери первым же работающим ключом. 200 — сырой JSON как есть;
 * всё остальное — null (дверь без ключа, отказ, сеть). Никогда не бросает.
 */
export async function queryGoUsage(
  fetchFn: (url: string, init: { method: string; headers: Record<string, string> }) => Promise<{
    ok: boolean
    status: number
    json: () => Promise<unknown>
  }>,
  keys: Array<{ provider: 'zen' | 'go'; key: string }>,
  now: Date = new Date(),
): Promise<GoUsageRaw | null> {
  for (const { provider, key } of keys) {
    try {
      const res = await fetchFn(GO_USAGE_URL, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      })
      if (!res.ok) continue
      const data = await res.json()
      if (data == null) continue
      return { provider, measuredAt: now.toISOString(), data }
    } catch {
      continue
    }
  }
  return null
}
