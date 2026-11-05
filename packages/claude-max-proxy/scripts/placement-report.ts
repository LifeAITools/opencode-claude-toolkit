#!/usr/bin/env bun
/**
 * Отчёт «куда сажать нового агента» по живым данным — без выкатки и без перезапуска.
 *
 *   bun packages/claude-max-proxy/scripts/placement-report.ts
 *   bun …/placement-report.ts --provider open-design
 *
 * Источники: отчёт квоты провайдера (~/.claude-local/quota-status-<provider>.json)
 * и карта пинов (go-org-pins.json — кто уже где сидит). Ничего не пишет и не меняет.
 */
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { placementInputs, planPlacement, NEAR_WALL_HOURS } from '../src/placement.js'

const HOME = homedir()
const provider = (() => {
  const i = process.argv.indexOf('--provider')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'opencode-go'
})()

const quotaPath = join(HOME, '.claude-local', `quota-status-${provider}.json`)
const pinsPath = join(HOME, '.claude-local', 'go-org-pins.json')
const samplesPath = join(HOME, '.claude-local', 'quota-samples.jsonl')
/** Окно «сейчас»: по нему считается текущая скорость. Меньше 5 минут — шум, больше часа — уже средняя. */
const RECENT_MIN_MS = 5 * 60_000
const RECENT_MAX_MS = 60 * 60_000

/**
 * Текущая скорость по ряду замеров: (util_сейчас − util_раньше) / часы.
 * Берём САМЫЙ СТАРЫЙ сэмпл в пределах часа — чем длиннее база, тем меньше шум.
 * Отрицательная дельта (окно сбросилось) скорости не даёт: это не расход.
 */
function recentRatesFromSamples(path: string, now: number): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  let lines: string[] = []
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean) } catch { return out }
  const parsed = lines.map(l => { try { return JSON.parse(l) } catch { return null } })
    .filter((x: any) => x && x.provider === provider && typeof x.ms === 'number')
  const current = parsed[parsed.length - 1]
  if (!current) return out
  const base = parsed.find((x: any) => now - x.ms >= RECENT_MIN_MS && now - x.ms <= RECENT_MAX_MS) ?? null
  if (!base) return out
  const hours = (current.ms - base.ms) / 3_600_000
  if (hours < RECENT_MIN_MS / 3_600_000) return out
  const baseByOrg = new Map<string, Record<string, number>>()
  for (const o of base.orgs ?? []) {
    const m: Record<string, number> = {}
    for (const w of o.windows ?? []) m[w.window] = w.util
    baseByOrg.set(o.name, m)
  }
  for (const o of current.orgs ?? []) {
    const before = baseByOrg.get(o.name)
    if (!before) continue
    const rates: Record<string, number> = {}
    for (const w of o.windows ?? []) {
      const b = before[w.window]
      if (typeof b !== 'number' || typeof w.util !== 'number') continue
      const delta = w.util - b
      if (delta <= 0) continue
      rates[w.window] = delta / hours
    }
    if (Object.keys(rates).length) out.set(o.name, rates)
  }
  return out
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

const quota = readJson(quotaPath)
if (!quota) {
  console.error(`нет отчёта квоты: ${quotaPath}`)
  process.exit(1)
}
const pinsDoc = readJson(pinsPath)
const pins: Record<string, { org: string; at?: number }> = pinsDoc?.pins ?? {}

/** Строки отчёта: у Go это `orgs[]`, у остальных — `accounts` (объект). */
function quotaOrgs(doc: any): any[] {
  if (Array.isArray(doc?.orgs) && doc.orgs.length) {
    return doc.orgs.map((o: any) => ({
      name: String(o.name),
      status: o.status ?? 'active',
      util5h: o.util5h ?? null, util7d: o.util7d ?? null, utilMonth: o.utilMonth ?? null,
      windows: Array.isArray(o.windows)
        ? o.windows.map((w: any) => ({
            window: String(w.window),
            util: typeof w.util === 'number' ? w.util : null,
            resetAt: typeof w.resetAt === 'number' ? w.resetAt : (w.resetIso ? Date.parse(w.resetIso) : null),
          }))
        : undefined,
    }))
  }
  return Object.entries(doc?.accounts ?? {}).map(([name, a]: [string, any]) => ({
    name, status: a?.absent ? 'absent' : (a?.status ?? 'active'),
    util5h: a?.util5h ?? null, util7d: a?.util7d ?? null, utilMonth: a?.utilMonth ?? null,
    windows: Array.isArray(a?.windows)
      ? a.windows.map((w: any) => ({
          window: String(w.window),
          util: typeof w.util === 'number' ? w.util : null,
          resetAt: typeof w.resetAt === 'number' ? w.resetAt : (w.resetIso ? Date.parse(w.resetIso) : null),
        }))
      : undefined,
  }))
}

const now = Date.now()
const inputs = placementInputs(quotaOrgs(quota), pins, { nowMs: now })
// Текущая скорость по ряду — если ряд есть; нет ряда → работаем по средней, как раньше.
const recent = recentRatesFromSamples(samplesPath, now)
const withAgents = inputs.map(o => ({ ...o, activeAgents: o.activeAgents, recentRates: recent.get(o.name) ?? null }))
if (recent.size) console.log(`текущая скорость: есть ряд по ${recent.size} организациям (файл ${samplesPath})`)
const plan = planPlacement(withAgents, now, 'report')

const fmtH = (h: number) => (!Number.isFinite(h) ? '∞' : h < 1 ? `${Math.round(h * 60)}м` : `${h.toFixed(1)}ч`)

console.log(`провайдер: ${provider}   замер: ${quota.measured_at ?? quota.updatedAt ?? '?'}   сейчас: ${new Date(now).toISOString()}`)
console.log('')
console.log('орг                          вердикт  до стены (после посадки)  агентов  запас   причина')
for (const a of plan.ranked) {
  const head = a.worstHeadroom === null ? '  —  ' : `${(100 * a.worstHeadroom).toFixed(0)}%`.padStart(5)
  console.log(
    `${a.name.slice(0, 28).padEnd(28)} ${a.verdict.padEnd(7)}  ${fmtH(a.score).padStart(10)}                 ${String(a.activeAgents).padStart(3)}     ${head}   ${a.reason}`,
  )
}
console.log('')
console.log(`РЕКОМЕНДАЦИЯ: ${plan.reason}`)
if (plan.org && plan.org.verdict === 'avoid') console.log(`(внимание: до стены меньше ${NEAR_WALL_HOURS} ч — это посадка «на грани»)`)
