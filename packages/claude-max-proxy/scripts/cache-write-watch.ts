#!/usr/bin/env bun
/**
 * cache-write-watch — «каждый случай дорогой записи, чтобы можно было расследовать».
 *
 * 🔴 ЗАЧЕМ (слово фаундера 24.10.2026): «надо поставить тебе напоминание, которое отслеживало бы
 * подобные вещи и присылало бы тебе каждый кейс. И ты мог бы его расследовать и понимать, что там
 * произошло — было реально оправдано или это всё-таки сбой. Причём вне зависимости от того, чей
 * это путь: снимать показатели и присылать уведомления, если произошли какие-то дорогие записи,
 * которые были нелегитимны или не санкционированы».
 *
 * ПОЧЕМУ СМОТРИТ В ПОСРЕДНИКА, А НЕ В СВОЮ ДВЕРЬ. Дорогая запись может случиться на ЛЮБОМ входе:
 * моя дверь, прямой маршрут, чужая программа. Единственное место, где сходятся ВСЕ вызовы Go —
 * `LiteLLM_SpendLogs`. Поэтому показатели снимаются там, а не у себя: иначе сторож видит только
 * свой участок и молчит про остальные.
 *
 * ЧТО СЧИТАЕТСЯ КЕЙСОМ. Дорогая запись = большой запрос, который почти не прочитал кэш, и это НЕ
 * первый ход сессии (первый по определению пишет всё — на него жаловаться бессмысленно).
 *
 * КАК ДОСТАВЛЯЕТ. Пишет разбор в `~/.claude-local/cache-write-cases.jsonl` (по строке на кейс) и
 * сводку в `~/.claude-local/cache-write-report.json`. Курсор хранится рядом, поэтому один и тот же
 * случай не приходит дважды. Молчит, когда кейсов нет — тишина значит «нечего расследовать», а не
 * «не смотрел» (и в сводке это сказано явно).
 *
 * Запуск по таймеру: `systemctl --user list-timers cache-write-watch.timer`.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const STATE_DIR = join(HOME, '.claude-local')
const CURSOR = join(STATE_DIR, 'cache-write-watch.cursor.json')
const CASES = join(STATE_DIR, 'cache-write-cases.jsonl')
const REPORT = join(STATE_DIR, 'cache-write-report.json')

const CONTAINER = process.env.CACHE_WATCH_CONTAINER ?? 'kiberos-litellm-db'
const MODEL = process.env.CACHE_WATCH_MODEL ?? 'openai/deepseek-v4.1-flash'
/** Запрос меньше этого не считаем дорогим: разбирательство дороже самой записи. */
const MIN_TOKENS = Number(process.env.CACHE_WATCH_MIN_TOKENS ?? '50000')
/** «Почти не прочитал»: меньше половины запроса пришло из кэша. */
const MISS_SHARE = Number(process.env.CACHE_WATCH_MISS_SHARE ?? '0.5')
/** Предел на прогон, чтобы первый запуск не вывалил месяцы истории. */
const MAX_CASES = Number(process.env.CACHE_WATCH_MAX_CASES ?? '50')

interface Case {
  at: string
  session: string
  model: string
  promptTokens: number
  cachedTokens: number | null
  readShare: number
  idleMin: number | null
  firstOfSession: boolean
  org: string | null
  kind: 'первый ход сессии' | 'дорогая запись'
  verdict: string
}

const psql = (sql: string): string => {
  const p = Bun.spawnSync([
    'docker', 'exec', CONTAINER, 'psql', '-U', 'litellm', '-d', 'litellm',
    '-t', '-A', '-F', '\t', '-c', sql,
  ])
  if (p.exitCode !== 0) throw new Error(p.stderr.toString().slice(0, 300))
  return p.stdout.toString()
}

const readCursor = (): string => {
  try {
    const j = JSON.parse(readFileSync(CURSOR, 'utf8')) as { since?: string }
    if (typeof j.since === 'string' && j.since) return j.since
  } catch { /* нет курсора — начинаем с суток назад */ }
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
}

