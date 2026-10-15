/**
 * WarmPolicy — один интерфейс «греть ли эту ветку кэша сейчас и почему», две политики.
 *
 * Архитектура: /home/relishev/projects/vibe/kiberos-app/PRPs/provider-layer/01-architecture.md §3.3.
 *   A. SubscriptionCountersPolicy (здесь) — подписка Anthropic: чтение кэша БЕСПЛАТНО, довод только
 *      движение счётчиков окна 5ч/7д. Цен в ней нет и быть не может (рельс ka-subscription-not-api).
 *   B. PaidReadPolicy (Go, DashScope) — чтение платное, считаем окупаемость; цены из реестра.
 *      Появится вместе с замерами 5.1–5.2; пока warmQuotaShareMax=0 платный прогрев выключен.
 *
 * ЭТО ЧИСТАЯ ПЕРЕСТАНОВКА, НЕ ПЕРЕМЕНА ПОВЕДЕНИЯ (S0.6). Три решения, которые движок принимал на
 * месте, вынесены сюда слово в слово по смыслу:
 *   1. ветка мертва  — age >= ttl − safetyMargin          → release (снять, выстрел был бы покупкой)
 *   2. ветке пора    — idle >= min(fireThreshold, max(0, ttl − safetyMargin − tick))
 *   3. разговор брошен — realIdle > idleTimeout (умолчание Infinity = никогда, см. журнал 29.08.2026)
 * Проверка: тесты движка зелёные БЕЗ правки ожиданий (test/keepalive-engine.test.ts).
 */

export type ProviderId = 'anthropic' | 'opencode-go' | string

export interface WarmCadence {
  /** Порог «пора» по общему шагу (0.9 × шаг + дрожание), мс. */
  fireThresholdMs: number
  /** Запас до конца срока кэша, мс. */
  safetyMarginMs: number
  /** Шаг пробуждения тика, мс. */
  tickMs: number
  /** Срок простоя настоящей работы, после которого разговор отпускаем; Infinity — никогда. */
  idleTimeoutMs: number
}

export interface WarmContext {
  provider: ProviderId
  /** Организация, за которой ЗАКРЕПЛЕНА сессия (никогда не другая). */
  orgId: string | null
  sessionId: string | null
  /** Простой ветки с её последней записи/чтения кэша (настоящий ход или прогрев), мс. */
  idleMs: number
  /** Возраст кэша ветки с последней записи; <=0 — неизвестен, мс. */
  cacheAgeMs: number
  /** Простой настоящей работы (без прогревов), мс. */
  realIdleMs: number
  /** Срок кэша ДЛЯ ЭТОЙ ветки, мс. */
  ttlMs: number
  cadence: WarmCadence
}

export type WarmDecision =
  | { fire: true; reason: string }
  /** release=true → снять снимок, дать кэшу сгореть; false → просто не сейчас. */
  | { fire: false; release: boolean; reason: string }

export interface WarmPolicy {
  decide(ctx: WarmContext): WarmDecision
}

/**
 * Политика A — подписка Anthropic. Решает по ВРЕМЕНИ, не по деньгам: чтение бесплатно, поэтому
 * единственный довод против выстрела — кэш уже мёртв (выстрел = покупка) или разговор брошен.
 * Стена запаса (quota-stop-line.ts) стоит ПЕРЕД ней, в handleRequest, и сюда не входит.
 */
export class SubscriptionCountersPolicy implements WarmPolicy {
  decide(ctx: WarmContext): WarmDecision {
    const { cadence: c } = ctx
    if (c.idleTimeoutMs !== Infinity && ctx.realIdleMs > c.idleTimeoutMs) {
      return { fire: false, release: true, reason: 'idle_timeout' }
    }
    if (ctx.cacheAgeMs > 0 && ctx.cacheAgeMs >= ctx.ttlMs - c.safetyMarginMs) {
      return { fire: false, release: true, reason: 'cache_dead' }
    }
    const dueAfterMs = Math.min(c.fireThresholdMs, Math.max(0, ctx.ttlMs - c.safetyMarginMs - c.tickMs))
    if (ctx.idleMs >= dueAfterMs) return { fire: true, reason: 'due' }
    return { fire: false, release: false, reason: 'not_due' }
  }
}
