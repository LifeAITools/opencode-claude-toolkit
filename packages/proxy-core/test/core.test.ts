import { describe, expect, test } from 'bun:test'
import { teeUsage } from '../src/sse-usage-tee.js'
import { appendStatsLine, STATS_SCHEMA_VERSION } from '../src/stats-emitter.js'
import { logLine } from '../src/jsonl-logger.js'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  let out = ''
  const dec = new TextDecoder()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    out += dec.decode(chunk.value, { stream: true })
  }
  return out
}

describe('sse-usage-tee', () => {
  test('байты наружу идентичны входу, usage пойман один раз', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":80}}}\n\n',
      'data: [DONE]\n\n',
    ].join('')

    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      },
    })

    const seen: Array<Record<string, unknown>> = []
    const teed = teeUsage(input, (u) => seen.push(u as unknown as Record<string, unknown>))

    const out = await collect(teed)
    expect(out).toBe(sse)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.prompt_tokens).toBe(120)
    expect(seen[0]!.prompt_tokens_details).toEqual({ cached_tokens: 80 })
  })

  test('нет usage — колбэк не зовётся, поток цел', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n'
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(sse))
        c.close()
      },
    })
    let called = false
    const teed = teeUsage(input, () => {
      called = true
    })
    expect(await collect(teed)).toBe(sse)
    expect(called).toBe(false)
  })
})

describe('stats-emitter', () => {
  test('строка валидна и несёт v схемы', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-core-stats-'))
    const path = join(dir, 'stats.jsonl')
    appendStatsLine(path, {
      v: STATS_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      pid: 1,
      type: 'stream',
      model: 'coder-model',
      usage: { in: 10, out: 2, cacheRead: 8, cacheWrite: 2 },
    })
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.v).toBe(STATS_SCHEMA_VERSION)
    expect(line.type).toBe('stream')
    expect(line.usage).toEqual({ in: 10, out: 2, cacheRead: 8, cacheWrite: 2 })
    rmSync(dir, { recursive: true, force: true })
  })

  test('отказ записи не бросает (read-only каталог)', () => {
    // Путь через несуществующий корень: mkdirSync упадёт, append обёрнут — не должно бросить.
    const path = '/proc/definitely-not-writable/stats.jsonl'
    expect(() =>
      appendStatsLine(path, {
        v: STATS_SCHEMA_VERSION,
        ts: new Date().toISOString(),
        pid: 1,
        type: 'stream',
        model: 'm',
        usage: { in: 1, out: 1, cacheRead: 0, cacheWrite: 1 },
      }),
    ).not.toThrow()
  })
})

describe('jsonl-logger', () => {
  test('пишет строку формата {ts,level,kind,msg}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'proxy-core-log-'))
    const path = join(dir, 'log.jsonl')
    logLine(path, { level: 'info', kind: 'INFO', msg: 'hello' })
    const line = JSON.parse(readFileSync(path, 'utf8').trim())
    expect(line.level).toBe('info')
    expect(line.kind).toBe('INFO')
    expect(line.msg).toBe('hello')
    expect(typeof line.ts).toBe('string')
    rmSync(dir, { recursive: true, force: true })
  })
})