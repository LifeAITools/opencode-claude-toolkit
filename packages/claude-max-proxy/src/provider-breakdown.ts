/**
 * S9 — сводка картины «вместе и раздельно» по дампу (FR-10 / FR-14).
 *
 * 🔴 «ВМЕСТЕ И РАЗДЕЛЬНО» — НЕ «ПОСЛЕДНИЙ ПРИШЕДШИЙ» (риск R3). Сборщик держит
 * ХОСТ отдельным измерением, а не сливает записи с двух машин в одну строку: одна
 * и та же организация, видимая с двух хостов, — это два разных куска картины, и
 * сводить их можно только ПОСЛЕ того, как видно, сколько дал каждый.
 *
 * Группировка — по `host` → `provider` → `org_id` → `call_kind`: ровно те оси, по
 * которым спрашивают «сколько, где и чем ходили».
 *
 * 🔴 ДЕНЕГ ЗДЕСЬ НЕТ ВООБЩЕ. Рельс проекта `ka-subscription-not-api`: для Anthropic
 * считаются только счётчики подписки, а не цены API. Деньги (usage × цены реестра)
 * живут в `provider-turns.costOf`, куда цены приходят аргументом с источником и
 * датой; сюда они не заходят, чтобы ни один отчёт не посчитал цену там, где её
 * не существует.
 */

import type { DumpRecord } from './provider-dump.js'

export interface BreakdownRow {
  host: string
  provider: string
  org_id: string | null
  call_kind: string
  /** Все записи группы (включая отказы). */
  records: number
  /** Успешные (status 200) — по ним считаются токены. */
  ok: number
  input: number
  output: number
  cache_read: number
}

export interface Breakdown {
  rows: BreakdownRow[]
  /** Хосты, чьи записи попали в сводку, — по ним и «раздельно». */
  hosts: string[]
  records: number
  ok: number
}

const n = (x: number | null | undefined): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0)

/** Строит сводку. ЧИСТАЯ — на вход записи, на выход строки, ни файлов, ни сети. */
export function buildBreakdown(records: DumpRecord[]): Breakdown {
  const map = new Map<string, BreakdownRow>()
  let totalOk = 0
  for (const r of records) {
    const host = r.host || 'unknown'
    const orgId = r.org_id ?? null
    const key = [host, r.provider, orgId ?? '', r.call_kind].join('\u0000')
    let row = map.get(key)
    if (!row) {
      row = { host, provider: r.provider, org_id: orgId, call_kind: r.call_kind, records: 0, ok: 0, input: 0, output: 0, cache_read: 0 }
      map.set(key, row)
    }
    row.records++
    if (r.response.status === 200) {
      row.ok++
      totalOk++
      row.input += n(r.usage_norm.input)
      row.output += n(r.usage_norm.output)
      row.cache_read += n(r.usage_norm.cache_read)
    }
  }
  const rows = [...map.values()].sort(
    (a, b) =>
      a.host.localeCompare(b.host) ||
      a.provider.localeCompare(b.provider) ||
      (a.org_id ?? '').localeCompare(b.org_id ?? '') ||
      a.call_kind.localeCompare(b.call_kind),
  )
  return { rows, hosts: [...new Set(rows.map(r => r.host))].sort(), records: records.length, ok: totalOk }
}

/** Отчёт: сперва «вместе», затем «раздельно по хостам». */
export function formatBreakdown(b: Breakdown): string {
  const lines: string[] = []
  lines.push(`# Картина дампа: ${b.records} записей, из них успешных ${b.ok}`)
  lines.push('')
  lines.push(`хостов: ${b.hosts.length} (${b.hosts.join(', ') || '—'})`)
  lines.push('')
  lines.push('| хост | поставщик | организация | вид вызова | записей | успешных | вход | выход | чтение кэша |')
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const r of b.rows) {
    lines.push(`| ${r.host} | ${r.provider} | ${r.org_id ?? '—'} | ${r.call_kind} | ${r.records} | ${r.ok} | ${r.input} | ${r.output} | ${r.cache_read} |`)
  }
  lines.push('')
  lines.push('Раздельно по хостам (одна организация с двух машин — два разных куска картины):')
  for (const h of b.hosts) {
    const rs = b.rows.filter(r => r.host === h)
    const ok = rs.reduce((a, r) => a + r.ok, 0)
    const rec = rs.reduce((a, r) => a + r.records, 0)
    lines.push(`- ${h}: ${rec} записей, успешных ${ok}, поставщиков ${new Set(rs.map(r => r.provider)).size}`)
  }
  lines.push('')
  lines.push('Денег здесь нет намеренно: для Anthropic считаются счётчики подписки, а не цены API (рельс `ka-subscription-not-api`).')
  return lines.join('\n')
}
