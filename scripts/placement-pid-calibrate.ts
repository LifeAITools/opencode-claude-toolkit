/**
 * placement-pid-calibrate — подбор коэффициентов ПИД на истории (PRPs/placement-pid/plan.md).
 *
 * ВХОД: research/placement-pid-history.jsonl.gz — реальный приток НОВЫХ сессий по классам на
 * каждые 5 минут (сумма по всем организациям = поток, который распределитель раздаёт), и
 * параметры объекта из research/placement-pid-plant-identification-2026-11.md:
 *   K_class (доля 5ч на активный сессие-час): opus 0.0256, fable 0.0963, sonnet/haiku ≈ 0;
 *   фоновый расход 0.020/ч на организацию; расход сессии затухает: половина за 2.2 ч,
 *   90% за 5.2 ч (затухание подбирается под эти две точки).
 *
 * СЦЕНАРИЙ «дожечь одну»: две организации, A (цель 0.99 к сбросу окна) и B (принимает
 * остальное). Окно 5 ч. Старт A ∈ {0.1, 0.4, 0.7}. Поток — реальный, из случайного отрезка
 * истории (окна с ненулевым притоком). Новая сессия идёт на A с вероятностью w_A/(w_A+w_B),
 * где w_B = 1 − w_A (ручка смещает, B — остаток).
 *
 * МЕТРИКИ: недобор = max(0, 0.99 − util_A к сроку); перелёт = max(0, max util_A − 0.995);
 * «стена» = доля шагов, когда util_A ≥ 1.0. Счёт = недобор + 10·перелёт + 5·стена; недобор — до min(цель, достижимый потолок притока).
 * Сравнение: жадный выбор (вес ∝ свободному запасу) против ПИД.
 *
 * Запуск: bun scripts/placement-pid-calibrate.ts [--out research/placement-pid-calibration-2026-11.md]
 */
import { gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidStep, newPidState, type PidGains, type PidLimits, type PidAdaptation } from '../src/placement-pid.js'

const ROOT = join(import.meta.dir, '..')
const H = 3_600_000
const STEP_MIN = 5
const K: Record<string, number> = { 'anthropic/opus': 0.0256, 'anthropic/fable': 0.0963, 'anthropic/sonnet': 0.0018, 'anthropic/haiku': 0 }
const DRIFT = 0.020
const WINDOW_H = 5
const TARGET = 0.99

// Затухание расхода сессии: доля потраченного к часу h = 1 − e^(−h/τ), подобрать τ под
// «половина к 2.2 ч» (τ = 2.2/ln2 ≈ 3.17) — к 5.2 ч это даёт 0.81 (замер 0.90): чуть тяжелее
// хвост, осторожная сторона. Мгновенный расход ∝ e^(−age/τ), нормирован так, что в первый
// активный час сессия тратит ≈K (K и мерялся на активных часах).
const TAU_H = 2.2 / Math.LN2
function sessionRate(cls: string, ageH: number): number {
  const k = K[cls] ?? 0.0256
  return k * Math.exp(-ageH / TAU_H) * (1 / Math.exp(-0.5 / TAU_H))
}

// ── Приток из истории: на каждый 5-мин слот — новые сессии по классам, суммарно по флоту.
type Slot = { t: number; arrivals: Record<string, number> }
const lines = gunzipSync(readFileSync(join(ROOT, 'research/placement-pid-history.jsonl.gz'))).toString('utf8').split('\n')
const bySlot = new Map<number, Record<string, number>>()
for (const l of lines) {
  if (!l) continue
  const d = JSON.parse(l)
  const nb = d.new_by_class as Record<string, number> | undefined
  if (!nb) continue
  const cur = bySlot.get(d.t) ?? {}
  for (const [c, n] of Object.entries(nb)) {
    // haiku/sonnet в истории — в основном одноходовые служебные вызовы; в выбор не идут.
    if (c === 'anthropic/haiku') continue
    cur[c] = (cur[c] ?? 0) + n
  }
  bySlot.set(d.t, cur)
}
const slotTimes = [...bySlot.keys()].sort((a, b) => a - b)
const minT = slotTimes[0]!, maxT = slotTimes.at(-1)!
// Стартовые точки: начало каждого часа, где за 5 ч впереди пришло ≥ 3 тяжёлых сессий.
const starts: number[] = []
for (let t = minT; t + WINDOW_H * 3600 <= maxT; t += 3600) {
  let n = 0
  for (let x = t; x < t + WINDOW_H * 3600; x += 300) for (const v of Object.values(bySlot.get(x) ?? {})) n += v
  if (n >= 3) starts.push(t)
}

