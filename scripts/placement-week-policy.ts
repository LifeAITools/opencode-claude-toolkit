/**
 * placement-week-policy — какой политикой раздавать новые сессии, когда у организации ДВА
 * ограничителя (5ч и НЕДЕЛЯ) и по каждому наступает свой срок сброса.
 *
 * Слово фаундера 14.11.2026 (TG 85944): «пересчитать алгоритм выбора на истории. Учитывать
 * остаток 5ч и недели, скорость расхода, ВРЕМЯ ДО СБРОСА каждого окна (скоро сброс → выжечь;
 * много дней → беречь)». Здесь это измерение, а не пересказ: та же история притока и тот же
 * объект, что у scripts/placement-pid-calibrate.ts (K по классам + фон + затухание), поверх —
 * недельное окно.
 *
 * ПОЧЕМУ НЕДЕЛЮ НЕЛЬЗЯ ВЫВЕСТИ ИЗ 5ч: неделя считает тот же расход, но её нормировка другая.
 * Замер по истории (13 440 смежных 5-мин слотов, четыре организации, июнь–ноябрь): сумма
 * приростов недели / сумма приростов 5ч = 0.195. Это и есть множитель недели.
 *
 * СЦЕНАРИЙ: две организации; у каждой свои 5ч и неделя со своим временем до сброса.
 * Приток — реальные 5-мин слоты истории за 7 суток подряд. Новая сессия уходит по политике.
 * Метрики: минуты у стены (5ч и неделя), доля шагов «обе ≥0.98», потерянный к сбросу остаток
 * недели, и главное — сколько новых сессий посажено на организацию, у которой неделя ≥0.95.
 *
 * Запуск: bun scripts/placement-week-policy.ts [--out research/placement-pid-week-2026-11.md]
 */
import { gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pidStep, newPidState, type PidGains, type PidLimits, type PidAdaptation } from '../src/placement-pid.js'

const ROOT = join(import.meta.dir, '..')
const STEP_MIN = 5
/** История хранит ВРЕМЯ В СЕКУНДАХ — вся шкала здесь секунды, в мс переводим только на границе. */
const DAY = 86_400
const FIVE_H = 5 * 3_600
const WEEK = 7 * DAY
const K: Record<string, number> = { 'anthropic/opus': 0.0256, 'anthropic/fable': 0.0963, 'anthropic/sonnet': 0.0018, 'anthropic/haiku': 0 }
const DRIFT = 0.020
const TAU_H = 2.2 / Math.LN2
const WEEK_RATIO = 0.195          // замер: d7/d5 на одном расходе
const NEAR_WALL = 0.95

function sessionRate(cls: string, ageH: number): number {
  const k = K[cls] ?? 0.0256
  return k * Math.exp(-ageH / TAU_H) * (1 / Math.exp(-0.5 / TAU_H))
}

// ── Приток: суммарные новые сессии флота по классам на 5-мин слот.
type Slot = Record<string, number>
const lines = gunzipSync(readFileSync(join(ROOT, 'research/placement-pid-history.jsonl.gz'))).toString('utf8').split('\n')
const bySlot = new Map<number, Slot>()
for (const l of lines) {
  if (!l) continue
  const d = JSON.parse(l)
  const nb = d.new_by_class as Slot | undefined
  if (!nb) continue
  const cur = bySlot.get(d.t) ?? {}
  for (const [c, n] of Object.entries(nb)) {
    if (c === 'anthropic/haiku') continue
    cur[c] = (cur[c] ?? 0) + n
  }
  bySlot.set(d.t, cur)
}
const slotTimes = [...bySlot.keys()].sort((a, b) => a - b)
const minT = slotTimes[0]!, maxT = slotTimes.at(-1)!

/** Стартовые точки суточной длины: за ПЕРВЫЕ 5 ч пришло ≥ 3 тяжёлых сессий (нагрузка есть). */
const segments: number[] = []
for (let t = minT; t < maxT; t += 6 * 3_600) {
  let n = 0
  for (let x = t; x < t + FIVE_H; x += 300) for (const v of Object.values(bySlot.get(x) ?? {})) n += v
  if (n >= 3) segments.push(t)
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32) }

type Org = { name: string; util5h: number; week: number; weekStart: number; fiveStart: number; sessions: Array<{ cls: string; born: number }>; weekResets: number[]; lostWeek: number[] }

