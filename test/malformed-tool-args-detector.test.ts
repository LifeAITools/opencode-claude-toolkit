/**
 * ЧЕЙ ЭТО ОБРЕЗОК — НАШ ИЛИ ВЕРХНИЙ.
 *
 * 🔴 ЧЕМ КУПЛЕНО (владелец kiberos-worker, 15.09.2026). Один прогон из восьми
 * вернул HTTP 200 с ЦЕЛЫМ обрамлением — 406 событий, последнее `message_stop` —
 * и БИТЫМ JSON доводов орудия. Его движок упал громко и правильно, но назвать
 * виновного не смог, и я в тот день тоже не смог: тело вниз мы отдаём байт в
 * байт, поэтому по своим записям отличить «пришло битым сверху» от
 * «испортилось ниже нас» было НЕЧЕМ. Номера письма я тогда не записывал вовсе,
 * и поиск по журналу дал ноль, неотличимый от «такого не было».
 *
 * Проверка по ЧИСЛУ событий к этому слепа — у обрезанного потока обрамление
 * целое, — поэтому считаем сами доводы, на тех байтах, что пришли сверху.
 *
 * Здесь проверяется то, ради чего прибор и заводился:
 * 1) битые доводы называются вслух, с номером письма и орудия;
 * 2) целые — молчат (иначе журнал засорится и прибор перестанут читать);
 * 3) НЕЗАКРЫТЫЙ блок считается ОТДЕЛЬНО от битого: «пришло битым» и «не
 *    приехало до конца» лечатся по-разному;
 * 4) пустые доводы (орудие без параметров) — это не порча.
 */

import { describe, test, expect } from 'bun:test'
import { ProxyClient } from '../src/proxy-client.js'

/** Событие SSE строкой, как оно едет по проводу. */
const ev = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`

/** Поток из готовых кусков — ровно то, что получил бы разбор от апстрима. */
function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p))
      c.close()
    },
  })
}

/** Ответ с одним орудием: доводы задаются кусками, закрытие — по желанию. */
function toolResponse(pieces: string[], opts: { close?: boolean; id?: string } = {}) {
  const id = opts.id ?? 'toolu_01KNvsriFnmhp1QG59M2YEwi'
  return [
    ev({ type: 'message_start', message: { id: 'msg_011Cf5d2WD26bH9582ECbXbs', usage: { input_tokens: 275, output_tokens: 1 } } }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'Bash' } }),
    ...pieces.map((p) => ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: p } })),
    ...(opts.close === false ? [] : [ev({ type: 'content_block_stop', index: 0 })]),
    ev({ type: 'message_stop' }),
  ]
}

/** Прогнать разбор и собрать, что он сказал на шину. */
async function whatItSaid(parts: string[]): Promise<any[]> {
  const said: any[] = []
  const client = new ProxyClient({
    eventEmitter: { emit: (e: any) => said.push(e) },
  } as never)
  const session = {
    lastUsage: null,
    engine: { notifyRealRequestComplete: () => {} },
  }
  await (client as any).parseSSEAndNotify(
    streamOf(parts), session, 'sess-probe', 'claude-opus-5', Date.now(),
    'lin:probe', { status: null, resetAt: null, claim: null, retryAfter: null, utilization5h: null, utilization7d: null },
    'req_011Cf5dUepurGuNzuGWJWRRi',
  )
  return said
}

const malformedEvents = (said: any[]) => said.filter((e) => e.kind === 'UPSTREAM_MALFORMED_TOOL_ARGS')

describe('битые доводы орудия называются, а целые — нет', () => {
  test('🔴 битый JSON доводов назван вслух, с номером письма и орудия', async () => {
    // Ровно форма беды соседа: обрамление целое, message_stop на месте, а
    // склеенные доводы не разбираются.
    const said = await whatItSaid(toolResponse(['{"command":"ls -', 'la", "desc']))
    const hits = malformedEvents(said)
    expect(hits.length).toBe(1)
    expect(hits[0].messageId).toBe('msg_011Cf5d2WD26bH9582ECbXbs')
    expect(hits[0].upstreamRequestId).toBe('req_011Cf5dUepurGuNzuGWJWRRi')
    expect(hits[0].malformedToolIds).toEqual(['toolu_01KNvsriFnmhp1QG59M2YEwi'])
  })

  test('целый JSON доводов МОЛЧИТ — иначе прибор засорится и его перестанут читать', async () => {
    const said = await whatItSaid(toolResponse(['{"command":', '"ls -la"}']))
    expect(malformedEvents(said).length).toBe(0)
  })

  test('незакрытый блок считается ОТДЕЛЬНО: не приехало ≠ приехало битым', async () => {
    const said = await whatItSaid(toolResponse(['{"command":"ls'], { close: false }))
    const hits = malformedEvents(said)
    expect(hits.length).toBe(1)
    expect(hits[0].unclosedToolIds).toEqual(['toolu_01KNvsriFnmhp1QG59M2YEwi'])
    expect(hits[0].malformedToolIds).toEqual([])
  })

  test('орудие без параметров — не порча', async () => {
    const said = await whatItSaid(toolResponse([]))
    expect(malformedEvents(said).length).toBe(0)
  })

  test('ответ вовсе без орудий молчит', async () => {
    const said = await whatItSaid([
      ev({ type: 'message_start', message: { id: 'msg_x', usage: { input_tokens: 8, output_tokens: 2 } } }),
      ev({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
      ev({ type: 'message_stop' }),
    ])
    expect(malformedEvents(said).length).toBe(0)
  })

  test('в тексте события сказано, что тело вниз мы не трогаем — это и есть разделитель вины', async () => {
    const said = await whatItSaid(toolResponse(['{"a":']))
    expect(malformedEvents(said)[0].msg).toContain('copies the response body through untouched')
  })
})