// ── Детерминированный ГСЧ (повторяемость отчёта).
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32) }

type Policy = (ctx: { t: number; utilA: number; utilB: number; sessA: Record<string, number>; sessB: Record<string, number>; inflow: boolean }) => number
/** Допуск в B (0..1): `null` — B принимает всё, пока не 0.98 (жадный выбор). */
type BGate = ((ctx: { t: number; utilB: number; sessB: Record<string, number>; inflow: boolean }) => number) | null

interface RunResult { finalA: number; maxA: number; wallFrac: number; bothWall: boolean; reach: number }

function run(startT: number, util0: number, policy: Policy, seed: number, bGate: BGate = null): RunResult {
  const r = rng(seed)
  type Sess = { cls: string; born: number }
  const A: Sess[] = [], B: Sess[] = []
  let uA = util0, uB = 0.3, maxA = uA, wall = 0, steps = 0, bothWall = false
  const end = startT + WINDOW_H * 3600
  // Достижимый потолок: ВСЕ новые сессии на A, без потолка 1.0 — сколько вообще можно набрать
  // этим притоком. Недобор считается только до min(цель, потолок): регулятор не виноват, что
  // флот за 5 ч не принёс нагрузки на 99%.
  let reach = util0
  {
    const S: Sess[] = []
    for (let t = startT; t < end; t += STEP_MIN * 60) {
      for (const [cls, n] of Object.entries(bySlot.get(t) ?? {})) for (let i = 0; i < n; i++) S.push({ cls, born: t })
      reach += DRIFT * (STEP_MIN / 60) + S.reduce((sum, s) => sum + sessionRate(s.cls, (t - s.born) / 3600) * (STEP_MIN / 60), 0)
    }
  }
  for (let t = startT; t < end; t += STEP_MIN * 60) {
    const nowMs = t * 1000
    const count = (S: Sess[]) => S.reduce((m, s) => (m[s.cls] = (m[s.cls] ?? 0) + 1, m), {} as Record<string, number>)
    const arrivals = bySlot.get(t) ?? {}
    const inflow = Object.values(arrivals).some(v => v > 0)
    const wA = Math.min(1, Math.max(0, policy({ t: nowMs, utilA: uA, utilB: uB, sessA: count(A), sessB: count(B), inflow })))
    const gB = bGate ? Math.min(1, Math.max(0, bGate({ t: nowMs, utilB: uB, sessB: count(B), inflow }))) : (uB < 0.98 ? 1 : 0)
    // B — не «прими всё»: в живом выборе B закрыта, когда упёрлась (вердикт walled/avoid).
    // Тогда сессия идёт на A, если A не у стены, иначе — в третью организацию (вне учёта):
    // так меряется регулятор A, а не искусственная перегрузка B.
    for (const [cls, n] of Object.entries(arrivals)) for (let i = 0; i < n; i++) {
      const toA = r() < wA
      if (toA) A.push({ cls, born: t })
      else if (r() < gB) B.push({ cls, born: t })
    }
    const dtH = STEP_MIN / 60
    const spend = (S: Sess[]) => DRIFT * dtH + S.reduce((sum, s) => sum + sessionRate(s.cls, (t - s.born) / 3600) * dtH, 0)
    uA = Math.min(1, uA + spend(A)); uB = Math.min(1, uB + spend(B))
    maxA = Math.max(maxA, uA); steps++
    if (uA >= 1) wall++
    if (uA >= 0.98 && uB >= 0.98) bothWall = true
  }
  return { finalA: uA, maxA, wallFrac: wall / steps, bothWall, reach }
}

