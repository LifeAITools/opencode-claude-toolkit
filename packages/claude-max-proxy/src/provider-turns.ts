/**
 * S0.4 — разборщик «ходы»: из записей provider-dump/v1 строит по каждому разговору таблицу ходов
 * и классифицирует каждый ход холодный / тёплый.
 *
 * Классификация — по ДОЛЕ прочитанного из кэша, а не по среднему (поправка из e32e09a0: среднее
 * смешивало холодные и тёплые ходы и дважды дало ложный вывод «кэш вымывается»).
 *   share = cache_read / input;  cold: share < COLD_BELOW;  warm: share >= WARM_FROM;  между — mixed.
 * Первый ход разговора холодным не считается: кэша ещё не было, это `first`.
 *
 * Деньги: usage × цены реестра (поставщик цену не присылает). Цены приходят аргументом с источником
 * и датой — разборщик сам ни одной цены не знает и не угадывает (риск R5 архитектуры).
 *
 * Берутся только записи `call_kind: 'real'` и `'warm'`, успешные (200). Отказы квоты ходами не
 * считаются: они ничего не прочитали и ничего не стоили.
 */

import type { DumpRecord } from './provider-dump.js'

export const COLD_BELOW = 0.2
export const WARM_FROM = 0.9

export type TurnClass = 'first' | 'cold' | 'warm' | 'mixed' | 'unknown'

export interface RegistryPrices {
  /** Откуда цена и когда замерена — попадает в отчёт. */
  source: string
  date: string
  /** USD за миллион токенов. */
  perMtok: { in: number; out: number; cache_read: number }
}

export interface Turn {
  session_id: string
  org_id: string | null
  ts: string
  call_kind: string
  idle_before_ms: number | null
  input: number | null
  output: number | null
  cache_read: number | null
  share: number | null
  cls: TurnClass
  cost_usd: number | null
}

export interface GapBucket {
  label: string
  fromMs: number
  toMs: number
  turns: number
  cold: number
  coldShare: number | null
}

export interface Report {
  turns: Turn[]
  sessions: number
  byClass: Record<TurnClass, number>
  gaps: GapBucket[]
  totalCostUsd: number | null
  coldCostUsd: number | null
  prices: RegistryPrices | null
}

/** Границы корзин по паузе — под вопрос «где срок кэша» (замер 5.1: 30 мин – 8 ч). */
const BUCKET_EDGES_MIN = [0, 1, 5, 15, 25, 30, 35, 45, 60, 90, 120, 240, 480, Infinity]

export function classify(isFirst: boolean, input: number | null, cacheRead: number | null): { cls: TurnClass; share: number | null } {
  if (isFirst) return { cls: 'first', share: null }
  if (input === null || cacheRead === null || input <= 0) return { cls: 'unknown', share: null }
  const share = cacheRead / input
  if (share < COLD_BELOW) return { cls: 'cold', share }
  if (share >= WARM_FROM) return { cls: 'warm', share }
  return { cls: 'mixed', share }
}

export function costOf(input: number | null, output: number | null, cacheRead: number | null, p: RegistryPrices | null): number | null {
  if (!p || input === null) return null
  const read = cacheRead ?? 0
  const fresh = Math.max(0, input - read)
  return (fresh * p.perMtok.in + read * p.perMtok.cache_read + (output ?? 0) * p.perMtok.out) / 1_000_000
}

