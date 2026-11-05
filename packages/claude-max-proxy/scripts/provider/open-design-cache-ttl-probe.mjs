#!/usr/bin/env node
/**
 * Замер СРОКА ЖИЗНИ КЭША OpenDesign — тем же способом, каким мерили OpenCode Go.
 *
 * ЗАЧЕМ (слово фаундера 05.11.2026): у Go кэш живёт ~20–25 минут, после получаса идут
 * холодные записи. У OpenDesign он может быть длиннее или короче — от этого зависит,
 * как часто будить агентов, чтобы они не жгли холодную запись.
 *
 * ЛОГИ ФЛОТА ОТВЕТЯТ ПОЗЖЕ, А НУЖЕН ОТВЕТ СЕЙЧАС, ПОЭТОМУ ПРОБА УПРАВЛЯЕМАЯ:
 * одно и то же тело (фиксированный nonce — иначе префикс не совпадёт) отправляется
 * с растущими паузами. Смотрим долю `cached_tokens` при каждом возврате. Пока доля
 * держится — кэш жив; упала — вот и срок.
 *
 * Тело намеренно крупное (~50k токенов): на маленьком префиксе кэш может не включиться
 * вовсе, и «0 из кэша» прочитается как «кэш умер».
 *
 * Результат: ~/.claude-local/open-design-cache-ttl.jsonl (по строке на возврат).
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const OUT = process.env.OD_CACHE_TTL_OUT ?? join(homedir(), '.claude-local', 'open-design-cache-ttl.jsonl')
const KEY = readFileSync(join(homedir(), '.secrets', 'open-design.key'), 'utf8').trim()
const URL = 'https://amr-link.open-design.ai/v1/chat/completions'

/** Паузы в минутах от ПЕРВОГО вызова. 0 — холодная запись, дальше — проверки. */
const GAPS_MIN = (process.env.OD_CACHE_TTL_GAPS ?? '0,15,25,35,45,60,75,90,120').split(',').map(Number)

// Один nonce на весь прогон: префикс обязан совпасть байт в байт, иначе мерим не кэш.
const NONCE = process.env.OD_CACHE_TTL_NONCE ?? `ttl-${Date.now()}`
const BODY = {
  model: 'deepseek-v4.1-flash',
  max_tokens: 4,
  messages: [
    { role: 'system', content: Array.from({ length: 700 }, (_, i) =>
        `[${NONCE}] Правило ${i}: проверяй поле ${i} ровно один раз, не меняй порядок остальных и не переставляй блоки.`).join('\n') },
    { role: 'user', content: 'Reply OK' },
  ],
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function probe(gapMin) {
  const t0 = Date.now()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json', 'user-agent': 'kiberos-cache-ttl/1.0' },
    body: JSON.stringify(BODY),
    signal: AbortSignal.timeout(120_000),
  })
  const text = await res.text()
  if (!res.ok) return { ok: false, status: res.status, error: text.slice(0, 200) }
  const usage = JSON.parse(text).usage ?? {}
  return {
    ok: true,
    prompt: usage.prompt_tokens ?? null,
    cached: usage.prompt_tokens_details?.cached_tokens ?? 0,
    share: usage.prompt_tokens ? (usage.prompt_tokens_details?.cached_tokens ?? 0) / usage.prompt_tokens : null,
  }
}

const startedAt = new Date().toISOString()
let prev = 0
console.log(`[od-ttl] старт ${startedAt} nonce=${NONCE} паузы=${GAPS_MIN.join(',')} мин`)
for (const gapMin of GAPS_MIN) {
  const waitMs = Math.max(0, gapMin - prev) * 60_000 - (Date.now() - Date.parse(startedAt))
  if (waitMs > 0) await sleep(waitMs)
  prev = gapMin
  let row
  try { row = await probe(gapMin) } catch (err) { row = { ok: false, error: String(err).slice(0, 200) } }
  const rec = { at: new Date().toISOString(), gapMin, nonce: NONCE, ...row }
  appendFileSync(OUT, JSON.stringify(rec) + '\n')
  console.log(`[od-ttl] +${gapMin}м →`, row.ok ? `prompt ${row.prompt}, из кэша ${row.cached} (${Math.round((row.share ?? 0) * 1000) / 10}%)` : `ОТКАЗ ${row.status ?? ''} ${row.error ?? ''}`)
}
console.log(`[od-ttl] готово, строки в ${OUT}`)
