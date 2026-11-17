/**
 * placement-control — ручка распределителя и ПИД поверх выбора при рождении сессии.
 *
 * 🔴 Слово фаундера 12.11.2026: «ручка, которая додавит одну организацию аккуратно», «полноценный
 * ПИД», «тормоз, чтобы все разом в стену не упёрлись». Калибровка: research/placement-pid-
 * calibration-2026-11.md — тормоз нужен НА ВСЕХ организациях (`balance`), а `drain` — на той,
 * что назвал человек.
 *
 * ФАЙЛ `~/.claude/placement.json` (перечитывается при изменении, без перезапуска):
 *   {
 *     "enabled": false,                       // false — выбор как раньше (planPlacement)
 *     "brakeMode": "hard",                    // hard — заторможенная не получает новых; soft — отступает на лучшую по порядку
 *     "balanceTargetUtil": 0.97,              // 5ч: довести до 97%, но НЕ упереться (слово фаундера)
 *     "weekBrakeUtil": 0.98,                  // неделя: кормить до 98%, остаток дожигают живые
 *     "drain": [ { "org": "b3219c9b", "targetUtil": 0.99, "deadline": "2026-11-12T20:00:00Z" } ],
 *     "gains":  { "kp": 16, "ki": 0, "kd": 2, "kff": 0.5 },
 *     "limits": { "wMax": 1, "slewPerHour": 3, "integralMax": 0.5, "brakeMargin": 0.05, "derivTauHours": 0.25 },
 *     "kCalByClass": { "anthropic/opus": 0.0256, "anthropic/fable": 0.0963 },
 *     "kDefault": 0.0256, "driftPerHour": 0.02
 *   }
 * Нет файла / битый / enabled=false — регулятор не участвует, и это видно в причине выбора.
 */
import { readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { pidStep, newPidState, type PidGains, type PidLimits, type PidAdaptation, type PidState, type PidOutput } from './placement-pid.js'
import type { PlacementWindow } from './placement.js'
import { parseModelAllowlist, type ModelAllowlist } from './org-model-allowlist.js'

export interface DrainEntry { org: string; targetUtil: number; deadlineMs: number }

/** Область действия правила «модель ↔ организация»: `all` — жёстко всем (как было),
 *  `new` — только новым сессиям (живые досиживают; выбор при рождении всё равно не даст
 *  чужой модели сесть на закреплённую организацию). */
export type ModelGuardScope = 'all' | 'new'

export interface PlacementControlConfig {
  enabled: boolean
  /**
   * 🔴 `hard` (по умолчанию с 17.11.2026, слово фаундера TG 89252): заторможенная по пятичасовому
   * окну организация не получает новых сессий, пока есть незаторможенная с недельным остатком.
   * `soft` — прежнее: тормоз отступает на равную или лучшую по общему порядку выбора.
   */
  brakeMode: 'hard' | 'soft'
  modelGuardScope: ModelGuardScope
  balanceTargetUtil: number
  /**
   * 🔴 СЛОВО ФАУНДЕРА 15.11.2026 (TG 87399): «надо стараться израсходовать 5 часовую на 97% но не
   * упереться, недельную на 100% но упереться минимальным количеством — задача максимизация
   * использования лимита при минимизации случаев, когда сессии упираются жёстко слишком рано».
   * Поэтому у окон РАЗНЫЕ цели: 5ч ведёт ПИД к 0.97 (выше прежних 0.95 — лимит используется
   * полнее), а недельный тормоз стоит на 0.98: поставщик отказывает уже при ~0.99 (замер 14.11:
   * retry-after 110 787 с), и последние два процента дожигают УЖЕ посаженные сессии, а не новые,
   * которым отказ стоил бы работы.
   */
  weekBrakeUtil: number
  drain: DrainEntry[]
  gains: PidGains
  limits: PidLimits
  adapt: PidAdaptation
}

/** Коэффициенты калибровки 12.11.2026 (research/placement-pid-calibration-2026-11.md). */
export const CALIBRATED: Omit<PlacementControlConfig, 'enabled' | 'drain'> = {
  brakeMode: 'hard',
  modelGuardScope: 'all',
  balanceTargetUtil: 0.97,
  weekBrakeUtil: 0.98,
  gains: { kp: 16, ki: 0, kd: 2, kff: 0.5 },
  limits: { wMax: 1, slewPerHour: 3, integralMax: 0.5, brakeMargin: 0.05, derivTauHours: 0.25 },
  adapt: {
    enabled: true, kCalByClass: { 'anthropic/opus': 0.0256, 'anthropic/fable': 0.0963, 'anthropic/sonnet': 0.0018, 'anthropic/haiku': 0 },
    kDefault: 0.0256, driftPerHour: 0.02, forget: 0.97, adaptMin: 0.25, adaptMax: 4, minObservations: 6,
  },
}

/**
 * 🔴 НАГРУЗКА ДЛЯ РЕГУЛЯТОРА — ПО РАБОТАЮЩИМ СЕССИЯМ (17.11.2026, слово фаундера TG 89257).
 * Закреплённая сессия, которая стоит и только держит кэш, пятичасовое окно почти не жжёт, а
 * регулятор считал её полноценной: на oeliseva 17 закреплённых при ~4 работающих давали прогноз
 * 5ч 200% против реальных 60%, и организацию с большим недельным остатком тормозили зря.
 * Сессия считается работающей, если её последний настоящий ход не старше `windowMs`; без отметки
 * хода — стоячая. Чистая функция: время и отметки — параметрами.
 */
export function activeLoadByOrg(
  pins: Iterable<[string, { orgId?: string | null }]>,
  lastTurnAt: ReadonlyMap<string, number>,
  classOf: (sessionId: string) => string,
  nowMs: number,
  windowMs: number,
): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>()
  const since = nowMs - windowMs
  for (const [sid, p] of pins) {
    if (!p.orgId) continue
    if ((lastTurnAt.get(sid) ?? 0) < since) continue
    const cls = classOf(sid)
    const m = out.get(p.orgId) ?? {}
    m[cls] = (m[cls] ?? 0) + 1
    out.set(p.orgId, m)
  }
  return out
}