function score(rs: RunResult[]) {
  let s = 0, under = 0, over = 0, wall = 0, both = 0
  for (const x of rs) {
    const goal = Math.min(TARGET, x.reach)
    const u = Math.max(0, goal - x.finalA), o = Math.max(0, x.maxA - 0.995)
    under += u; over += o; wall += x.wallFrac; both += x.bothWall ? 1 : 0
    s += u + 10 * o + 5 * x.wallFrac
  }
  const n = rs.length
  const reachable = rs.filter(x => x.reach >= TARGET).length / n
  return { score: s / n, under: under / n, over: over / n, wall: wall / n, both: both / n, reachable }
}

// ── Политики.
const greedy: Policy = ({ utilA, utilB }) => {
  const fa = Math.max(0, 1 - utilA), fb = Math.max(0, 1 - utilB)
  return fa + fb > 0 ? fa / (fa + fb) : 0.5
}
/** Жадная «по ручке»: всё на A, пока не 0.99 (как сделал бы человек без регулятора). */
const naiveDrain: Policy = ({ utilA }) => (utilA < TARGET ? 1 : 0)

const ADAPT: PidAdaptation = {
  enabled: true, kCalByClass: K, kDefault: 0.0256, driftPerHour: DRIFT,
  forget: 0.97, adaptMin: 0.25, adaptMax: 4, minObservations: 6,
}
function pidPolicy(gains: PidGains, limits: PidLimits, deadlineMs: number): Policy {
  const st = newPidState()
  return ({ t, utilA, sessA, inflow }) => pidStep(st, {
    nowMs: t, util: utilA, sessionsByClass: sessA, inflowSinceLast: inflow,
    target: { targetUtil: TARGET, deadlineMs },
  }, gains, limits, ADAPT).weight
}

// ── Прогон.
const SAMPLE = starts.filter((_, i) => i % Math.max(1, Math.floor(starts.length / 120)) === 0).slice(0, 120)
const UTIL0 = [0.1, 0.4, 0.7]
function evalPolicy(make: (deadlineMs: number) => Policy, makeB: ((deadlineMs: number) => BGate) | null = null) {
  const rs: RunResult[] = []
  SAMPLE.forEach((st, i) => UTIL0.forEach((u0, j) => {
    const dl = (st + WINDOW_H * 3600) * 1000
    rs.push(run(st, u0, make(dl), 1000 * i + j, makeB ? makeB(dl) : null))
  }))
  return score(rs)
}
/** B в режиме баланса: тот же регулятор, цель «не выше 0.95 к сбросу». */
function balanceGate(gains: PidGains, limits: PidLimits, deadlineMs: number): BGate {
  const st = newPidState()
  return ({ t, utilB, sessB, inflow }) => pidStep(st, {
    nowMs: t, util: utilB, sessionsByClass: sessB, inflowSinceLast: inflow,
    target: { targetUtil: 0.95, deadlineMs },
  }, gains, limits, ADAPT).braked ? 0 : 1
}

const baseLimits: PidLimits = { wMax: 1, slewPerHour: 3, integralMax: 0.5, brakeMargin: 0.01, derivTauHours: 0.25 }
const results: Array<{ name: string; g?: PidGains; l?: PidLimits; s: ReturnType<typeof score> }> = []
results.push({ name: 'жадный (как сейчас)', s: evalPolicy(() => greedy) })
results.push({ name: 'ручка без регулятора (всё на A до 99%)', s: evalPolicy(() => naiveDrain) })

let best: { g: PidGains; l: PidLimits; s: ReturnType<typeof score> } | null = null
for (const kp of [1, 2, 4, 8, 16])
  for (const ki of [0, 0.5, 2, 4])
    for (const kd of [0, 2, 8])
      for (const kff of [0, 0.5])
        for (const brakeMargin of [0.005, 0.02, 0.05]) {
          const g = { kp, ki, kd, kff }, l = { ...baseLimits, brakeMargin }
          const s = evalPolicy(dl => pidPolicy(g, l, dl))
          if (!best || s.score < best.s.score) best = { g, l, s }
        }