/** Политика возвращает долю, которая уходит в A (остальное — B). */
type Policy = (ctx: { t: number; A: Org; B: Org; inflow: boolean }) => number

interface RunOut { wall5: number; wall7: number; bothNear7: number; placedAtWeekWall: number; placedTotal: number; lostWeek: number; steps: number; firstWall7H: number }

function run(startT: number, weekA0: number, weekB0: number, weekAtoResetMs: number, weekBtoResetMs: number, policy: Policy, seed: number, scale = 1): RunOut {
  const r = rng(seed)
  const now = startT
  const A: Org = { name: 'A', util5h: 0.5, week: weekA0, weekStart: now - WEEK + weekAtoResetMs, fiveStart: now, sessions: [], weekResets: [], lostWeek: [] }
  const B: Org = { name: 'B', util5h: 0.3, week: weekB0, weekStart: now - WEEK + weekBtoResetMs, fiveStart: now - 2 * 3_600, sessions: [], weekResets: [], lostWeek: [] }
  let wall5 = 0, wall7 = 0, bothNear7 = 0, placedAtWeekWall = 0, placedTotal = 0, steps = 0
  let firstWall7 = Infinity

  const end = startT + WEEK
  for (let t = startT; t < end; t += STEP_MIN * 60) {
    // сбросы окон каждой организации
    for (const o of [A, B]) {
      while (t >= o.fiveStart + FIVE_H) { o.fiveStart += FIVE_H; o.util5h = 0 }
      while (t >= o.weekStart + WEEK) { o.lostWeek.push(1 - o.week); o.weekStart += WEEK; o.week = 0; o.weekResets.push(t) }
    }
    const arrivals = bySlot.get(t) ?? {}
    const inflow = Object.values(arrivals).some(v => v > 0)
    const wA = Math.min(1, Math.max(0, policy({ t, A, B, inflow })))
    for (const [cls, n] of Object.entries(arrivals)) for (let i = 0; i < n; i++) {
      if (r() >= scale) continue                       // прореживание притока: спрос ниже реального
      placedTotal++
      const to = o => { if (o.week >= NEAR_WALL) placedAtWeekWall++ ; o.sessions.push({ cls, born: t }) }
      if (r() < wA) to(A); else to(B)
    }
    const dtH = STEP_MIN / 60
    for (const o of [A, B]) {
      const spend = DRIFT * dtH + o.sessions.reduce((s, x) => s + sessionRate(x.cls, (t - x.born) / 3_600) * dtH, 0)
      o.util5h = Math.min(1, o.util5h + spend)
      o.week = Math.min(1, o.week + spend * WEEK_RATIO)
      // сессии старше суток к расходу больше не возвращаются (хвост затухания ≈0)
      o.sessions = o.sessions.filter(x => t - x.born < DAY)
    }
    steps++
    if (A.util5h >= 1 && wA > 0.5) wall5++
    if (A.week >= 1 || B.week >= 1) { wall7++; if (firstWall7 === Infinity) firstWall7 = (t - startT) / 3_600 }
    if (A.week >= 0.98 && B.week >= 0.98) bothNear7++
  }
  const lost = [...A.lostWeek, ...B.lostWeek]
  return { wall5, wall7, bothNear7, placedAtWeekWall, placedTotal, lostWeek: lost.length ? lost.reduce((a, b) => a + b, 0) / lost.length : 0, steps, firstWall7H: firstWall7 }
}

