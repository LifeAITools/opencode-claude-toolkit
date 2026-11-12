/**
 * placement-pid — свойства регулятора (план PRPs/placement-pid/plan.md, «Готово, когда»).
 * Коэффициенты здесь НЕ калиброванные — испытания держат устройство (защиты, знаки,
 * границы), а не качество подбора; качество — в отчёте калибровки на истории.
 */
import { describe, test, expect } from 'bun:test'
import {
  pidStep, newPidState, expectedLoadPerHour, sessionClass,
  type PidGains, type PidLimits, type PidAdaptation,
} from '../src/placement-pid.js'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 12, 14, 0)
const gains: PidGains = { kp: 4, ki: 1, kd: 2, kff: 0.5 }
const limits: PidLimits = { wMax: 1, slewPerHour: 2, integralMax: 0.5, brakeMargin: 0.01, derivTauHours: 0.25 }
const adapt: PidAdaptation = {
  enabled: true, kCalByClass: { 'anthropic/opus': 0.04, 'anthropic/haiku': 0.005 }, kDefault: 0.02, driftPerHour: 0,
  forget: 0.98, adaptMin: 0.25, adaptMax: 4, minObservations: 6,
}

describe('классы сессий — провайдер и модель (слово фаундера 12.11)', () => {
  test('сессия Opus весит больше сессии Haiku; неизвестный класс — kDefault', () => {
    expect(expectedLoadPerHour({ 'anthropic/opus': 2 }, adapt)).toBeCloseTo(0.08)
    expect(expectedLoadPerHour({ 'anthropic/haiku': 2 }, adapt)).toBeCloseTo(0.01)
    expect(expectedLoadPerHour({ 'open-design/deepseek': 1 }, adapt)).toBeCloseTo(0.02)
  })
  test('фоновый расход добавляется один раз, даже без сессий', () => {
    expect(expectedLoadPerHour({}, { ...adapt, driftPerHour: 0.02 })).toBeCloseTo(0.02)
    expect(expectedLoadPerHour({ 'anthropic/opus': 1 }, { ...adapt, driftPerHour: 0.02 })).toBeCloseTo(0.06)
  })
  test('sessionClass сводит идентификаторы моделей к семействам', () => {
    expect(sessionClass('anthropic', 'claude-opus-5-5')).toBe('anthropic/opus')
    expect(sessionClass('anthropic', 'claude-haiku-4-5-20251001')).toBe('anthropic/haiku')
    expect(sessionClass('anthropic', 'claude-fable-5-2[1m]')).toBe('anthropic/fable')
  })
})

/**
 * Модель окна: каждая посаженная сессия жжёт k/час (по классу, × θ — «насколько объект
 * горячее калибровки»), живёт lifeH часов. Новые сессии приходят с темпом arrivalsPerHour,
 * и доля из них, равная весу регулятора, садится на нашу организацию.
 */
function simulate(opts: {
  util0: number; target: number; hours: number; arrivalsPerHour: number; lifeH: number
  cls?: string; theta?: number; stepMin?: number
}) {
  const stepMin = opts.stepMin ?? 5
  const k = (adapt.kCalByClass[opts.cls ?? 'anthropic/opus'] ?? adapt.kDefault) * (opts.theta ?? 1)
  const state = newPidState()
  const deadline = T0 + opts.hours * H
  let util = opts.util0
  let sessions: number[] = []          // время окончания каждой посаженной сессии
  let carry = 0
  let maxUtil = util
  let brakedAt: number | null = null
  const weights: number[] = []
  for (let t = T0; t < deadline; t += stepMin * 60_000) {
    sessions = sessions.filter(end => end > t)
    const out = pidStep(state, {
      nowMs: t, util, sessionsByClass: { [opts.cls ?? 'anthropic/opus']: sessions.length },
      inflowSinceLast: opts.arrivalsPerHour > 0, target: { targetUtil: opts.target, deadlineMs: deadline },
    }, gains, limits, adapt)
    weights.push(out.weight)
    if (out.braked && brakedAt === null) brakedAt = t
    carry += opts.arrivalsPerHour * (stepMin / 60) * out.weight
    while (carry >= 1) { sessions.push(t + opts.lifeH * H); carry -= 1 }
    util = Math.min(1, util + sessions.length * k * (stepMin / 60))
    maxUtil = Math.max(maxUtil, util)
  }
  return { finalUtil: util, maxUtil, brakedAt, weights, deadline }
}

