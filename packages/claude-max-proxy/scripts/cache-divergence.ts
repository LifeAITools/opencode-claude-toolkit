#!/usr/bin/env bun
/**
 * cache-divergence — ПОЧЕМУ холодная запись: показать, ГДЕ разошлись байты и что стояло вокруг.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 24.10.2026): «наш логер, который сравнивает по байтам, позволит нам
 * это увидеть... чтобы он реально сохранял дампы, особенно те, где были холодные записи большие,
 * ... и сам выцеплял место какое-нибудь вокруг того, где байты разошлись, чтобы мы могли
 * посмотреть, а что там было».
 *
 * Замер, из-за которого это понадобилось: по 28 009 вызовам Go промахи в окне 15–20 минут ЧАЩЕ
 * (69%), чем в 20–25 (31%). Временем это невозможно — значит промах даёт смена префикса, и
 * увидеть её можно только сравнением тел.
 *
 * ЧТО ЧИТАЕТ. Каталог, где на каждую сессию лежат ДВА тела запроса подряд:
 *   <session>.prev.json — тело предыдущего вызова
 *   <session>.json      — тело следующего
 * Формат — тот, что пишет захват посредника (`go_orgs.py`: model, system, messages, tools).
 *
 * ЧТО ПЕЧАТАЕТ. По каждой паре — индекс первого разошедшегося сообщения, его роль, и по 200
 * знаков контекста ДО и ПОСЛЕ расхождения с обеих сторон. Плюс сводка: какие места расхождения
 * встречаются чаще всего.
 *
 * Только читает. Ничего не пишет и не меняет.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CONTEXT_CHARS = 200

type Body = { model?: unknown; system?: unknown; messages?: unknown; tools?: unknown }

const textOf = (m: any): string => {
  const c = m?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c.map((p: any) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('')
  }
  return ''
}

const keyOf = (m: any): string => {
  try { return JSON.stringify(m) } catch { return String(m) }
}

const excerpt = (s: string, from: number): string => {
  const start = Math.max(0, from - CONTEXT_CHARS)
  return s.slice(start, Math.min(s.length, from + CONTEXT_CHARS)).replace(/\s+/g, ' ').trim()
}

/** Первое место, где два текста расходятся, — по СИМВОЛАМ, но байтовое смещение считаем тоже. */
function firstDiffInText(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return n
}

interface Finding {
  session: string
  kind: 'system' | 'tools' | 'message-edited' | 'message-inserted' | 'message-removed' | 'same' | 'no-prev'
  index?: number
  role?: string
  before?: string
  after?: string
  byteOffset?: number
}

function compare(session: string, prev: Body, cur: Body): Finding {
  const prevMsgs = Array.isArray(prev?.messages) ? prev!.messages : []
  const curMsgs = Array.isArray(cur?.messages) ? cur!.messages : []

  const sysA = JSON.stringify(prev?.system ?? null)
  const sysB = JSON.stringify(cur?.system ?? null)
  if (sysA !== sysB) {
    const at = firstDiffInText(sysA, sysB)
    return {
      session, kind: 'system', before: excerpt(sysA, at), after: excerpt(sysB, at),
      byteOffset: Buffer.byteLength(sysA.slice(0, at), 'utf8'),
    }
  }

  const toolsA = JSON.stringify(prev?.tools ?? null)
  const toolsB = JSON.stringify(cur?.tools ?? null)
  if (toolsA !== toolsB) {
    const at = firstDiffInText(toolsA, toolsB)
    return {
      session, kind: 'tools', before: excerpt(toolsA, at), after: excerpt(toolsB, at),
      byteOffset: Buffer.byteLength(toolsA.slice(0, at), 'utf8'),
    }
  }

  // Префикс считается по всем сообщениям, кроме последнего: именно он и кэшируется.
  const n = Math.min(prevMsgs.length, curMsgs.length)
  for (let i = 0; i < n; i++) {
    const a = keyOf(prevMsgs[i])
    const b = keyOf(curMsgs[i])
    if (a === b) continue
    const tA = textOf(prevMsgs[i])
    const tB = textOf(curMsgs[i])
    const at = firstDiffInText(tA, tB)
    return {
      session, kind: 'message-edited', index: i,
      role: typeof curMsgs[i]?.role === 'string' ? curMsgs[i].role : '?',
      before: excerpt(tA, at), after: excerpt(tB, at),
      byteOffset: Buffer.byteLength(tA.slice(0, at), 'utf8'),
    }
  }
  if (curMsgs.length > prevMsgs.length) {
    return { session, kind: 'message-inserted', index: prevMsgs.length }
  }
  if (curMsgs.length < prevMsgs.length) {
    return { session, kind: 'message-removed', index: curMsgs.length }
  }
  return { session, kind: 'same' }
}

function main(): void {
  const dir = process.argv[2]
  if (!dir) {
    console.error('usage: cache-divergence <каталог с <session>.json и <session>.prev.json>')
    process.exit(2)
  }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.endsWith('.prev.json'))
  const findings: Finding[] = []
  for (const f of files) {
    const session = f.replace(/\.json$/, '')
    try {
      const cur = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Body
      const prev = JSON.parse(readFileSync(join(dir, `${session}.prev.json`), 'utf8')) as Body
      findings.push(compare(session, prev, cur))
    } catch {
      findings.push({ session, kind: 'no-prev' })
    }
  }

  for (const f of findings) {
    // Дописывание — НЕ расхождение: префикс цел, кэш попадает. Такой ход не переписывает ничего,
    // и показывать его рядом с настоящими расхождениями значило бы размывать картину.
    if (f.kind === 'same' || f.kind === 'message-inserted') continue
    if (f.kind === 'no-prev') { console.log(`\n${f.session}: пары «до/после» нет — сравнивать нечего`); continue }
    console.log(`\n${f.session}: ${f.kind}${f.index !== undefined ? ` #${f.index} (role=${f.role})` : ''}`)
    if (f.byteOffset !== undefined) console.log(`  байтовое смещение расхождения: ${f.byteOffset}`)
    if (f.before) console.log(`  было:  …${f.before}…`)
    if (f.after) console.log(`  стало: …${f.after}…`)
  }

  const tally = new Map<string, number>()
  for (const f of findings) {
    const k = f.kind === 'message-edited'
      ? `правка сообщения #${f.index} (${f.role})`
      : f.kind === 'message-inserted' ? 'дописано (не перепись)' : f.kind
    tally.set(k, (tally.get(k) ?? 0) + 1)
  }
  console.log('\n=== что меняется чаще всего ===')
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(5)}  ${k}`)
  console.log(`\nвсего пар: ${findings.length}`)
}

if (import.meta.main) main()
