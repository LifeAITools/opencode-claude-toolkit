/**
 * След пути побудки (onWakeTrace) + честная очередь drain (wake-listener.ts).
 * Жалоба 06.10: drain нем, «не подобрала» не читается. След пишет в прод-лог
 * через logStep плагина; здесь коллектор вместо него. Каталог discovery —
 * временный, в живой флот ничего не кладётся.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWakeListener, stopWakeListener, type WakeListenerHandle } from './wake-listener'

process.env.SW_EXEC_OFF = '1'

let dirs: string[] = []
let handles: WakeListenerHandle[] = []
afterEach(() => {
  for (const h of handles) { try { stopWakeListener(h) } catch {} }
  handles = []
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
  dirs = []
  delete process.env.WAKE_DISCOVERY_DIR
})

async function start(collect: Array<{ step: string; details: any }>): Promise<WakeListenerHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-wake-'))
  dirs.push(dir)
  process.env.WAKE_DISCOVERY_DIR = dir
  const h = await startWakeListener({
    serverUrl: 'http://127.0.0.1:0',
    sessionId: 'ses_trace_test',
    busyRetryInterval: 0.1,
    busyMaxRetries: 2,
    onWakeTrace: (step, details) => collect.push({ step, details }),
  })
  handles.push(h)
  return h
}

const letter = (id: string) => ({ eventId: id, type: 'channel_message', source: 'test', priority: 'normal', payload: { text: 'hi' } })

describe('след пути побудки', () => {
  test('получение и постановка в очередь видны со своим eventId', async () => {
    const collect: Array<{ step: string; details: any }> = []
    const h = await start(collect)
    const res = await fetch(`http://127.0.0.1:${h.port}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wake-Token': h.token },
      body: JSON.stringify(letter('ev-trace-1')),
    })
    const body = await res.json() as { accepted: boolean; queued: boolean }
    expect(res.status).toBe(200)
    expect(body.accepted).toBe(true)
    expect(body.queued).toBe(true) // без sdkClient вставка не удаётся — очередь
    const steps = collect.map((c) => c.step)
    expect(steps).toContain('WAKE_RECEIVED')
    expect(steps).toContain('WAKE_QUEUED')
    expect(collect.find((c) => c.step === 'WAKE_QUEUED')!.details.eventId).toBe('ev-trace-1')
  })

  test('drain не теряет: retry со счётом, потом сброс — всё со следом', async () => {
    const collect: Array<{ step: string; details: any }> = []
    const h = await start(collect)
    await fetch(`http://127.0.0.1:${h.port}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wake-Token': h.token },
      body: JSON.stringify(letter('ev-trace-2')),
    })
    await new Promise((r) => setTimeout(r, 800))
    const steps = collect.map((c) => c.step)
    expect(steps).toContain('WAKE_DRAIN_RETRY')
    expect(steps).toContain('WAKE_DRAIN_DROPPED')
    const dropped = collect.find((c) => c.step === 'WAKE_DRAIN_DROPPED')!
    expect(dropped.details.eventId).toBe('ev-trace-2')
    expect(dropped.details.attempts).toBe(2)
  })

  test('дубль виден и не встаёт в очередь второй раз', async () => {
    const collect: Array<{ step: string; details: any }> = []
    const h = await start(collect)
    const post = () => fetch(`http://127.0.0.1:${h.port}/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Wake-Token': h.token },
      body: JSON.stringify(letter('ev-trace-3')),
    })
    await post()
    const second = await (await post()).json() as { accepted: boolean; queued: boolean }
    expect(second.accepted).toBe(true)
    expect(second.queued).toBe(false)
    expect(collect.map((c) => c.step)).toContain('WAKE_DUPLICATE')
  })
})
