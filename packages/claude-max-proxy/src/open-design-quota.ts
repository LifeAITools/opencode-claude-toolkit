#!/usr/bin/env bun
/**
 * open-design-quota — остаток подписки OpenDesign Go в файл квоты, для подвала агентов.
 *
 * ЗАЧЕМ (05.11.2026, поручение фаундера: второй провайдер должен участвовать в выборе,
 * а не правиться руками). Читатель — тот же, что у OpenCode Go (`~/.claude-local/quota-status-*.json`).
 *
 * 🔴 КВОТУ ОТДАЁТ ТОЛЬКО КОНТРОЛЬНАЯ ПЛОСКОСТЬ, И ТОЛЬКО CONTROL KEY.
 * Модельный ключ `sk-amr-…` (amr-link) квоту прочитать НЕ МОЖЕТ — у них это открытый баг
 * `nexu-io/open-design#8674`: /v1/usage и соседние пути → 404, в ответе и стриме ни одного
 * поля про остаток. Контрольная плоскость `amr-api.open-design.ai` отдаёт окна по
 * Control Key `vela_ctrl_…` (ключ добывается входом `open-design-login.mjs`, приложение
 * им не требуется). Альтернатива — cookie кабинета, но она рассыпается при смене
 * организации, поэтому мы храним именно Control Key.
 *
 * ЧТО ЧИТАЕМ:
 *   GET /api/v1/workspaces/current                              → workspaceId
 *   GET /api/v1/workspaces/{id}/billing/preflight               → codingPlan.windows + balanceUsd
 *
 * Окно опознаётся полем `durationSeconds`, а НЕ порядком в массиве и НЕ остатком времени:
 * 18000 = 5 часов, 604800 = неделя (замер 05.11.2026 на живой подписке).
 *
 * 🔴 ОТСУТСТВУЮЩАЯ ЦИФРА — ЭТО null, А НЕ 0 (рельс null-is-not-zero-in-measurements).
 * `eligible: false` — «подписки нет», а не «окно исчерпано»; это разные состояния и
 * разные записи в файле.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { CLAUDE_LOCAL, classifyLevel } from './quota-paths.js'

export const QUOTA_STATUS_OPEN_DESIGN_JSON = join(CLAUDE_LOCAL, 'quota-status-open-design.json')
export const CONTROL_CREDENTIALS_JSON =
  process.env.OPEN_DESIGN_CREDENTIALS ?? join(homedir(), '.secrets', 'open-design-control.json')

const CONTROL = 'https://amr-api.open-design.ai'
const UA = 'kiberos-claude-max-proxy/1.0'

export interface OpenDesignWindow {
  window: '5h' | 'week'
  util: number | null
  usedCredits: number | null
  limitCredits: number | null
  resetAt: number | null
  resetIso: string | null
}

export interface OpenDesignSnapshot {
  version: 1
  provider: 'open-design'
  updatedAt: string
  measured_at: string
  org: string | null
  orgSource: 'control_api'
  plan: string | null
  balanceUsd: string | null
  accounts: Record<string, {
    accountHint: string | null
    org: string | null
    plan: string | null
    balanceUsd: string | null
    util5h: number | null
    util7d: number | null
    reset5hAt: string | null
    reset7dAt: string | null
    windows: OpenDesignWindow[]
    absent?: string
  }>
  orgs: Array<{ name: string | null; util5h: number | null; util7d: number | null; level: 'ok' | 'warning' | 'critical' | null; status: string; windows: OpenDesignWindow[]; absent?: string }>
}

interface Preflight {
  workspaceId?: string
  balanceUsd?: string
  codingPlan?: {
    eligible?: boolean
    tier?: string
    windows?: Array<{
      durationSeconds?: number
      usedCredits?: string | number
      limitCredits?: string | number
      remainingCredits?: string | number
      resetsAt?: string
    }>
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Одно окно: доля считается из кредитов, отсутствие любого слагаемого даёт null, а не 0. */
export function windowOf(raw: NonNullable<NonNullable<Preflight['codingPlan']>['windows']>[number]): OpenDesignWindow | null {
  const d = num(raw?.durationSeconds)
  if (d === null) return null
  const label: '5h' | 'week' | null = d === 18000 ? '5h' : d === 604800 ? 'week' : null
  if (label === null) return null
  const used = num(raw?.usedCredits)
  const limit = num(raw?.limitCredits)
  const util = used !== null && limit !== null && limit > 0 ? used / limit : null
  const resetAt = raw?.resetsAt ? Date.parse(raw.resetsAt) : NaN
  return {
    window: label,
    util,
    usedCredits: used,
    limitCredits: limit,
    resetAt: Number.isFinite(resetAt) ? resetAt : null,
    resetIso: Number.isFinite(resetAt) ? new Date(resetAt).toISOString() : null,
  }
}

