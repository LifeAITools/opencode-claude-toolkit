/**
 * S9 — сводка картины «вместе и раздельно» (FR-10/FR-14).
 *
 * Держит главное свойство: ХОСТ — отдельное измерение. Одна организация с двух
 * машин остаётся ДВУМЯ кусками картины, а не сливается в одну строку (риск R3), и
 * токены считаются только по успешным записям.
 */

import { describe, test, expect } from 'bun:test'
import { buildBreakdown, formatBreakdown } from '../src/provider-breakdown.js'

function rec(over: Record<string, unknown> = {}): any {
  return {
    v: 1, ts: '2026-10-15T22:03:00.000Z', host: 'local', door: 'd', provider: 'opencode-go',
    org_id: 'org-a', call_kind: 'real', response: { status: 200 },
    usage_norm: { input: 100, output: 10, cache_read: 40 },
    ...over,
  }
}

describe('S9 — сводка «вместе и раздельно»', () => {
  test('группирует по host → provider → org_id → call_kind', () => {
    const b = buildBreakdown([
      rec(),
      rec({ call_kind: 'warm' }),
      rec({ host: 'prod' }),
      rec({ host: 'prod', provider: 'anthropic', org_id: 'org-b' }),
    ])
    expect(b.rows).toHaveLength(4)
    expect(b.hosts).toEqual(['local', 'prod'])
  })

  test('одна организация с двух хостов — ДВА куска картины, не слиты в один', () => {
    const b = buildBreakdown([rec({ host: 'local' }), rec({ host: 'prod' })])
    const forA = b.rows.filter(r => r.org_id === 'org-a')
    expect(forA).toHaveLength(2)
    expect(forA.map(r => r.host).sort()).toEqual(['local', 'prod'])
  })

  test('токены считаются ТОЛЬКО по успешным; отказы видны в records', () => {
    const b = buildBreakdown([
      rec({ usage_norm: { input: 100, output: 10, cache_read: 40 } }),
      rec({ response: { status: 429 }, usage_norm: { input: 999, output: 999, cache_read: 999 } }),
    ])
    expect(b.rows).toHaveLength(1)
    expect(b.rows[0].records).toBe(2)
    expect(b.rows[0].ok).toBe(1)
    expect(b.rows[0].input).toBe(100)
    expect(b.rows[0].cache_read).toBe(40)
  })

  test('отчёт несёт «раздельно по хостам» и оговорку про деньги', () => {
    const text = formatBreakdown(buildBreakdown([rec({ host: 'local' }), rec({ host: 'prod' })]))
    expect(text).toContain('Раздельно по хостам')
    expect(text).toContain('- local:')
    expect(text).toContain('- prod:')
    expect(text).toContain('ka-subscription-not-api')
  })

  test('пустой дамп — пустая сводка, без выдуманных хостов', () => {
    const b = buildBreakdown([])
    expect(b.rows).toEqual([])
    expect(b.hosts).toEqual([])
    expect(b.records).toBe(0)
  })
})