const main = (): void => {
  mkdirSync(STATE_DIR, { recursive: true })
  const since = readCursor()
  let rows: string
  try {
    rows = psql(`
      with s as (
        select coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') ses,
               "startTime" t, model m, prompt_tokens pt,
               nullif(metadata->'usage_object'->'prompt_tokens_details'->>'cached_tokens','')::int cached,
               metadata->'spend_logs_metadata'->>'go_org' org
        from "LiteLLM_SpendLogs"
        where "startTime" > '${since}'::timestamptz and model = '${MODEL}' and prompt_tokens >= ${MIN_TOKENS}
          and coalesce(metadata->>'session_id', metadata->'spend_logs_metadata'->>'go_session') is not null
      ), o as (
        select ses,t,m,pt,cached,org,
               extract(epoch from (t - lag(t) over (partition by ses order by t)))/60.0 idle,
               row_number() over (partition by ses order by t) rn
        from s where cached is not null
      )
      select to_char(t at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"'), ses, m, pt, cached,
             coalesce(idle::text,''), case when rn = 1 then 't' else 'f' end,
             coalesce(org,'')
      from o
      where (cached::numeric / pt) < ${MISS_SHARE}
      order by t
      limit ${MAX_CASES}`)
  } catch (e) {
    console.error(`не смог прочитать расход: ${(e as Error).message}`)
    process.exit(1)
  }

  const cases: Case[] = []
  let lastName = since
  for (const line of rows.trim().split('\n').filter(Boolean)) {
    const [at, session, model, pt, cached, idle, first, org] = line.split('\t')
    const promptTokens = Number(pt)
    const cachedTokens = Number(cached)
    const firstOfSession = first === 't'
    const readShare = promptTokens > 0 ? cachedTokens / promptTokens : 0
    cases.push({
      at, session, model, promptTokens, cachedTokens, readShare,
      idleMin: idle ? Math.round(Number(idle)) : null,
      firstOfSession,
      org: org || null,
      kind: firstOfSession ? 'первый ход сессии' : 'дорогая запись',
      verdict: firstOfSession
        ? 'ожидаемо: первый ход всегда пишет префикс целиком'
        : readShare === 0
          ? 'ПОДОЗРИТЕЛЬНО: кэш не прочитан ни на байт — либо истёк, либо префикс сменён'
          : 'кэш прочитан частично — смотреть, что менялось в голове контекста',
    })
    lastName = at
  }

  if (cases.length > 0) {
    appendFileSync(CASES, cases.map((c) => JSON.stringify(c)).join('\n') + '\n')
    writeFileSync(CURSOR, JSON.stringify({ since: lastName, updatedAt: new Date().toISOString() }))
  }

  const suspicious = cases.filter((c) => c.kind === 'дорогая запись')
  writeFileSync(REPORT, JSON.stringify({
    checkedAt: new Date().toISOString(),
    since,
    until: lastName,
    cases: cases.length,
    suspicious: suspicious.length,
    silentMeans: 'кейсов нет — это «нечего расследовать», а не «не смотрел»',
    latest: suspicious.slice(-10),
  }, null, 2) + '\n')

  if (cases.length === 0) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), since, cases: 0, suspicious: 0 }))
    return
  }

  for (const c of suspicious) {
    console.log(`\nДОРОГАЯ ЗАПИСЬ ${c.at}  сессия ${c.session.slice(0, 12)}…  орг ${c.org ?? '?'}`)
    console.log(`  запрос ${c.promptTokens} токенов, прочитано ${(c.readShare * 100).toFixed(1)}% (${c.cachedTokens})`)
    console.log(`  простой перед ходом: ${c.idleMin === null ? 'неизвестен' : c.idleMin + ' мин'}`)
    console.log(`  ${c.verdict}`)
  }
  console.log(`\nвсего кейсов ${cases.length}, из них требуют расследования ${suspicious.length}`)
  console.log(`полный разбор: ${CASES}`)
}

main()