/** Один workspace (организация) → одна запись аккаунта. Несколько — столько же записей. */
export function accountFrom(preflight: Preflight, workspace: { id: string; name: string | null; type: string | null }, email: string | null, now: Date) {
  const plan = preflight?.codingPlan
  const rawWindows = Array.isArray(plan?.windows) ? plan!.windows! : []
  const windows = rawWindows.map(windowOf).filter((w): w is OpenDesignWindow => w !== null)
  const w5 = windows.find(w => w.window === '5h') ?? null
  const w7 = windows.find(w => w.window === 'week') ?? null
  const eligible = plan?.eligible !== false
  const absent = !eligible ? 'no_active_subscription' : windows.length === 0 ? 'provider_reported_no_windows' : undefined
  return {
    accountHint: email,
    org: workspace.name ?? workspace.id,
    workspaceId: workspace.id,
    workspaceType: workspace.type,
    plan: plan?.tier ?? null,
    balanceUsd: preflight?.balanceUsd ?? null,
    util5h: w5?.util ?? null,
    util7d: w7?.util ?? null,
    reset5hAt: w5?.resetIso ?? null,
    reset7dAt: w7?.resetIso ?? null,
    windows,
    ...(absent ? { absent } : {}),
  }
}

export interface WorkspaceRef { id: string; name: string | null; type: string | null; isDefault: boolean }

/**
 * 🔴 ОДИН ВХОД ОБСЛУЖИВАЕТ ВСЕ ОРГАНИЗАЦИИ АККАУНТА (замер 05.11.2026).
 * `GET /api/v1/workspaces` с одним Control Key вернул ДВА workspace: личный (eligible, план go,
 * окна 5ч/нед) и командный (eligible:false, окон нет, кошелёк 0). То есть новая организация,
 * заведённая под тем же аккаунтом, подхватывается САМА — новый ключ не нужен и файл править
 * не надо. Отдельный вход нужен только под ДРУГОЙ аккаунт (другая почта) — и он тоже
 * одной командой, без ручной правки файлов.
 *
 * Отсутствие подписки у организации — это `absent` с причиной, а НЕ «0% использовано»:
 * иначе балансировщик считал бы её годной и отправлял туда ходы.
 */
export function snapshotFromWorkspaces(preflights: Array<{ workspace: WorkspaceRef; preflight: Preflight }>, email: string | null, now = new Date()): OpenDesignSnapshot {
  const iso = now.toISOString()
  const accounts: OpenDesignSnapshot['accounts'] = {}
  const orgs: OpenDesignSnapshot['orgs'] = []
  let plan: string | null = null
  let balance: string | null = null
  for (const { workspace, preflight } of preflights) {
    const acc = accountFrom(preflight, workspace, email, now)
    const key = workspace.name ?? workspace.id
    accounts[key] = acc
    orgs.push({
      name: acc.org, util5h: acc.util5h, util7d: acc.util7d,
      level: classifyLevel(acc.util5h ?? null, acc.util7d ?? null),
      status: acc.absent ? 'absent' : 'active', windows: acc.windows,
      ...(acc.absent ? { absent: acc.absent } : {}),
    } as any)
    // Для сводки берём ПЕРВУЮ ГОДНУЮ организацию: у неё есть план и кошелёк.
    if (!acc.absent && plan === null) { plan = acc.plan; balance = acc.balanceUsd }
  }
  return {
    version: 1,
    provider: 'open-design',
    updatedAt: iso,
    measured_at: iso,
    org: email,
    orgSource: 'control_api',
    plan,
    balanceUsd: balance,
    accounts,
    orgs,
  }
}