describe('pidStep — поведение на модели окна', () => {
  test('ведёт к цели и НЕ перелетает за неё: тормоз по инерции срабатывает раньше стены', () => {
    const r = simulate({ util0: 0.3, target: 0.95, hours: 4, arrivalsPerHour: 20, lifeH: 2 })
    expect(r.finalUtil).toBeGreaterThan(0.8)
    expect(r.maxUtil).toBeLessThanOrEqual(0.995)
    expect(r.brakedAt).not.toBeNull()
    expect(r.brakedAt!).toBeLessThan(r.deadline)
  })

  test('объект вдвое горячее калибровки — адаптация не даёт перелёта', () => {
    const r = simulate({ util0: 0.3, target: 0.95, hours: 4, arrivalsPerHour: 20, lifeH: 2, theta: 2 })
    expect(r.maxUtil).toBeLessThanOrEqual(0.995)
  })

  test('вес никогда не выходит за [0, wMax] и не прыгает быстрее slew', () => {
    const r = simulate({ util0: 0.1, target: 0.99, hours: 3, arrivalsPerHour: 30, lifeH: 1 })
    const maxStep = limits.slewPerHour * (5 / 60) + 1e-9
    for (let i = 0; i < r.weights.length; i++) {
      expect(r.weights[i]!).toBeGreaterThanOrEqual(0)
      expect(r.weights[i]!).toBeLessThanOrEqual(limits.wMax)
      if (i > 0 && r.weights[i]! > 0) expect(r.weights[i]! - r.weights[i - 1]!).toBeLessThanOrEqual(maxStep)
    }
  })
})

describe('pidStep — защиты', () => {
  test('anti-windup: без притока интеграл не копится', () => {
    const s = newPidState()
    const target = { targetUtil: 0.99, deadlineMs: T0 + 4 * H }
    for (let i = 0; i < 24; i++) {
      pidStep(s, { nowMs: T0 + i * 10 * 60_000, util: 0.2, sessionsByClass: {}, inflowSinceLast: false, target }, gains, limits, adapt)
    }
    expect(s.integral).toBe(0)
  })

  test('интеграл ограничен по модулю', () => {
    const s = newPidState()
    const target = { targetUtil: 0.99, deadlineMs: T0 + 48 * H }
    const g = { ...gains, kp: 0, kd: 0, kff: 0, ki: 0.01 }      // выход не насыщается
    for (let i = 0; i < 400; i++) {
      pidStep(s, { nowMs: T0 + i * 10 * 60_000, util: 0.0, sessionsByClass: {}, inflowSinceLast: true, target }, g, limits, adapt)
    }
    expect(Math.abs(s.integral)).toBeLessThanOrEqual(limits.integralMax)
  })

  test('смена цели строит новую линию и обнуляет интеграл (нет удара)', () => {
    const s = newPidState()
    pidStep(s, { nowMs: T0, util: 0.5, sessionsByClass: {}, inflowSinceLast: true, target: { targetUtil: 0.99, deadlineMs: T0 + 4 * H } }, gains, limits, adapt)
    pidStep(s, { nowMs: T0 + H, util: 0.5, sessionsByClass: {}, inflowSinceLast: true, target: { targetUtil: 0.99, deadlineMs: T0 + 4 * H } }, gains, limits, adapt)
    expect(s.integral).not.toBe(0)
    const out = pidStep(s, { nowMs: T0 + H + 1, util: 0.5, sessionsByClass: {}, inflowSinceLast: true, target: { targetUtil: 0.8, deadlineMs: T0 + 6 * H } }, gains, limits, adapt)
    expect(s.integral).toBe(0)
    expect(out.terms.setpoint).toBeCloseTo(0.5, 3)
  })

  test('незамеренный запас — вес не меняется; срок вышел — приток выключен', () => {
    const s = newPidState()
    const target = { targetUtil: 0.99, deadlineMs: T0 + H }
    const a = pidStep(s, { nowMs: T0, util: 0.1, sessionsByClass: {}, inflowSinceLast: true, target }, gains, limits, adapt)
    const b = pidStep(s, { nowMs: T0 + 60_000, util: null, sessionsByClass: {}, inflowSinceLast: true, target }, gains, limits, adapt)
    expect(b.weight).toBe(a.weight)
    const c = pidStep(s, { nowMs: T0 + 2 * H, util: 0.5, sessionsByClass: {}, inflowSinceLast: true, target }, gains, limits, adapt)
    expect(c.weight).toBe(0)
    expect(c.braked).toBe(true)
  })

  test('адаптация зажата границами даже при абсурдной оценке', () => {
    const s = newPidState()
    const target = { targetUtil: 0.99, deadlineMs: T0 + 8 * H }
    let util = 0.1
    let out: any
    for (let i = 0; i < 20; i++) {
      util += 0.05                                     // расход в ~30 раз выше калибровки
      out = pidStep(s, { nowMs: T0 + i * 10 * 60_000, util, sessionsByClass: { 'anthropic/haiku': 1 }, inflowSinceLast: true, target }, gains, limits, adapt)
    }
    expect(out.terms.adapt).toBeGreaterThanOrEqual(adapt.adaptMin)
    expect(out.terms.adapt).toBeLessThanOrEqual(adapt.adaptMax)
  })
})
