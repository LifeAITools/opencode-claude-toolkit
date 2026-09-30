/**
 * Разбор ответа на выстрел прогрева (proxy-client.ts, parseSSEToEvents).
 * 30.09.2026: ответ без чисел превращался в «завершение с нулями», и прогрев засчитывался,
 * не продлив кэш. Теперь такой ответ — ошибка, а настоящий ответ — завершение с числами.
 */
import { describe, expect, test } from 'bun:test'
import { _parseKaResponseForTests as parse } from '../src/proxy-client.js'

const streamOf = (text: string) => new Response(text).body!
async function collect(text: string) {
  const out: any[] = []
  for await (const ev of parse(streamOf(text))) out.push(ev)
  return out
}

describe('ответ на выстрел прогрева', () => {
  test('обычный ответ без потока — завершение с числами', async () => {
    const ev = await collect(JSON.stringify({ type: 'message', usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 390_310, cache_creation_input_tokens: 0 } }))
    expect(ev).toHaveLength(1)
    expect(ev[0].type).toBe('message_stop')
    expect(ev[0].usage.cacheReadInputTokens).toBe(390_310)
  })

  test('ошибка внутри потока — ошибка, а не завершение с нулями', async () => {
    const ev = await collect('event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n')
    expect(ev.map((e) => e.type)).toEqual(['error'])
    expect(String(ev[0].error.message)).toContain('overloaded_error')
  })

  test('ответ-ошибка целиком — ошибка', async () => {
    const ev = await collect('{"type":"error","error":{"type":"api_error","message":"x"}}')
    expect(ev.map((e) => e.type)).toEqual(['error'])
  })

  test('ответ без чисел или не разбирается — ошибка', async () => {
    expect((await collect('{"type":"message"}')).map((e) => e.type)).toEqual(['error'])
    expect((await collect('<html>bad gateway</html>')).map((e) => e.type)).toEqual(['error'])
  })

  test('обычный поток — завершение с числами', async () => {
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":2,"output_tokens":0,"cache_read_input_tokens":519348,"cache_creation_input_tokens":0}}}',
      'data: {"type":"message_delta","usage":{"output_tokens":1}}',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')
    const ev = await collect(sse)
    expect(ev.map((e) => e.type)).toEqual(['message_stop'])
    expect(ev[0].usage.cacheReadInputTokens).toBe(519_348)
  })
})
