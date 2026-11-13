/**
 * Организация Anthropic под ОПРЕДЕЛЁННЫЕ модели (слово фаундера 13.11.2026, голос TG 85103).
 *
 * Зачем. Третья организация подключается ТОЛЬКО под claude-fable-5-2 — для архитекторских задач:
 * у Fable 5.2 есть сбросы квоты, у других моделей нет. Любая другая модель на этой организации
 * сожгла бы объём, ради которого её подключают, — а распределитель до сих пор выбирал
 * организацию по запасу и на модель не смотрел вовсе.
 *
 * Правило — в обе стороны, по списку `orgModels` в ~/.claude/placement.json:
 *   { "orgModels": { "<orgId или его префикс>": ["claude-fable-5-2"] } }
 *   — модель, названная в чьём-то списке, садится ТОЛЬКО на организации, где она названа;
 *   — организация со списком не берёт модели вне списка.
 * Организации без списка — общие для всех моделей, кроме «закреплённых».
 *
 * Чистые функции, без чтения файлов: разбор и подбор проверяются испытанием без прокси.
 * Правило НЕ зависит от `enabled` регулятора — это ограничение, а не настройка выбора.
 */

/** orgId-префикс → множество разрешённых моделей (базовые имена, без `[1m]`). */
export type ModelAllowlist = Map<string, Set<string>>

/** Имя модели без пометки окна: `claude-fable-5-2[1m]` → `claude-fable-5-2`. */
export function baseModelName(model: string): string {
  return String(model ?? '').replace(/\[[^\]]*\]$/, '').trim().toLowerCase()
}

/** Разбор поля `orgModels`. Невалидная запись — пропуск, не исключение. */
export function parseModelAllowlist(raw: any): ModelAllowlist {
  const out: ModelAllowlist = new Map()
  const src = raw?.orgModels
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out
  for (const [org, list] of Object.entries(src)) {
    if (!org || !Array.isArray(list)) continue
    const models = new Set(list.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map(baseModelName))
    if (models.size > 0) out.set(org, models)
  }
  return out
}

const matches = (orgId: string, key: string) => orgId === key || orgId.startsWith(key)

/**
 * Какие организации годятся для модели. `exclusive` — модель закреплена за списком и уходить
 * за его пределы не вправе (даже когда разрешённая организация одна или вовсе недоступна).
 * Нет правил — все организации, `exclusive: false`, поведение прежнее.
 */
export function orgsAllowedForModel(
  rules: ModelAllowlist, orgIds: string[], model: string,
): { allowed: string[]; exclusive: boolean } {
  if (rules.size === 0) return { allowed: [...orgIds], exclusive: false }
  const m = baseModelName(model)
  const pinnedKeys = [...rules].filter(([, set]) => set.has(m)).map(([k]) => k)
  if (pinnedKeys.length > 0) {
    return { allowed: orgIds.filter(o => pinnedKeys.some(k => matches(o, k))), exclusive: true }
  }
  // Модель не закреплена: организации со списком для неё закрыты.
  const restricted = [...rules.keys()]
  return { allowed: orgIds.filter(o => !restricted.some(k => matches(o, k))), exclusive: false }
}