async function api(path: string, key: string): Promise<any> {
  const res = await fetch(CONTROL + path, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

export async function collect(credentialsPath = CONTROL_CREDENTIALS_JSON): Promise<OpenDesignSnapshot> {
  const creds = JSON.parse(readFileSync(credentialsPath, 'utf8')) as { controlKey?: string; email?: string | null }
  const key = creds.controlKey
  if (!key || !key.startsWith('vela_ctrl_')) {
    throw new Error(`${credentialsPath}: нет Control Key (vela_ctrl_…) — войдите через open-design-login.mjs`)
  }
  // Список организаций аккаунта. Не читается — работаем по одной текущей (прежнее поведение).
  let workspaces: WorkspaceRef[] = []
  try {
    const list = await api('/api/v1/workspaces', key)
    workspaces = (Array.isArray(list?.items) ? list.items : []).map((w: any) => ({
      id: String(w.workspaceId), name: w.workspaceName ? String(w.workspaceName) : null,
      type: w.workspaceType ? String(w.workspaceType) : null, isDefault: !!w.isDefault,
    })).filter((w: WorkspaceRef) => w.id)
  } catch { /* ниже — запас по текущей */ }
  if (!workspaces.length) {
    const cur = await api('/api/v1/workspaces/current', key)
    const id = cur?.workspaceId ?? cur?.id
    if (!id) throw new Error('workspaces/current не назвал workspaceId')
    workspaces = [{ id: String(id), name: cur?.workspaceName ?? null, type: cur?.workspaceType ?? null, isDefault: true }]
  }
  const preflights: Array<{ workspace: WorkspaceRef; preflight: Preflight }> = []
  for (const workspace of workspaces) {
    try {
      const preflight = (await api(`/api/v1/workspaces/${encodeURIComponent(workspace.id)}/billing/preflight`, key)) as Preflight
      preflights.push({ workspace, preflight })
    } catch (err: any) {
      // Одна организация не читается — остальные всё равно попадают в отчёт.
      preflights.push({ workspace, preflight: { codingPlan: { eligible: false } } as Preflight })
    }
  }
  return snapshotFromWorkspaces(preflights, creds.email ?? null)
}

export function writeSnapshot(snap: OpenDesignSnapshot, path = QUOTA_STATUS_OPEN_DESIGN_JSON): string {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(snap, null, 2) + '\n')
  renameSync(tmp, path)
  return path
}

if (import.meta.main) {
  try {
    const snap = await collect()
    const out = writeSnapshot(snap)
    console.log(`[open-design-quota] записано ${out}`)
    const live = snap.orgs.find(o => o.status === 'active') ?? snap.orgs[0]
    const absent = snap.orgs.filter(o => o.status !== 'active').map(o => `${o.name} (${(o as any).absent ?? 'нет данных'})`)
    console.log(`[open-design-quota] план ${snap.plan ?? '?'} · ${live?.name ?? '?'} 5ч ${live?.util5h ?? '—'} · неделя ${live?.util7d ?? '—'}`)
    if (absent.length) console.log(`[open-design-quota] без подписки: ${absent.join(', ')}`)
  } catch (err: any) {
    console.error(`[open-design-quota] ОТКАЗ: ${String(err?.message ?? err).slice(0, 300)}`)
    process.exit(1)
  }
}