export const DEFAULT_PLACEMENT_CONFIG_PATH = join(homedir(), '.claude', 'placement.json')

const num = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d

/** Разбор файла. Чистая функция: невалидное поле — значение калибровки, не исключение. */
export function parsePlacementControl(raw: any): PlacementControlConfig {
  const g = raw?.gains ?? {}, l = raw?.limits ?? {}
  const drain: DrainEntry[] = Array.isArray(raw?.drain) ? raw.drain.flatMap((d: any) => {
    const deadlineMs = typeof d?.deadline === 'string' ? Date.parse(d.deadline) : Number(d?.deadline)
    if (typeof d?.org !== 'string' || !d.org || !Number.isFinite(deadlineMs)) return []
    return [{ org: d.org, targetUtil: num(d.targetUtil, 0.99, 0.5, 0.995), deadlineMs }]
  }) : []
  return {
    enabled: raw?.enabled === true,
    brakeMode: raw?.brakeMode === 'soft' ? 'soft' : 'hard',
    modelGuardScope: raw?.modelGuardScope === 'new' ? 'new' : 'all',
    balanceTargetUtil: num(raw?.balanceTargetUtil, CALIBRATED.balanceTargetUtil, 0.5, 0.99),
    weekBrakeUtil: num(raw?.weekBrakeUtil, CALIBRATED.weekBrakeUtil, 0.5, 1),
    drain,
    gains: {
      kp: num(g.kp, CALIBRATED.gains.kp, 0, 100), ki: num(g.ki, CALIBRATED.gains.ki, 0, 100),
      kd: num(g.kd, CALIBRATED.gains.kd, 0, 100), kff: num(g.kff, CALIBRATED.gains.kff, 0, 100),
    },
    limits: {
      wMax: num(l.wMax, CALIBRATED.limits.wMax, 0.01, 1),
      slewPerHour: num(l.slewPerHour, CALIBRATED.limits.slewPerHour, 0.1, 100),
      integralMax: num(l.integralMax, CALIBRATED.limits.integralMax, 0, 10),
      brakeMargin: num(l.brakeMargin, CALIBRATED.limits.brakeMargin, 0, 0.3),
      derivTauHours: num(l.derivTauHours, CALIBRATED.limits.derivTauHours, 0.01, 5),
    },
    adapt: {
      ...CALIBRATED.adapt,
      kCalByClass: { ...CALIBRATED.adapt.kCalByClass, ...(typeof raw?.kCalByClass === 'object' && raw.kCalByClass ? raw.kCalByClass : {}) },
      kDefault: num(raw?.kDefault, CALIBRATED.adapt.kDefault, 0, 1),
      driftPerHour: num(raw?.driftPerHour, CALIBRATED.adapt.driftPerHour, 0, 0.5),
    },
  }
}

