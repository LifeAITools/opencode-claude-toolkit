/**
 * Реестр организаций OpenCode Go — кто где живёт. Секретов здесь НЕТ.
 *
 * Формат читается тот же, что у litellm/go-orgs.yaml (kiberos-app): на переносе файл уезжает
 * сюда как есть, второго формата не заводим. Источник — путь из GO_REGISTRY_PATH.
 *
 * Организация выбирается по uid SynqTask ИЛИ по имени (порядок как у go_orgs.py: uid первым —
 * он стабилен, имя при переименовании сломало бы маршрут молча). Не назвали — рабочая (`active`).
 * Названную, которой нет, НИКОГДА не подменяем другой: это отказ, не повод взять соседнюю
 * (рельс no-live-account-migration — кэш принадлежит организации).
 */

import { readFileSync } from 'node:fs'

export interface GoOrg {
  name: string
  workspace: string
  auth: 'console' | 'api_key'
  baseUrl: string
  synqtaskOrgUid: string | null
  /** Имя переменной окружения с ключом — только для auth=api_key. */
  env: string | null
  priority: number
}

export interface GoRegistry {
  active: string
  usageUrl: string | null
  orgs: GoOrg[]
}

export class GoOrgError extends Error {}

export function parseRegistry(text: string): GoRegistry {
  const raw = (Bun.YAML.parse(text) ?? {}) as Record<string, any>
  const orgs: GoOrg[] = []
  for (const e of raw.orgs ?? []) {
    if (!e || typeof e !== 'object' || !e.name) continue
    const auth = e.auth === 'api_key' ? 'api_key' : 'console'
    orgs.push({
      name: String(e.name),
      workspace: String(e.workspace ?? ''),
      auth,
      baseUrl: String(e.base_url ?? ''),
      synqtaskOrgUid: e.synqtask_org_uid ? String(e.synqtask_org_uid) : null,
      env: e.env ? String(e.env) : null,
      priority: Number(e.priority ?? 0),
    })
  }
  const active = String(raw.active ?? '')
  if (!orgs.length) throw new GoOrgError('реестр Go пуст: нет ни одной организации')
  if (!orgs.some(o => o.name === active)) throw new GoOrgError(`рабочая организация «${active}» не описана в реестре`)
  return { active, usageUrl: raw.usage_url ? String(raw.usage_url) : null, orgs }
}

export function loadRegistry(path: string): GoRegistry {
  return parseRegistry(readFileSync(path, 'utf8'))
}

/** uid → имя → (не названа) рабочая. Названная и не найденная — GoOrgError, без подмены. */
export function pickOrg(reg: GoRegistry, wanted: string | null | undefined): GoOrg {
  const w = (wanted ?? '').trim()
  if (!w) return reg.orgs.find(o => o.name === reg.active)!
  const hit = reg.orgs.find(o => o.synqtaskOrgUid === w) ?? reg.orgs.find(o => o.name === w)
  if (!hit) throw new GoOrgError(`организации «${w}» в реестре нет (есть: ${reg.orgs.map(o => o.name).join(', ')})`)
  return hit
}