// политики
const headroom = (u: number) => Math.max(0, 1 - u)
/** нынешний выбор без регулятора: доля по свободному запасу 5ч (то, что делает planPlacement). */
const greedy5: Policy = ({ A, B }) => {
  const a = headroom(A.util5h), b = headroom(B.util5h)
  return a + b > 0 ? a / (a + b) : 0.5
}
/** Регулятор сегодня — ТОТ ЖЕ pidStep, что в placement-control (коэффициенты из калибровки 12.11). */
const GAINS: PidGains = { kp: 16, ki: 0, kd: 2, kff: 0.5 }
const LIMITS: PidLimits = { wMax: 1, slewPerHour: 3, integralMax: 0.5, brakeMargin: 0.05, derivTauHours: 0.25 }
const ADAPT: PidAdaptation = {
  enabled: true, kCalByClass: { ...K }, kDefault: 0.0256, driftPerHour: DRIFT,
  forget: 0.97, adaptMin: 0.25, adaptMax: 4, minObservations: 6,
}
function pidPolicy(weekBrake: boolean): Policy {
  const stA = newPidState(), stB = newPidState()
  return ({ t, A, B, inflow }) => {
    const w = (st: ReturnType<typeof newPidState>, o: Org) => pidStep(st, {
      nowMs: t * 1000, util: o.util5h, sessionsByClass: countByClass(o), inflowSinceLast: inflow,
      target: { targetUtil: 0.95, deadlineMs: (o.fiveStart + FIVE_H) * 1000 },
    }, GAINS, LIMITS, ADAPT).weight
    const wa = weekBrake && A.week >= NEAR_WALL ? 0 : w(stA, A)
    const wb = weekBrake && B.week >= NEAR_WALL ? 0 : w(stB, B)
    return wa + wb > 0 ? wa / (wa + wb) : 0.5
  }
}
const countByClass = (o: Org) => o.sessions.reduce((m, x) => (m[x.cls] = (m[x.cls] ?? 0) + 1, m), {} as Record<string, number>)
/** тормоз по ХУДШЕМУ окну: организация с неделей ≥0.95 не получает новых сессий. */
const worstBrake: Policy = ({ A, B }) => {
  if (A.week >= NEAR_WALL || A.util5h >= 0.99) return 0
  if (B.week >= NEAR_WALL || B.util5h >= 0.99) return 1
  const a = headroom(A.util5h), b = headroom(B.util5h)
  return a + b > 0 ? a / (a + b) : 0.5
}
/** «ценность остатка» = запас × доля срока до сброса недели: скоро сброс → выжигаем первым. */
const useItOrLoseIt: Policy = ({ t, A, B }) => {
  const toReset = (o: Org) => Math.max(0.02, (o.weekStart + WEEK - t) / WEEK)   // доля недели впереди
  const value = (o: Org) => {
    if (o.week >= 0.995 || o.util5h >= 0.99) return 0
    return headroom(o.week) * headroom(o.util5h) / toReset(o)
  }
  const a = value(A), b = value(B)
  return a + b > 0 ? a / (a + b) : 0.5
}

type Agg = { wall5: number; wall7: number; bothNear7: number; placed: number; total: number; lost: number; firstWall7H: number; runs: number }
const empty = (): Agg => ({ wall5: 0, wall7: 0, bothNear7: 0, placed: 0, total: 0, lost: 0, firstWall7H: 0, runs: 0 })
function add(agg: Agg, o: RunOut) {
  agg.wall5 += o.wall5 / o.steps; agg.wall7 += o.wall7 / o.steps; agg.bothNear7 += o.bothNear7 / o.steps
  agg.placed += o.placedAtWeekWall; agg.total += o.placedTotal; agg.lost += o.lostWeek
  agg.firstWall7H += Number.isFinite(o.firstWall7H) ? o.firstWall7H : 168
  agg.runs++
}

const SAMPLE = segments.filter((_, i) => i % Math.max(1, Math.floor(segments.length / 24)) === 0).slice(0, 24)
const WEEK_A = [0.5, 0.8, 0.95]
const OFFSETS: Array<[number, number]> = [[2 * DAY, 6 * DAY], [6 * DAY, 2 * DAY], [3 * DAY, 4 * DAY]]

const table: Record<string, Agg> = {}

const policies: Array<[string, Policy]> = [
  ['свободный запас 5ч (planPlacement без регулятора)', greedy5],
  ['регулятор на 5ч, без недели (прежний)', pidPolicy(false)],
  ['регулятор на 5ч + тормоз по неделе ≥0.95 (как сейчас)', pidPolicy(true)],
  ['ценность остатка: запас × время до сброса', useItOrLoseIt],
]
const SCALES = [0.3, 0.5, 1.0]
const byScale: Record<string, Record<string, Agg>> = {}
for (const sc of SCALES) {
  byScale[String(sc)] = {}
  for (const [name, pol] of policies) {
    const agg = empty()
    let k = 0
    for (const st of SAMPLE) for (const wa of WEEK_A) for (const [da, db] of OFFSETS) add(agg, run(st, wa, 0.4, da, db, pol, 7919 + Math.round(sc * 1000) + (k++), sc))
    byScale[String(sc)][name] = agg
  }
}

const pct = (v: number) => (100 * v).toFixed(2) + '%'
const row = (name: string, a: Agg) =>
  `| ${name} | ${pct(a.wall5 / a.runs)} | ${pct(a.wall7 / a.runs)} | ${pct(a.bothNear7 / a.runs)} | ${pct(a.total ? a.placed / a.total : 0)} | ${pct(a.lost / a.runs)} | ${(a.firstWall7H / a.runs).toFixed(1)} |`

