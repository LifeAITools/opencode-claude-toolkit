/**
 * Heartbeat — periodic HEALTH_HEARTBEAT event every N seconds.
 *
 * Aggregates:
 *   - Active sessions / live KAs
 *   - Fires/ticks in last hour (rolling window)
 *   - Average cache read size
 *   - Quota state (util5h/util7d)
 *   - Token expiry countdown
 *   - Network state
 *
 * Consumers (logger, TUI) subscribe to HEALTH_HEARTBEAT events.
 */

import type { ProxyConfig } from './config.js'
// Minimal tracker interface — heartbeat only needs list() + size().
// This decouples from the specific implementation (legacy SessionTracker
// or the SDK-backed shim in server.ts).
interface HeartbeatTracker {
  list(): Array<{ engine: unknown }>
  size(): number
}
import { bus, emit } from './event-bus.js'
import { readFileSync } from 'fs'

// Rolling 1-hour window of KA fires
const HOUR_MS = 60 * 60 * 1000
const fireHistory: { ts: number; cacheRead: number; cacheWrite: number }[] = []
const tickHistory: { ts: number }[] = []

// Most recent network/error state (for heartbeat observability)
let _networkState: 'healthy' | 'degraded' = 'healthy'
let _lastDisarmReason: string | null = null
let _lastDisarmAt: number | null = null
let _lastErrorMsg: string | null = null
let _lastErrorAt: number | null = null
let _disarmsLastHour: { ts: number; reason: string }[] = []

function pruneOld(): void {
  const cutoff = Date.now() - HOUR_MS
  while (fireHistory.length && fireHistory[0].ts < cutoff) fireHistory.shift()
  while (tickHistory.length && tickHistory[0].ts < cutoff) tickHistory.shift()
  while (_disarmsLastHour.length && _disarmsLastHour[0].ts < cutoff) _disarmsLastHour.shift()
}

// Subscribe to relevant events to populate history
bus.onKind('KA_FIRE_COMPLETE', (e: any) => {
  fireHistory.push({
    ts: Date.now(),
    cacheRead: e.usage?.cacheReadInputTokens ?? 0,
    cacheWrite: e.usage?.cacheCreationInputTokens ?? 0,
  })
})

bus.onKind('KA_TICK_IDLE', () => {
  tickHistory.push({ ts: Date.now() })
})

// Track network state aggregation (proxy may have multiple sessions —
// "degraded" if ANY is degraded, "healthy" when all healthy).
bus.onKind('NETWORK_DEGRADED', () => { _networkState = 'degraded' })
bus.onKind('NETWORK_HEALTHY', () => { _networkState = 'healthy' })

// Track last disarm reason + rolling history of disarms
bus.onKind('KA_DISARM', (e: any) => {
  _lastDisarmReason = String(e.reason ?? 'unknown')
  _lastDisarmAt = Date.now()
  _disarmsLastHour.push({ ts: _lastDisarmAt, reason: _lastDisarmReason })
})

// Track last real-request error (so heartbeat reflects recent upstream issues)
bus.onKind('REAL_REQUEST_ERROR', (e: any) => {
  _lastErrorMsg = String(e.msg ?? '').slice(0, 120)
  _lastErrorAt = Date.now()
})

export function startHeartbeat(
  cfg: ProxyConfig,
  tracker: HeartbeatTracker,
  getRateLimit: () => { utilization5h: number | null; utilization7d: number | null },
): () => void {
  if (cfg.healthHeartbeatSec <= 0) return () => {}

  const timer = setInterval(() => {
    pruneOld()

    // Token expiry countdown (read from credentials file)
    let tokenExpiresInSec: number | null = null
    try {
      const creds = JSON.parse(readFileSync(cfg.credentialsPath, 'utf8'))
      const expiresAt = creds?.claudeAiOauth?.expiresAt
      if (expiresAt) tokenExpiresInSec = Math.floor((expiresAt - Date.now()) / 1000)
    } catch {}

    const fires = fireHistory.length
    const totalCacheRead = fireHistory.reduce((a, b) => a + b.cacheRead, 0)
    const avgCacheRead = fires > 0 ? Math.round(totalCacheRead / fires) : 0
    const zeroCacheWrites = fireHistory.filter(f => f.cacheWrite === 0).length

    const rl = getRateLimit()

    // Count live KA engines across all sessions
    let liveKa = 0
    for (const sess of tracker.list()) {
      if ((sess.engine as any)._timer !== null) liveKa++
    }

    // Age of last disarm/error in seconds (null if never happened or >1h ago)
    const now = Date.now()
    const lastDisarmAgoSec = _lastDisarmAt ? Math.floor((now - _lastDisarmAt) / 1000) : null
    const lastErrorAgoSec = _lastErrorAt ? Math.floor((now - _lastErrorAt) / 1000) : null

    emit({
      level: 'info',
      kind: 'HEALTH_HEARTBEAT',
      sessions: tracker.size(),
      liveKa,
      firesLastHour: fires,
      ticksLastHour: tickHistory.length,
      avgCacheRead,
      zeroCacheWrites,
      util5h: rl.utilization5h,
      util7d: rl.utilization7d,
      tokenExpiresInSec,
      networkState: _networkState,
      disarmsLastHour: _disarmsLastHour.length,
      lastDisarmReason: _lastDisarmReason,
      lastDisarmAgoSec,
      lastErrorMsg: _lastErrorMsg,
      lastErrorAgoSec,
    })
  }, cfg.healthHeartbeatSec * 1000)

  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as any).unref()
  }

  return () => clearInterval(timer)
}
