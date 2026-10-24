#!/usr/bin/env bun
/**
 * cache-metrics — та же таблица жизни кэша, одной командой.
 *
 * 🔴 ЗАЧЕМ. Метод замера записан в знания проекта, но пока он жил только как SQL в переписке,
 * «снять метрики» значило вспоминать запрос заново — а заново собранный замер и разошёлся с
 * прежним дважды за один день. Инструмент один, числа сопоставимы.
 *
 * ЧТО СЧИТАЕТ. Для маршрута OpenCode Go (`model = openai/deepseek-v4.1-flash`,
 * `api_base = .../inference/go/openai/v1`) — по каждому окну простоя между вызовами ОДНОЙ сессии:
 *   • медиана доли прочитанного от запроса,
 *   • доля ПОЛНЫХ попаданий (>90%),
 *   • доля ровно-нулевых чтений.
 *
 * 🔴 ГЛАВНОЕ ПРАВИЛО (рельс `null-is-not-zero-in-measurements`): строки, где поставщик НЕ ОТДАЛ
 * `cached_tokens` (NULL), ИСКЛЮЧАЮТСЯ. Свернуть их в 0 — значит посчитать «не измерено» за
 * «не прочитано»: именно на этом замер 24.10.2026 дал ложную аномалию «в 15–20 хуже, чем в 20–25»
 * и чуть не сузил окно прогрева у соседа. Их количество печатается отдельно — чтобы «не знаю»
 * было видно, а не проглочено.
 *
 * Использование:
 *   bun scripts/cache-metrics.ts                # 48 часов, маршрут Go
 *   bun scripts/cache-metrics.ts --hours 24
 *   bun scripts/cache-metrics.ts --container kiberos-litellm-db --model openai/deepseek-v4.1-flash
 */

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const HOURS = Number(argOf('hours', '48'))
const CONTAINER = argOf('container', 'kiberos-litellm-db')
const MODEL = argOf('model', 'openai/deepseek-v4.1-flash')

if (!Number.isFinite(HOURS) || HOURS <= 0) {
  console.error('--hours должен быть положительным числом')
  process.exit(2)
}

/** Окна подобраны по перелому: до 30/40/45/50 видно, где именно ломается. */
const BUCKETS = `
  case when rn = 1 then '00 первый запрос сессии'
       when idle < 5 then '01 0-5 мин'
       when idle < 15 then '02 5-15'
       when idle < 20 then '03 15-20'
       when idle < 25 then '04 20-25'
       when idle < 30 then '05 25-30'
       when idle < 40 then '06 30-40'
       when idle < 50 then '07 40-50'
       when idle < 60 then '08 50-60'
       when idle < 180 then '09 60-180'
       else '10 >180' end`

const SQL = `
with s as (
  select coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') ses,
         "startTime" t,
         prompt_tokens pt,
         nullif(metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens','')::int cached
  from "LiteLLM_SpendLogs"
  where "startTime" > now() - interval '${HOURS} hours'
    and model = '${MODEL}'
    and prompt_tokens > 20000
    and coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') is not null
), o as (
  select ses, t, pt, cached,
         extract(epoch from (t - lag(t) over (partition by ses order by t)))/60.0 idle,
         row_number() over (partition by ses order by t) rn
  from s
), known as (select * from o where cached is not null)
select ${BUCKETS} bucket,
       count(*) n,
       round(percentile_cont(0.5) within group (order by 100.0*cached/pt)::numeric, 1) median_pct,
       round(100.0*sum(case when cached > 0.9*pt then 1 else 0 end)/count(*), 1) full_hit_pct,
       round(100.0*sum(case when cached = 0 then 1 else 0 end)/count(*), 1) zero_pct
from known
where rn > 1 or rn = 1
group by 1
order by 1;`

/**
 * 🔴 ЧИСТАЯ ЛИНИЯ: считать потери ТОЛЬКО у тех сессий, где предыдущий вызов был полным попаданием.
 *
 * Слово фаундера 24.10.2026: «побудка не 84% — там скорее всего подмешиваются странные кейсы,
 * которые мы не выделили». Он прав. Без этого условия в «промахи» попадают сессии, у которых и
 * до этого было плохо: предыдущий вызов отказал (в бурю 429) или уже прочитал половину.
 * Промах такой сессии — не работа времени, а её собственная история, и в среднем он выглядит как
 * «кэш умер за 20 минут».
 */
