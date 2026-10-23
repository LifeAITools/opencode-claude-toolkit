/**
 * Снимок МЕСТА переписи на двери Go.
 *
 * 🔴 ЗАЧЕМ (слово фаундера 23.10): «в логах показать, ГДЕ байты разошлись и что поменялось».
 * 1.1.75 назвала место индексом и ролью — но не сказала, С ЧЕГО НА ЧТО. Хеши отвечают
 * «сообщение #N изменилось» и молчат о содержимом.
 *
 * 🔴 ПОЧЕМУ ГОЛОВА, А НЕ ВСЁ ТЕЛО: 2000 сессий по мегабайту в памяти — это не диагностика,
 * а второй кэш. Замер 23.10: 92% переписей — «промпт вырос, а кэша нет», то есть
 * расхождение в РАННЕЙ части; первых восьми сообщений хватает. Не покрыло — прибор
 * говорит «не снято (место за пределами головы)», а не делает вид, что снял.
 *
 * Каталог снимков — тот же, что у дампов тел, поэтому TTL и потолок объёма body-capture
 * накрывают их без отдельной политики хранения.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  analyse, commitPrefix, rememberedHeadLength, writeRewriteSnapshot, type PrefixAnalysis,
} from '../src/modules/go-door.js'

const m = (t: string) => ({ role: 'user', content: t })
const session = () => `ses_${Math.random().toString(36).slice(2)}`
const freshDir = () => mkdtempSync(join(tmpdir(), 'go-rewrite-snap-'))

describe('голова истории — что помним для снимка', () => {
  test('запоминается ровно первые восемь сообщений из двенадцати', () => {
    const s = session()
    const msgs = Array.from({ length: 12 }, (_, i) => m(`m${i}`))
    commitPrefix(s, { messages: msgs }, { now: 1 })
    expect(rememberedHeadLength(s)).toBe(8)
  })

  test('короткая история запоминается целиком', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b')] }, { now: 1 })
    expect(rememberedHeadLength(s)).toBe(2)
  })

  test('новая история ЗАМЕНЯЕТ голову, а не дописывается к ней', () => {
    const s = session()
    commitPrefix(s, { messages: [m('a'), m('b'), m('c')] }, { now: 1 })
    commitPrefix(s, { messages: [m('X'), m('Y')] }, { now: 2 })
    expect(rememberedHeadLength(s)).toBe(2)
  })

  test('неопознанная сессия головы не имеет', () => {
    expect(rememberedHeadLength(null)).toBe(0)
    expect(rememberedHeadLength('ses_never_seen')).toBe(0)
  })
})

describe('снимок разошедшегося сообщения — с чего на что', () => {
  const analysisOf = (s: string, next: any): PrefixAnalysis => {
    commitPrefix(s, { messages: [m('system'), m('ПЕРВОЕ'), m('ВТОРОЕ')] }, { now: 1 })
    return analyse(s, next, 2)
  }

  test('пишет файл с прежним и новым содержимым и названным местом', () => {
    const dir = freshDir()
    process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR = dir
    try {
      const s = session()
      // Голову снимаем ДО commit — так же, как это делает serve().
      commitPrefix(s, { messages: [m('system'), m('ПЕРВОЕ'), m('ВТОРОЕ')] }, { now: 1 })
      const next = { messages: [m('system'), m('ИЗМЕНЕНО'), m('ВТОРОЕ'), m('ТРЕТЬЕ')] }
      const a = analyse(s, next, 2)
      expect(a.verdict).toBe('rewrite')
      const path = writeRewriteSnapshot({
        sessionId: s, model: 'deepseek-v4-flash', analysis: a,
        prevSnippet: JSON.stringify(m('ПЕРВОЕ')).slice(0, 2048),
        curSnippet: JSON.stringify(m('ИЗМЕНЕНО')).slice(0, 2048),
        now: 1_700_000_000_000,
      })
      expect(path).toBeTruthy()
      expect(existsSync(path as string)).toBe(true)
      const body = JSON.parse(readFileSync(path as string, 'utf8'))
      expect(body.sessionId).toBe(s)
      expect(body.firstDiffIndex).toBe(1)
      expect(body.prev).toContain('ПЕРВОЕ')
      expect(body.cur).toContain('ИЗМЕНЕНО')
      expect(body.snippetChars).toBe(2048)
      expect(body.door).toBe('opencode-go')
      expect(body.avoidableRewrite).toBe(true)
    } finally {
      delete process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
    }
  })

  test('снимки выключены — файла нет и путь null (не тихая запись мимо флага)', () => {
    const dir = freshDir()
    process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR = dir
    process.env.CLAUDE_MAX_PROXY_CAPTURE_BODIES = '0'
    try {
      const s = session()
      const a = analysisOf(s, { messages: [m('S'), m('ДРУГОЕ'), m('ВТОРОЕ'), m('T')] })
      const path = writeRewriteSnapshot({
        sessionId: s, model: null, analysis: a, prevSnippet: null, curSnippet: null, now: 1,
      })
      expect(path).toBeNull()
      expect(existsSync(join(dir, 'go-rewrite-' + s + '-1.json'))).toBe(false)
    } finally {
      delete process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
      delete process.env.CLAUDE_MAX_PROXY_CAPTURE_BODIES
    }
  })

  test('имя файла безопасно: чужие символы в имени сессии не ломают путь', () => {
    const dir = freshDir()
    process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR = dir
    try {
      const a: PrefixAnalysis = { verdict: 'rewrite', firstDiffIndex: 0, role: 'user', prevMsgs: 2, msgs: 3 }
      const path = writeRewriteSnapshot({
        sessionId: '../evil/ses x', model: null, analysis: a, prevSnippet: 'a', curSnippet: 'b', now: 7,
      })
      expect(path).toBeTruthy()
      expect((path as string).startsWith(dir)).toBe(true)
      expect((path as string)).not.toContain('..')
    } finally {
      delete process.env.CLAUDE_MAX_PROXY_CAPTURE_DIR
    }
  })
})
