/**
 * Tests: claude-max-proxy/src/logger.ts — the request journal is not drowned
 * by heartbeat.
 *
 * Measured on live traffic 2026-08-18: 71 284 of 91 595 journal lines (77.8%)
 * were PROXY_KA_TICK, one per tracked session every 30s. With rotation at
 * 100 MB the journal therefore held only ~4.5h of REQUEST history — and that
 * shortfall bit for real the day someone asked "did this session pass through
 * yesterday, and how did its turns end". Timer-driven kinds now go to their own
 * file, which keeps every diagnostic they carried and rotates on the same terms.
 *
 * The HUMAN log deliberately still receives everything: scripts/proxy-doctor.ts
 * reads it to prove per-session KA liveness.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startLogger } from '../src/logger.js'
import { bus } from '../src/event-bus.js'
import type { ProxyConfig } from '../src/config.js'

let dir: string
let stop: (() => void) | null = null

const mkCfg = (over: Partial<ProxyConfig> = {}): ProxyConfig => ({
  logFile: join(dir, 'proxy.log'),
  logJsonl: join(dir, 'proxy.jsonl'),
  logJsonlHeartbeat: join(dir, 'proxy-heartbeat.jsonl'),
  logFormat: 'json',
  logLevel: 'info',
  logMaxMb: 0,
  logKeep: 3,
  logGzip: false,
  ...over,
} as unknown as ProxyConfig)

const lines = (p: string) => existsSync(p)
  ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cmp-hbsplit-')) })
afterEach(() => { stop?.(); stop = null; rmSync(dir, { recursive: true, force: true }) })

describe('heartbeat is split out of the request journal', () => {
  test('requests land in the journal, ticks land beside it — never both', () => {
    stop = startLogger(mkCfg())
    bus.emitEvent({ level: 'info', kind: 'REAL_REQUEST_START', sessionId: 's1' } as any)
    bus.emitEvent({ level: 'info', kind: 'PROXY_KA_TICK', sessionId: 's1' } as any)
    bus.emitEvent({ level: 'info', kind: 'PROXY_KA_TICK', sessionId: 's2' } as any)
    bus.emitEvent({ level: 'info', kind: 'HEALTH_HEARTBEAT' } as any)
    bus.emitEvent({ level: 'info', kind: 'REAL_REQUEST_COMPLETE', sessionId: 's1' } as any)

    const journal = lines(join(dir, 'proxy.jsonl')).map((e) => e.kind)
    const heartbeat = lines(join(dir, 'proxy-heartbeat.jsonl')).map((e) => e.kind)

    expect(journal).toEqual(['REAL_REQUEST_START', 'REAL_REQUEST_COMPLETE'])
    expect(heartbeat).toEqual(['PROXY_KA_TICK', 'PROXY_KA_TICK', 'HEALTH_HEARTBEAT'])
    // No kind is written twice — the split must not duplicate volume.
    expect(journal.filter((k) => heartbeat.includes(k)).length).toBe(0)
  })

  test('the tick keeps every field it carried — the file changes, the data does not', () => {
    stop = startLogger(mkCfg())
    bus.emitEvent({
      level: 'info', kind: 'PROXY_KA_TICK', sessionId: 's1',
      state: 'armed', cacheAgeSec: 47, ttlSec: 3600, cacheRead: 640145,
    } as any)
    const [tick] = lines(join(dir, 'proxy-heartbeat.jsonl'))
    expect(tick.state).toBe('armed')
    expect(tick.cacheAgeSec).toBe(47)
    expect(tick.ttlSec).toBe(3600)
    expect(tick.cacheRead).toBe(640145)
  })

  test('the human log still sees the ticks — proxy-doctor reads it for liveness', () => {
    stop = startLogger(mkCfg({ logFormat: 'both' } as any))
    bus.emitEvent({ level: 'info', kind: 'PROXY_KA_TICK', sessionId: 's1' } as any)
    const human = readFileSync(join(dir, 'proxy.log'), 'utf8')
    expect(human).toContain('PROXY_KA_TICK')
    // …and it is still absent from the request journal.
    expect(lines(join(dir, 'proxy.jsonl')).length).toBe(0)
  })
})