let cachedRules: { mtimeMs: number; path: string; rules: ModelAllowlist } | null = null
/**
 * Правило «организация под модель» из того же файла (поле `orgModels`). Читается ОТДЕЛЬНО от
 * `enabled`: это ограничение, а не настройка регулятора, и действует при выключенном ПИД.
 * Нет файла / нет поля — пустое правило, выбор прежний.
 */
export function loadModelAllowlist(path = DEFAULT_PLACEMENT_CONFIG_PATH): ModelAllowlist {
  try {
    const m = statSync(path).mtimeMs
    if (cachedRules && cachedRules.path === path && cachedRules.mtimeMs === m) return cachedRules.rules
    const rules = parseModelAllowlist(JSON.parse(readFileSync(path, 'utf8')))
    cachedRules = { mtimeMs: m, path, rules }
    return rules
  } catch {
    return new Map()
  }
}

let cached: { mtimeMs: number; path: string; cfg: PlacementControlConfig } | null = null
/** Читает файл, перечитывая только при смене mtime. Нет файла — выключено. */
export function loadPlacementControl(path = DEFAULT_PLACEMENT_CONFIG_PATH): PlacementControlConfig {
  try {
    const m = statSync(path).mtimeMs
    if (cached && cached.path === path && cached.mtimeMs === m) return cached.cfg
    const cfg = parsePlacementControl(JSON.parse(readFileSync(path, 'utf8')))
    cached = { mtimeMs: m, path, cfg }
    return cfg
  } catch {
    return parsePlacementControl(null)
  }
}

/**
 * Состояния регуляторов по организациям — живут в процессе прокси. Ключ состояния включает
 * цель (`drain`/`balance` и её параметры): смена ручки начинает новую траекторию.
 */
export class PlacementController {
  private readonly states = new Map<string, PidState>()
  private lastStepAt = new Map<string, number>()
  /** Последний ответ регулятора по организации — для показа человеку, на выбор не влияет. */
  private lastOut = new Map<string, { weight: number; mode: string; braked: boolean; reason: string; terms: PidOutput['terms']; at: number }>()