export function buildReport(records: DumpRecord[], prices: RegistryPrices | null = null): Report {
  const ok = records
    .filter(r => (r.call_kind === 'real' || r.call_kind === 'warm') && r.response.status === 200 && r.session_id)
    .sort((a, b) => a.ts.localeCompare(b.ts))

  const lastFinish = new Map<string, number>()
  const turns: Turn[] = []
  for (const r of ok) {
    const sid = r.session_id as string
    const start = Date.parse(r.ts)
    const prev = lastFinish.get(sid)
    const { cls, share } = classify(prev === undefined, r.usage_norm.input, r.usage_norm.cache_read)
    turns.push({
      session_id: sid, org_id: r.org_id, ts: r.ts, call_kind: r.call_kind,
      idle_before_ms: prev === undefined ? null : Math.max(0, start - prev),
      input: r.usage_norm.input, output: r.usage_norm.output, cache_read: r.usage_norm.cache_read,
      share, cls, cost_usd: costOf(r.usage_norm.input, r.usage_norm.output, r.usage_norm.cache_read, prices),
    })
    lastFinish.set(sid, start + (r.timing.total_ms ?? 0))
  }

  const byClass: Record<TurnClass, number> = { first: 0, cold: 0, warm: 0, mixed: 0, unknown: 0 }
  for (const t of turns) byClass[t.cls]++

  const gaps: GapBucket[] = []
  for (let i = 0; i < BUCKET_EDGES_MIN.length - 1; i++) {
    const lo = BUCKET_EDGES_MIN[i]! * 60_000
    const hi = BUCKET_EDGES_MIN[i + 1]! * 60_000
    const inB = turns.filter(t => t.idle_before_ms !== null && t.cls !== 'unknown' && t.idle_before_ms >= lo && t.idle_before_ms < hi)
    const cold = inB.filter(t => t.cls === 'cold').length
    gaps.push({
      label: hi === Infinity ? `>=${BUCKET_EDGES_MIN[i]} мин` : `${BUCKET_EDGES_MIN[i]}–${BUCKET_EDGES_MIN[i + 1]} мин`,
      fromMs: lo, toMs: hi, turns: inB.length, cold, coldShare: inB.length ? cold / inB.length : null,
    })
  }

  const costs = turns.map(t => t.cost_usd)
  const known = costs.filter((c): c is number => c !== null)
  const coldKnown = turns.filter(t => t.cls === 'cold' && t.cost_usd !== null).map(t => t.cost_usd as number)
  return {
    turns, sessions: new Set(turns.map(t => t.session_id)).size, byClass, gaps,
    totalCostUsd: prices && known.length ? known.reduce((a, b) => a + b, 0) : null,
    coldCostUsd: prices && known.length ? coldKnown.reduce((a, b) => a + b, 0) : null,
    prices,
  }
}

export function formatReport(rep: Report): string {
  const pct = (x: number | null) => (x === null ? '—' : (x * 100).toFixed(0) + '%')
  const lines: string[] = []
  lines.push(`# Ходы Go: ${rep.turns.length} ходов в ${rep.sessions} разговорах`)
  lines.push('')
  lines.push(`первых ${rep.byClass.first} · холодных ${rep.byClass.cold} · тёплых ${rep.byClass.warm} · смешанных ${rep.byClass.mixed} · без usage ${rep.byClass.unknown}`)
  lines.push(`(холодный: прочитано < ${COLD_BELOW * 100}% входа; тёплый: >= ${WARM_FROM * 100}%; первый ход разговора холодным не считается)`)
  lines.push('')
  lines.push('## Доля холодных ходов по паузе перед ходом')
  lines.push('| пауза | ходов | холодных | доля |')
  lines.push('|---|---|---|---|')
  for (const g of rep.gaps) lines.push(`| ${g.label} | ${g.turns} | ${g.cold} | ${pct(g.coldShare)} |`)
  lines.push('')
  lines.push('Корзины с малым числом ходов (< 10) ненадёжны: не делать по ним вывод о сроке кэша.')
  if (rep.prices && rep.totalCostUsd !== null) {
    lines.push('')
    lines.push('## Деньги по ценам реестра')
    lines.push(`цены: вход ${rep.prices.perMtok.in} · выход ${rep.prices.perMtok.out} · чтение кэша ${rep.prices.perMtok.cache_read} USD/млн (${rep.prices.source}, ${rep.prices.date})`)
    lines.push(`всего ${rep.totalCostUsd.toFixed(4)} USD, из них на холодные ходы ${(rep.coldCostUsd ?? 0).toFixed(4)} USD (${pct(rep.totalCostUsd ? (rep.coldCostUsd ?? 0) / rep.totalCostUsd : null)})`)
  }
  return lines.join('\n')
}
