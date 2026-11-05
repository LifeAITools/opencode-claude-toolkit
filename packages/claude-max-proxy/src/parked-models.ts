/**
 * ПАРКОВКА МОДЕЛЕЙ — флаг «пока не используем» без правки кода и без перезапуска.
 *
 * ЗАЧЕМ (слово фаундера 05.11.2026): подписка Anthropic не продлена, и модели Claude
 * отвечают отказом поставщика (`oauth_not_allowed_for_organization`). Такой отказ читается
 * как поломка — и человек, и агент ищут дефект у нас, хотя это решение «не пользуемся».
 *
 * Флаг превращает это в НАЗВАННЫЙ и намеренный отказ: «модель припаркована, причина такая,
 * с такого числа». Он живёт в файле, а не в коде, — чтобы включать и снимать можно было
 * одним движением, без выкатки.
 *
 * 🔴 ЧЕГО ФЛАГ НЕ ДЕЛАЕТ: не скрывает модель из каталогов и не мешает прямому вызову в
 * Anthropic. Каталоги (LiteLLM, opencode, чат) — своя зона; флаг отвечает только на СОБСТВЕННОЙ
 * двери, и это сказано вслух, а не подразумевается.
 *
 * Файл: `~/.claude-local/parked-models.json`
 *   { "parked": [ { "prefix": "claude-", "reason": "subscription_not_renewed",
 *                   "since": "2026-11-05", "why": "…" } ] }
 * Нет файла/битый — ничего не припарковано (fail-open: флаг не смеет ломать дверь).
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface ParkedRule {
  /** Начало имени модели. Пусто — не правило. */
  prefix: string
  reason: string
  since?: string
  why?: string
}

export function parkedModelsPath(): string {
  return process.env.PARKED_MODELS_PATH?.trim() || join(homedir(), '.claude-local', 'parked-models.json')
}

let cache: { at: number; rules: ParkedRule[] } = { at: 0, rules: [] }
const CACHE_MS = 5_000

export function readParkedRules(path = parkedModelsPath(), now = Date.now()): ParkedRule[] {
  if (now - cache.at < CACHE_MS) return cache.rules
  let rules: ParkedRule[] = []
  try {
    statSync(path)
    const doc = JSON.parse(readFileSync(path, 'utf8'))
    const list = Array.isArray(doc?.parked) ? doc.parked : []
    rules = list
      .filter((r: any) => r && typeof r.prefix === 'string' && r.prefix.trim())
      .map((r: any) => ({
        prefix: String(r.prefix),
        reason: typeof r.reason === 'string' && r.reason ? r.reason : 'parked',
        ...(typeof r.since === 'string' ? { since: r.since } : {}),
        ...(typeof r.why === 'string' ? { why: r.why } : {}),
      }))
  } catch { rules = [] }
  cache = { at: now, rules }
  return rules
}

/** Правило парковки для модели или null. Первое совпадение по префиксу. */
export function parkedReason(model: string, rules?: ParkedRule[], now = Date.now()): ParkedRule | null {
  if (!model) return null
  const rs = rules ?? readParkedRules(undefined, now)
  return rs.find(r => model.startsWith(r.prefix)) ?? null
}
