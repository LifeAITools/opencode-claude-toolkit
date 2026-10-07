/**
 * След потока, нативный повтор (src/stream-trace-local.ts): формат ядра
 * дословно — файл, поля, прореживание, атомарность, конец и обрыв.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StreamTracer, streamTracePath } from '../src/stream-trace-local.js'

function dir(): string {
  return mkdtempSync(join(tmpdir(), 'oc-stream-'))
}

describe('след потока', () => {
  test('первый кусок пишется сразу, дальше не чаще 5 с', () => {
    const d = dir()
    try {
      const t = new StreamTracer(d)
      t.delta('ses_a', 'hello')
      let files = readdirSync(d)
      expect(files).toHaveLength(1)
      let st = JSON.parse(readFileSync(join(d, files[0]), 'utf-8'))
      expect(st).toMatchObject({ session_id: 'ses_a', harness: 'claude-code', chars: 5, deltas: 1 })
      expect(st.stream_started_at).toBeTruthy()
      expect(st.ended_at).toBeUndefined()
      t.delta('ses_a', 'world')
      st = JSON.parse(readFileSync(join(d, files[0]), 'utf-8'))
      expect(st.chars).toBe(5) // прорежено — счёт внутри, запись позже
      t.end('ses_a')
      st = JSON.parse(readFileSync(join(d, files[0]), 'utf-8'))
      expect(st.chars).toBe(10)
      expect(st.deltas).toBe(2)
      expect(st.ended_at).toBeTruthy()
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })

  test('обрыв без end — конца нет; end без начала — тишина', () => {
    const d = dir()
    try {
      const t = new StreamTracer(d)
      t.delta('ses_b', 'abc')
      expect(readdirSync(d)).toHaveLength(1)
      const st = JSON.parse(readFileSync(streamTracePath(d, 'ses_b'), 'utf-8'))
      expect(st.ended_at).toBeUndefined() // обрыв: end не звали
      t.end('ses_unknown')
      expect(readdirSync(d)).toHaveLength(1) // чужого файла нет
      t.delta('', 'x')
      expect(readdirSync(d)).toHaveLength(1) // без сессии следа нет
    } finally {
      rmSync(d, { recursive: true, force: true })
    }
  })
})
