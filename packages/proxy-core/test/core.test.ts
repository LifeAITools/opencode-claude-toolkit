import { describe, expect, test } from 'bun:test'
import { teeUsage } from '../src/sse-usage-tee.js'
import { initStore, insertUsage, aggregateUsage } from '../src/stats-store.js'
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

describe('stats-store', () => {
  function tmpDb(): string {
    return join(mkdtempSync(join(tmpdir(), 'proxy-core-db-')), 'stats.sqlite')
  }

  test('insert + aggregate читают ту же строку', () => {
    const path = tmpDb()
    initStore(path)
    insertUsage(path, {
      ts: new Date().toISOString(),
      pid: 1,
      provider: 'openai-compat',
      model: 'coder-model',
      sessionId: 'ses_x',
      inputTokens: 120,
      outputTokens: 3,
      cacheRead: 80,
      cacheWrite: 40,
    })
    const agg = aggregateUsage(path)
    expect(agg.rows).toBe(1)
    expect(agg.totalInput).toBe(120)
    expect(agg.totalCacheRead).toBe(80)
    rmSync(dirnameOnly(path), { recursive: true, force: true })
  })

  test('многократные записи не копят соединений и не падают с BUSY', () => {
    const path = tmpDb()
    initStore(path)
    for (let i = 0; i < 100; i++) {
      insertUsage(path, {
        ts: new Date().toISOString(),
        pid: 2,
        provider: 'openai-compat',
        model: 'coder-model',
        sessionId: null,
        inputTokens: i,
        outputTokens: 1,
        cacheRead: 0,
        cacheWrite: i,
      })
    }
    expect(aggregateUsage(path).rows).toBe(100)
    rmSync(dirnameOnly(path), { recursive: true, force: true })
  })

  test('initStore идемпотентен (повторный вызов не роняет)', () => {
    const path = tmpDb()
    initStore(path)
    expect(() => initStore(path)).not.toThrow()
    rmSync(dirnameOnly(path), { recursive: true, force: true })
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

function dirnameOnly(p: string): string {
  return p.slice(0, p.lastIndexOf('/'))
}