results.push({ name: 'ПИД (подобранный)', g: best!.g, l: best!.l, s: best!.s })
results.push({ name: 'ПИД на A + тормоз на B (баланс, цель 0.95)', s: evalPolicy(dl => pidPolicy(best!.g, best!.l, dl), dl => balanceGate(best!.g, best!.l, dl)) })
// Устойчивость лучшего: объект на 50% горячее/холоднее калибровки.
const robust: Array<{ name: string; s: ReturnType<typeof score> }> = []
for (const mul of [0.5, 1.5, 2]) {
  const saved = { ...K }
  for (const k of Object.keys(K)) K[k] = saved[k]! * mul
  robust.push({ name: `объект ×${mul}`, s: evalPolicy(dl => pidPolicy(best!.g, best!.l, dl)) })
  robust.push({ name: `объект ×${mul}, B под тормозом`, s: evalPolicy(dl => pidPolicy(best!.g, best!.l, dl), dl => balanceGate(best!.g, best!.l, dl)) })
  Object.assign(K, saved)
}

const pct = (v: number) => (100 * v).toFixed(2)
const row = (n: string, s: ReturnType<typeof score>) => `| ${n} | ${pct(s.under)} п.п. | ${pct(s.over)} п.п. | ${pct(s.wall)}% | ${pct(s.both)}% | ${s.score.toFixed(4)} |`
const md = [
  '# Калибровка ПИД-регулятора распределения — 2026-11-12',
  '',
  `Скрипт: \`scripts/placement-pid-calibrate.ts\` (воспроизводим, ГСЧ детерминирован). Объект — из`,
  '`research/placement-pid-plant-identification-2026-11.md`; приток — реальный, по 5-мин слотам истории.',
  `Сценарий: дожечь организацию A до ${TARGET} к сбросу 5ч-окна; B принимает остальное. ${SAMPLE.length} отрезков истории × старт A ∈ {${UTIL0.join(', ')}} = ${SAMPLE.length * UTIL0.length} прогонов.`,
  '',
  '| Политика | Недобор до достижимого | Перелёт за 99.5% | Время у стены (A≥100%) | Обе ≥98% разом | Счёт |',
  '|---|---|---|---|---|---|',
  ...results.map(r => row(r.name, r.s)),
  '',
  `Цель 0.99 достижима притоком в ${pct(results[0]!.s.reachable)}% прогонов (в остальных недобор считается до потолка).`,
  '',
  `Подобранные коэффициенты: Kp=${best!.g.kp}, Ki=${best!.g.ki}, Kd=${best!.g.kd}, Kff=${best!.g.kff}, запас тормоза=${best!.l.brakeMargin}, slew=${best!.l.slewPerHour}/ч, |∫|≤${best!.l.integralMax}, τ_D=${best!.l.derivTauHours} ч.`,
  '',
  '## Устойчивость (объект горячее/холоднее калибровки, коэффициенты те же)',
  '',
  '| Сценарий | Недобор | Перелёт | У стены | Обе разом | Счёт |',
  '|---|---|---|---|---|---|',
  ...robust.map(r => row(r.name, r.s)),
  '',
  '## Ограничения',
  '',
  '- Объект — модель (K по классам + фон + экспоненциальное затухание), а не повтор фактических util: ' +
  'распределение сессий другой политикой меняет util, поэтому прямой повтор невозможен.',
  '- Haiku/sonnet в истории — в основном одноходовые служебные вызовы; в притоке не учтены.',
  '- Фоновый расход (0.02/ч) не объяснён — принят постоянным.',
]
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'research/placement-pid-calibration-2026-11.md'
writeFileSync(join(ROOT, out), md.join('\n') + '\n')
console.log(md.join('\n'))
console.log(JSON.stringify({ best: best!.g, limits: best!.l }))
