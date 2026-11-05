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
// У OpenDesign своя карта пинов — берём только совпадающие имена организаций.
const withAgents = inputs.map(o => ({ ...o, activeAgents: o.activeAgents }))
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
