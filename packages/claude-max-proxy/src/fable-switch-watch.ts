#!/usr/bin/env bun
/**
 * fable-switch-watch — одноразовый переключатель «после ручного сброса Fable».
 *
 * ЗАЧЕМ (слово фаундера 27.11.2026, TG 96429/96430/96431). Fable 5.2 расходуют на одном аккаунте
 * (elisevruslan) до упора, потом фаундер сам жмёт кнопку сброса в панели Anthropic. Сразу после
 * неё должно произойти ровно одно: Fable перестаёт садиться на этот аккаунт и снова садится только
 * на relishev, а на этот аккаунт садятся Sonnet, Opus и Haiku. Человек в этот момент занят — правка
 * `placement.json` руками в нужную минуту не должна быть его работой.
 *
 * КАК УЗНАЁМ О СБРОСЕ. Внутри одной недели счётчик Fable растёт и не падает; резкое падение — это
 * и есть сброс. Счётчик отдаёт только ручка `/api/oauth/usage` (в заголовках ответов его нет),
 * поэтому читаем ЧЕРЕЗ прокси (`POST /admin/orgs/remeasure`): он сам соблюдает паузу 429, а лимит
 * частоты этой ручки общий на машину (замер 12.11: после ~10 вызовов за минуты retry-after вырос
 * до 3300 с для всех организаций) — поэтому опрос редкий и сам себя отключает после срабатывания.
 *
 * 🔴 ОДНОРАЗОВО: после срабатывания `armed=false`. Иначе при следующем росте и сбросе правило
 * само вернулось бы и перетасовало организации без слова человека. Снова взвести — править файл.
 * 🔴 «НЕ ИЗМЕРЕНО» — НЕ СБРОС: пустой ответ, ошибка, пауза 429 — состояние не меняем.
 *
 * Файл `~/.claude-local/fable-switch.json`:
 *   { "armed": true, "watchOrg": "f9420373", "model": "Fable", "dropBy": 0.3, "minPrev": 0.5,
 *     "apply": { "orgModels": { "b3219c9b": ["claude-fable-5-2"] } }, "lastUtil": null }
 * `apply.orgModels` ЗАМЕНЯЕТ поле целиком; остальное в `placement.json` не трогается.
 */
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SwitchConfig {
  armed: boolean
  watchOrg: string
  model: string
  /** Падение счётчика (доля 0..1) от прошлого замера, которое считаем сбросом. */
  dropBy: number
  /** Сбросом считаем только падение с уровня не ниже этого: от 3% до 0% — не событие. */
  minPrev: number
  apply: { orgModels: Record<string, string[]> }
  lastUtil: number | null
  firedAt?: string
}

export type Decision =
  | { kind: 'skip'; reason: string }
  | { kind: 'record'; util: number }
  | { kind: 'fire'; util: number; prev: number }

/** Чистое решение по одному замеру: ничего не читает и не пишет. */
export function decide(cfg: SwitchConfig, current: number | null): Decision {
  if (!cfg.armed) return { kind: 'skip', reason: 'не взведён' }
  if (current === null || !Number.isFinite(current)) return { kind: 'skip', reason: 'счётчик не измерен — состояние не меняем' }
  const prev = cfg.lastUtil
  if (prev !== null && prev >= cfg.minPrev && prev - current >= cfg.dropBy) return { kind: 'fire', util: current, prev }
  return { kind: 'record', util: current }
}

const home = homedir()
export const CONFIG_PATH = process.env.FABLE_SWITCH_CONFIG ?? join(home, '.claude-local', 'fable-switch.json')
export const PLACEMENT_PATH = process.env.PLACEMENT_PATH ?? join(home, '.claude-local', 'placement.json')
const PROXY = process.env.PROXY_ADMIN_URL ?? 'http://127.0.0.1:5050'

function writeAtomic(path: string, data: unknown): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

/** Применить правило к placement.json: резервная копия, замена `orgModels`, пометка почему. */
export function applySwitch(placementPath: string, cfg: SwitchConfig, now = new Date()): string {
  const backup = `${placementPath}.backup-fable-switch-${now.toISOString().replace(/[:.]/g, '-')}`
  copyFileSync(placementPath, backup)
  const p = JSON.parse(readFileSync(placementPath, 'utf8'))
  p.orgModels = cfg.apply.orgModels
  p._comment_fable_switch = `Фаундер 27.11 (TG 96429): после ручного сброса Fable на ${cfg.watchOrg} сработал fable-switch-watch ${now.toISOString()} — Fable только на ${Object.keys(cfg.apply.orgModels).join(',')}, на ${cfg.watchOrg} общие модели. Откат: ${backup}.`
  writeAtomic(placementPath, p)
  return backup
}

async function readFableUtil(org: string, model: string): Promise<number | null> {
  try {
    const res = await fetch(`${PROXY}/admin/orgs/remeasure`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return null
    const d = (await res.json()) as { ok?: boolean; modelWeekly?: Array<{ model: string; util: number }> }
    if (!d.ok) return null
    const row = d.modelWeekly?.find(m => m.model.toLowerCase() === model.toLowerCase())
    return row ? row.util : null
  } catch { return null }
}

async function main(): Promise<void> {
  if (!existsSync(CONFIG_PATH)) return
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as SwitchConfig
  if (!cfg.armed) return
  const cur = await readFableUtil(cfg.watchOrg, cfg.model)
  const d = decide(cfg, cur)
  const stamp = new Date().toISOString()
  if (d.kind === 'skip') { console.log(`${stamp} FABLE_SWITCH_SKIP ${d.reason}`); return }
  if (d.kind === 'record') {
    writeAtomic(CONFIG_PATH, { ...cfg, lastUtil: d.util })
    console.log(`${stamp} FABLE_SWITCH_WATCH ${cfg.model}=${d.util} org=${cfg.watchOrg}`)
    return
  }
  const backup = applySwitch(PLACEMENT_PATH, cfg)
  writeAtomic(CONFIG_PATH, { ...cfg, armed: false, lastUtil: d.util, firedAt: stamp })
  console.log(`${stamp} FABLE_SWITCH_FIRED ${cfg.model} ${d.prev} -> ${d.util} org=${cfg.watchOrg}; placement.json обновлён, откат: ${backup}`)
}

if (import.meta.main) main().catch(e => { console.error(`FABLE_SWITCH_ERROR ${e?.message ?? e}`); process.exit(1) })
