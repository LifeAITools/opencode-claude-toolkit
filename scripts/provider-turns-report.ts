/**
 * S0.4 — отчёт «ходы» по накопленному provider-dump/v1: холодный/тёплый по паузам, деньги по ценам реестра.
 *   bun scripts/provider-turns-report.ts [--dir ~/.claude-local/provider-dump] [--org имя] [--out файл.md]
 *        [--price-in 0.15 --price-out 0.60 --price-read 0.003 --price-source "подгонка 998 запросов" --price-date 2026-10-15]
 * Без --price-* денег не считает (цену не придумываем). По умолчанию отчёт — в stdout.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { buildReport, formatReport, type RegistryPrices } from '../packages/claude-max-proxy/src/provider-turns.js'
import type { DumpRecord } from '../packages/claude-max-proxy/src/provider-dump.js'

const arg = (n: string): string | undefined => {
  const i = process.argv.indexOf('--' + n)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const dir = arg('dir') ?? join(homedir(), '.claude-local', 'provider-dump')
const org = arg('org')

const records: DumpRecord[] = []
for (const f of readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) {
  for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as DumpRecord
      if (r.v === 1 && (!org || r.org_id === org)) records.push(r)
    } catch { /* битая строка — пропускаем */ }
  }
}

const pin = arg('price-in'), pout = arg('price-out'), pread = arg('price-read')
const prices: RegistryPrices | null = pin && pout && pread
  ? { source: arg('price-source') ?? 'не указан', date: arg('price-date') ?? 'не указана',
      perMtok: { in: Number(pin), out: Number(pout), cache_read: Number(pread) } }
  : null

const text = formatReport(buildReport(records, prices))
const out = arg('out')
if (out) { writeFileSync(out, text + '\n'); console.error(`отчёт: ${out} (${records.length} записей)`) }
else console.log(text)
