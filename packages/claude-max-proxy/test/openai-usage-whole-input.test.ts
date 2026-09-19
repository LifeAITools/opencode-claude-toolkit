/**
 * УЧЁТ ВХОДА У ДВЕРИ, СОВМЕСТИМОЙ С OpenAI, — ПО ПРАВИЛАМ ЭТОГО ФОРМАТА.
 *
 * 🔴 ЗАМЕР ВЛАДЕЛЬЦА kiberos-app, 19.09.2026, И ЧЕМ ОН ОБЕРНУЛСЯ У ЧЕЛОВЕКА.
 * Два одинаковых запроса подряд, тело около 6 500 токенов:
 *
 *     первый:  prompt_tokens=2, cached_tokens=0
 *     второй:  prompt_tokens=2, cached_tokens=6422
 *
 * То есть мы отдавали в `prompt_tokens` ТОЛЬКО свежие токены, а прочитанное из
 * кэша клали рядом. В формате OpenAI это читается наоборот: `prompt_tokens` —
 * ВЕСЬ вход, а `cached_tokens` — та его ЧАСТЬ, что пришла из кэша. Всякое
 * приложение, считающее нас поставщиком этого формата, берёт `prompt_tokens`
 * как есть и ничего не складывает.
 *
 * Цена ошибки на одном живом ходе человека в чате kiberos-app:
 *     правда по нашему журналу:  2 свежих + 40 977 чтения + 5 267 записи = 46 246
 *     что увидел счётчик у человека:                                     ~1 500
 * Человек видит «занято 0 %» на разговоре, который съел полсотни тысяч, и
 * упирается в потолок внезапно. А сосед на этих же числах собирался считать
 * тариф посторонним людям.
 *
 * 🔴 И ВТОРАЯ ПОЛОВИНА, КОТОРУЮ ОН НАЗВАЛ ТОЧНО: ЗАПИСЬ КЭША НЕ ПРИХОДИЛА
 * НИКУДА. В потоковом пути её считали и не отдавали, в непотоковом не читали
 * вовсе. Запись — самый дорогой вид входа, и потребитель без неё недосчитывает
 * расход именно там, где тот самый большой.
 */

import { describe, test, expect } from 'bun:test'
import { transformAnthropicSSEToOpenAI, bufferToNonStreaming } from '../src/openai-translate.js'

const OPTS = {
  id: 'chatcmpl-test',
  model: 'claude-sonnet-5',
  created: 1700000000,
  systemFingerprint: 'claude-max-proxy-test',
  includeUsage: true,
  isJsonSchema: false,
  schemaToolName: '',
} as never

/** Тот же набор событий, что шлёт Anthropic: свежие + чтение + запись. */
const СОБЫТИЯ = [
  {
    type: 'message_start',
    message: {
      usage: {
        input_tokens: 2,
        output_tokens: 0,
        cache_read_input_tokens: 40_977,
        cache_creation_input_tokens: 5_267,
      },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ответ' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 11 } },
  { type: 'message_stop' },
]

function ответSSE(events: unknown[]): Response {
  const body = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(new TextEncoder().encode(body), {
    headers: { 'content-type': 'text/event-stream' },
  })
}

async function собратьУчёт(r: Response): Promise<any> {
  const text = await r.text()
  const куски = text.split('\n\n')
    .filter(l => l.startsWith('data: ') && !l.includes('[DONE]'))
    .map(l => JSON.parse(l.slice(6)))
  return куски.reverse().find(c => c.usage)?.usage
}

/** Правда этого хода: весь вход — свежее плюс чтение плюс запись. */
const ВЕСЬ_ВХОД = 2 + 40_977 + 5_267   // 46 246

describe('учёт входа: prompt_tokens — это ВЕСЬ вход', () => {
  test('🔴 ПОТОКОВЫЙ ОТВЕТ: весь вход, а не только свежие два токена', async () => {
    const u = await собратьУчёт(transformAnthropicSSEToOpenAI(ответSSE(СОБЫТИЯ), OPTS))
    expect(u.prompt_tokens).toBe(ВЕСЬ_ВХОД)
  })

  test('🔴 НЕПОТОКОВЫЙ ОТВЕТ: ровно то же число — пути не должны расходиться', async () => {
    const r = await bufferToNonStreaming(ответSSE(СОБЫТИЯ), OPTS)
    const j = await r.json() as any
    expect(j.usage.prompt_tokens).toBe(ВЕСЬ_ВХОД)
  })

  test('прочитанное из кэша — ЧАСТЬ входа, а не слагаемое рядом с ним', async () => {
    const u = await собратьУчёт(transformAnthropicSSEToOpenAI(ответSSE(СОБЫТИЯ), OPTS))
    expect(u.prompt_tokens_details.cached_tokens).toBe(40_977)
    expect(u.prompt_tokens_details.cached_tokens).toBeLessThanOrEqual(u.prompt_tokens)
  })

  test('🔴 ЗАПИСЬ КЭША ДОЕЗЖАЕТ — она самый дорогой вид входа', async () => {
    const u = await собратьУчёт(transformAnthropicSSEToOpenAI(ответSSE(СОБЫТИЯ), OPTS))
    expect(u.prompt_tokens_details.cache_creation_tokens).toBe(5_267)

    const j = await (await bufferToNonStreaming(ответSSE(СОБЫТИЯ), OPTS)).json() as any
    expect(j.usage.prompt_tokens_details.cache_creation_tokens).toBe(5_267)
  })

  test('итог сходится: весь вход плюс выход', async () => {
    const u = await собратьУчёт(transformAnthropicSSEToOpenAI(ответSSE(СОБЫТИЯ), OPTS))
    expect(u.total_tokens).toBe(u.prompt_tokens + u.completion_tokens)
    expect(u.completion_tokens).toBe(11)
  })

  test('без кэша вовсе учёт прежний — починка не раздувает обычный ход', async () => {
    const простой = [
      { type: 'message_start', message: { usage: { input_tokens: 130, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ок' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]
    const u = await собратьУчёт(transformAnthropicSSEToOpenAI(ответSSE(простой), OPTS))
    expect(u.prompt_tokens).toBe(130)
    expect(u.prompt_tokens_details.cached_tokens).toBe(0)
    expect(u.prompt_tokens_details.cache_creation_tokens).toBe(0)
  })
})