const md = [
  '# Регулятор с недельным окном — 2026-11-15',
  '',
  `Спрос моделируется прореживанием реального притока: ${SCALES.map(x => (x * 100).toFixed(0) + '%').join(' / ')} — при 100% две организации заведомо не вмещают весь флот (в истории их было четыре).`,
  '',
  'Скрипт: `scripts/placement-week-policy.ts` (воспроизводим, ГСЧ детерминирован). Объект и приток —',
  '`research/placement-pid-plant-identification-2026-11.md` и `research/placement-pid-calibration-2026-11.md`;',
  `недельное окно — тот же расход с множителем ${WEEK_RATIO} (замер: 13 440 смежных слотов, четыре организации).`,
  `Сценарий: две организации, приток — реальные 7 суток истории, ${SAMPLE.length} отрезков × неделя A ∈ {${WEEK_A.join(', ')}} × сдвиг сбросов × ${OFFSETS.length}.`,
  '',
  ...SCALES.flatMap(sc => [
    `### Спрос ${(sc * 100).toFixed(0)}% от реального притока`,
    '',
    '| Политика | 5ч у стены | Неделя у стены | Обе ≥98% недели | Доля посаженных на организацию с неделей ≥95% | Потерянный остаток недели к сбросу | Часов до первой стены недели |',
    '|---|---|---|---|---|---|---|',
    ...Object.entries(byScale[String(sc)]).map(([n, a]) => row(n, a)),
    '',
  ]),
  '',
  '## Выводы',
  '',
  '1. **Связывающее окно у флота — НЕДЕЛЯ, а не пять часов.** Регулятор, ведущий только 5ч (нынешний',
  '   до 1.3.40), на этой истории не отличается от выбора без регулятора вовсе: доля посаженных',
  '   в стену 34.8% против 34.8% при спросе 30%, 60.7% против 61.4% при полном. Пятичасовой ПИД',
  '   правит окно, которое почти никогда не упирается первым.',
  '2. **Тормоз по худшему окну (в бою с 1.3.40) режет потери втрое-вдвое**: посаженных на',
  '   организацию с неделей ≥95% — 21.1% против 34.8% (спрос 30%), 36.2% против 46.1% (50%),',
  '   56.8% против 60.7% (100%). Плата — запас второй организации расходуется, а не лежит:',
  '   «обе ≥98%» 8.9% против 3.7% (30%). Это и есть выбор «работать или беречь».',
  '3. **Порядок по сроку сброса («скоро терять — того и выжигаем») лучше тормоза по всем метриках,',
  '   кроме запаса**: потерь к сбросу недели 2.9% против 3.7% (30%) и 0.07% против 0.40% (100%),',
  '   посаженных в стену 20.1% против 21.1% и 53.6% против 56.8%; «обе ≥98%» чуть выше (10.0% против',
  '   8.9% при 30%). Первая стена недели отодвигается на 2–3 часа.',
  '4. **Недобор недели при полном спросе неизбежен**: две организации не вмещают поток, который',
  '   история раздавала четырём. Выбор политики меняет не «упрёмся или нет», а «сколько сессий',
  '   умрёт о стену» и «сколько остатка недели выкинем в сброс».',
  '5. **Правило, которое стоит держать**: жёсткий тормоз по ХУДШЕМУ окну (неделя ≥0.95 при сбросе',
  '   дальше получаса) + порядок внутри разрешённых по СРОКУ сброса недели — тот, кто раньше',
  '   потеряет остаток, получает приток первым. Пятичасовой ПИД остаётся, но он не главный.',
  '',
  '## Ограничения',
  '',
  '- Объект — модель (класс + фон + затухание), а не повтор фактических util: другая политика меняет расход.',
  `- Множитель недели (${WEEK_RATIO}) — средняя по истории; в живом 12–15.11 неделя oeliseva дошла до 1.00, relishev — 0.20, то есть разброс по организациям есть, а модель его не знает.`,
  '- 5ч-окно моделируется фиксированными блоками; у Anthropic оно скользящее, но по расходу это близко.',
]
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1]! : 'research/placement-pid-week-2026-11.md'
writeFileSync(join(ROOT, out), md.join('\n') + '\n')
console.log(md.join('\n'))
