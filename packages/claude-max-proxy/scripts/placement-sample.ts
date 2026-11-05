#!/usr/bin/env bun
/**
 * Сэмплер квоты — одна строка на провайдера за проход.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 05.11.2026: «надо, чтобы она понимала реальную текущую
 * загрузку или некую производную»). Анализатор размещения умеет считать скорость
 * только СРЕДНЮЮ С НАЧАЛА ОКНА — другой у него нет. Средняя сглаживает всплеск: если
 * организация разгоняется последние 20 минут, средняя за 4 часа этого не покажет, и
 * посадка нового агента пойдёт туда, где уже горит.
 *
 * Здесь копится РЯД: (время, организация, окна). Из него берётся производная на
 * коротком окне. Файл — данные, не код: удалить = перестать мерить, ничего не сломать.
 *
 *   bun scripts/placement-sample.ts            # один проход (так его зовёт таймер)
 *   bun scripts/placement-sample.ts --provider open-design
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

const HOME = homedir()
const OUT = join(HOME, '.claude-local', 'quota-samples.jsonl')
/** Сколько строк держим: 5-минутный шаг × 288 = сутки. Больше не нужно. */
const KEEP_LINES = 288

const provider = (() => {
  const i = process.argv.indexOf('--provider')
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'opencode-go'
})()

const quotaPath = join(HOME, '.claude-local', `quota-status-${provider}.json`)

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

const doc = readJson(quotaPath)
if (!doc) {
  console.error(`нет отчёта квоты: ${quotaPath}`)
  process.exit(1)
}

function rows(d: any): Array<{ name: string; windows: Array<{ window: string; util: number }> }> {
  const list = Array.isArray(d?.orgs) && d.orgs.length
    ? d.orgs
    : Object.entries(d?.accounts ?? {}).map(([name, a]: [string, any]) => ({ name, ...a }))
  return list
    .filter((o: any) => o && typeof o.name === 'string')
    .map((o: any) => ({
      name: o.name,
      windows: (Array.isArray(o.windows) ? o.windows : [])
        .filter((w: any) => w && typeof w.window === 'string' && typeof w.util === 'number')
        .map((w: any) => ({ window: String(w.window), util: w.util })),
    }))
    .filter((o: any) => o.windows.length > 0)
}

const line = JSON.stringify({
  ts: new Date().toISOString(),
  ms: Date.now(),
  provider,
  measured_at: doc.measured_at ?? doc.updatedAt ?? null,
  orgs: rows(doc),
})

mkdirSync(dirname(OUT), { recursive: true })
appendFileSync(OUT, line + '\n')

// Держим файл коротким: иначе через месяц он станет тем же, чем стал stats.jsonl.
try {
  const all = readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
  if (all.length > KEEP_LINES) writeFileSync(OUT, all.slice(-KEEP_LINES).join('\n') + '\n')
} catch { /* не смогли подрезать — не повод терять проход */ }

if (!existsSync(OUT)) { console.error('строка не записалась'); process.exit(1) }