  /**
   * 🔴 ЖИВОЕ СОСТОЯНИЕ РЕГУЛЯТОРА (слово фаундера 17.11.2026, TG 89220: «посмотреть, какие ручки в
   * моменте он дергает, как настраивает коэффициенты, чтобы понять, правильный ли он»). Только
   * чтение: что стоит в состоянии и что регулятор ответил в последний раз. Подстроенное усиление —
   * `adaptMul` = 1/θ (θ — во сколько раз сессии жгут окно быстрее, чем на истории); пока
   * наблюдений меньше `minObservations`, множитель честно 1 и это названо.
   */
  snapshot(cfg: PlacementControlConfig, nowMs: number = Date.now()): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = []
    for (const [org, st] of this.states) {
      const last = this.lastOut.get(org)
      const trusted = st.observations >= cfg.adapt.minObservations && st.sxx > 0
      const theta = trusted ? st.sxy / st.sxx : null
      rows.push({
        org,
        lastStepAt: this.lastStepAt.get(org) ?? null,
        // 🔴 ВОЗРАСТ ЗАПИСИ (17.11.2026): шаг делается только при рождении сессии, поэтому «затормозили»
        // может быть решением двухчасовой давности. Без возраста оно читалось как текущее и вводило в
        // заблуждение (elisevruslan: тормоз с 15:27, а окно сбросилось в 15:30).
        lastStepAgeSec: this.lastStepAt.has(org) ? Math.max(0, Math.round((nowMs - this.lastStepAt.get(org)!) / 1000)) : null,
        stale: this.lastStepAt.has(org) ? nowMs - this.lastStepAt.get(org)! > 10 * 60_000 : null,
        observations: st.observations,
        thetaEstimate: theta === null ? null : +theta.toFixed(3),
        adaptTrusted: trusted,
        integral: +st.integral.toFixed(4),
        derivativePerHour: +st.derivFiltered.toFixed(4),
        lastOutput: +st.lastOutput.toFixed(3),
        trajectory: st.t0Ms === null ? null : { startedAt: st.t0Ms, util0: st.util0, targetKey: st.targetKey },
        last: last ?? null,
      })
    }
    return rows
  }

  /**
   * Вес организации для НОВОЙ сессии. `null` — регулятор не участвует (выключен / нет 5ч-окна).
   * Шаг делается не чаще раза в 30 с на организацию — чаще меняется только шум.
   */
  weight(cfg: PlacementControlConfig, orgId: string, windows: PlacementWindow[], sessionsByClass: Record<string, number>, nowMs: number, inflow: boolean): (PidOutput & { mode: 'drain' | 'balance' }) | null {
    if (!cfg.enabled) return null
    const w5 = windows.find(w => w.name === '5h')
    if (!w5 || typeof w5.util !== 'number') return null
    const drain = cfg.drain.find(d => orgId === d.org || orgId.startsWith(d.org))
    const mode: 'drain' | 'balance' = drain && drain.deadlineMs > nowMs ? 'drain' : 'balance'
    const target = mode === 'drain'
      ? { targetUtil: drain!.targetUtil, deadlineMs: drain!.deadlineMs }
      : { targetUtil: cfg.balanceTargetUtil, deadlineMs: w5.resetAt ?? nowMs + 5 * 3_600_000 }
    let st = this.states.get(orgId)
    if (!st) { st = newPidState(); this.states.set(orgId, st) }
    const out = pidStep(st, {
      nowMs, util: w5.util, sessionsByClass, inflowSinceLast: inflow, target,
    }, cfg.gains, cfg.limits, cfg.adapt)
    this.lastStepAt.set(orgId, nowMs)
    this.lastOut.set(orgId, { weight: out.weight, mode, braked: out.braked, reason: out.reason, terms: out.terms, at: nowMs })
    // 🔴 НЕДЕЛЯ — ВТОРОЙ ТОРМОЗ (слово фаундера 14.11.2026, TG 85965: «PID на основе данных об
    // окне, данных об остатке дней до исчерпания»). ПИД ведёт 5ч-окно, а неделя — другое окно
    // с другим сроком: при 5ч 0.48 и неделе 0.99 организация выглядит для ПИД свободной и
    // получает приток, хотя упирается в стену через часы, а сбрасывается через сутки. Тормоз по
    // неделе — тот же порог, что у баланса; НЕ срабатывает, если сброс уже прошёл или пройдёт
    // в ближайшие полчаса (тогда стена снимается сама, и запрет был бы ложным).
    if (mode === 'balance') {
      const w7 = windows.find(w => w.name === 'week')
      const resetsInH = w7 && typeof w7.resetAt === 'number' ? (w7.resetAt - nowMs) / 3_600_000 : Infinity
      if (w7 && typeof w7.util === 'number' && w7.util >= cfg.weekBrakeUtil && !(resetsInH <= 0.5)) {
        return {
          ...out, weight: 0, braked: true, mode,
          reason: `неделя ${(100 * w7.util).toFixed(0)}% ≥ порога ${(100 * cfg.weekBrakeUtil).toFixed(0)}%, сброс через ${resetsInH === Infinity ? '?' : resetsInH.toFixed(1)}ч — приток выключен`,
        }
      }
    }
    // В режиме баланса регулятор — ТОЛЬКО тормоз: вес 1, пока тормоз не сработал. Вести к
    // 0.95 никто не просил; просили «не упереться всем разом» (калибровка, вывод 3).
    if (mode === 'balance') return { ...out, weight: out.braked ? 0 : 1, mode }
    return { ...out, mode }
  }
}