const CLEAN_SQL = `
with s as (
  select coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') ses,
         "startTime" t, prompt_tokens pt,
         nullif(metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens','')::int cached
  from "LiteLLM_SpendLogs"
  where "startTime" > now() - interval '${HOURS} hours' and model = '${MODEL}'
    and prompt_tokens > 20000
    and coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') is not null
), o as (
  select ses,t,pt,cached,
         extract(epoch from (t - lag(t) over (partition by ses order by t)))/60.0 idle,
         lag(cached) over (partition by ses order by t) prev_cached,
         lag(pt) over (partition by ses order by t) prev_pt,
         row_number() over (partition by ses order by t) rn
  from s
), known as (
  select * from o
  where cached is not null and rn > 1 and idle is not null
    and prev_cached is not null and prev_pt is not null and prev_cached > 0.9*prev_pt
)
select ${BUCKETS} bucket, count(*) n,
       round(percentile_cont(0.5) within group (order by 100.0*cached/pt)::numeric, 1) median_pct,
       round(100.0*sum(case when cached > 0.9*pt then 1 else 0 end)/count(*), 1) full_hit_pct
from known group by 1 order by 1;`

const unknownSql = `
select count(*) from "LiteLLM_SpendLogs"
where "startTime" > now() - interval '${HOURS} hours'
  and model = '${MODEL}' and prompt_tokens > 20000
  and metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens' is null;`

const run = (sql: string): string => {
  const p = Bun.spawnSync([
    'docker', 'exec', CONTAINER, 'psql', '-U', 'litellm', '-d', 'litellm',
    '-t', '-A', '-F', '\t', '-c', sql,
  ])
  if (p.exitCode !== 0) {
    console.error(`psql через ${CONTAINER} не ответил: ${p.stderr.toString().slice(0, 300)}`)
    process.exit(1)
  }
  return p.stdout.toString()
}

const rows = run(SQL).trim().split('\n').filter(Boolean).map((line) => line.split('\t'))
const unknown = run(unknownSql).trim()

const pad = (s: string, w: number) => (s.length >= w ? s : s + ' '.repeat(w - s.length))
const cleanRows = run(CLEAN_SQL).trim().split('\n').filter(Boolean).map((line) => line.split('\t'))

console.log(`\nМаршрут: ${MODEL}   окно: ${HOURS} ч   (все вызовы с известной цифрой)\n`)
console.log(pad('окно простоя', 24) + pad('n', 8) + pad('медиана', 10) + pad('полных', 10) + 'ровно 0')
console.log('-'.repeat(62))
for (const [bucket, n, median, full, zero] of rows) {
  console.log(pad(bucket ?? '', 24) + pad(n ?? '', 8) + pad(`${median ?? '-'}%`, 10) + pad(`${full ?? '-'}%`, 10) + `${zero ?? '-'}%`)
}
console.log('-'.repeat(62))
console.log(`строк, где поставщик НЕ отдал цифру (NULL, исключены): ${unknown}`)
console.log('🔴 NULL — это «не измерено», а не ноль. Именно их свёртывание в 0 дало ложную аномалию 24.10.')

console.log(`\nЧИСТАЯ ЛИНИЯ: только сессии, где ПРЕДЫДУЩИЙ вызов был полным попаданием\n`)
console.log(pad('окно простоя', 24) + pad('n', 8) + pad('медиана', 10) + 'полных')
console.log('-'.repeat(50))
for (const [bucket, n, median, full] of cleanRows) {
  console.log(pad(bucket ?? '', 24) + pad(n ?? '', 8) + pad(`${median ?? '-'}%`, 10) + `${full ?? '-'}%`)
}
console.log('-'.repeat(50))
console.log('Здесь промах — работа ВРЕМЕНИ. Смешанная таблица выше включает сессии, у которых было плохо и до этого.')
