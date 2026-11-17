/**
 * activity-profile — суточный и недельный ритм расхода флота, из НАШЕЙ же истории.
 *
 * Слово фаундера 17.11.2026 (TG 89200/89208): балансировщику нужно «успеть дорасходовать
 * недельную квоту до сброса, не упираясь в стену, и учитывать рабочие часы — не оставлять на
 * глубокую ночь объёмы, которые ночью точно не потратятся».
 *
 * Что считаем: число ходов по часам суток (UTC — без поправок на пояс и сезон) и по дням
 * недели, из `research/placement-pid-history.jsonl.gz` (5-мин срезы, 4 организации, июнь–ноябрь).
 * Выход — `src/activity-profile.ts`: 24 часовых веса и 7 дневных, оба со средним 1, то есть
 * «час со весом 1 — обычный час», а не «доля суток».
 *
 * Запуск: bun scripts/activity-profile.ts [--write]   (без --write только печатает)
 */
import { gunzipSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const lines = gunzipSync(readFileSync(join(ROOT, 'research/placement-pid-history.jsonl.gz'))).toString('utf8').split('\n')

// Слот приходит по каждой организации отдельно — складываем по времени.
const turnsBySlot = new Map<number, number>()
for (const l of lines) {
  if (!l) continue
  const d = JSON.parse(l) as { t: number; turns?: number }
  turnsBySlot.set(d.t, (turnsBySlot.get(d.t) ?? 0) + (d.turns ?? 0))
}

const hourSum = new Array(24).fill(0), hourN = new Array(24).fill(0)
const daySum = new Array(7).fill(0)
const dayN = new Array(7).fill(0)
for (const [t, n] of turnsBySlot) {
  const dt = new Date(t * 1000)
  hourSum[dt.getUTCHours()] += n; hourN[dt.getUTCHours()]++
  daySum[dt.getUTCDay()] += n; dayN[dt.getUTCDay()]++
}
// История с пропусками (срез есть не за каждые 5 минут), поэтому ВСЁ — среднее на наблюдённый срез,
// а не сумма за сутки: иначе дни с дырами выглядели бы «тихими».
const norm = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return xs.map(x => +(x / m).toFixed(3)) }
const hourly = norm(hourSum.map((s, i) => (hourN[i] ? s / hourN[i] : 0)))
const daily = norm(daySum.map((s, i) => (dayN[i] ? s / dayN[i] : 0)))

const ts = `/**
 * activity-profile — суточный и недельный ритм расхода флота (СГЕНЕРИРОВАНО, не править руками).
 *
 * Источник: \`research/placement-pid-history.jsonl.gz\`; пересчёт: \`bun scripts/activity-profile.ts --write\`.
 * Часы — UTC (в Киеве ноябрём +2). Оба ряда нормированы на среднее 1: вес 1 — «обычный час».
 * срезов по дням недели (вс..сб): ${dayN.join('/')}.
 */
export const HOURLY_WEIGHT_UTC: readonly number[] = ${JSON.stringify(hourly)}
/** Индекс — \`getUTCDay()\`: 0 воскресенье … 6 суббота. */
export const WEEKDAY_WEIGHT_UTC: readonly number[] = ${JSON.stringify(daily)}
`
console.log('hourly (UTC):', hourly.join(' '))
console.log('weekday Sun..Sat:', daily.join(' '))
console.log('night share 22-06 UTC (00-08 Kyiv): %s%', (100 * hourly.slice(0, 6).concat(hourly.slice(22)).reduce((a, b) => a + b, 0) / 24).toFixed(1))
if (process.argv.includes('--write')) { writeFileSync(join(ROOT, 'src/activity-profile.ts'), ts); console.log('written src/activity-profile.ts') }
