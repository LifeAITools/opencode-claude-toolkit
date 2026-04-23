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
import type { SessionTracker } from './session-tracker.js'
import { bus, emit } from './event-bus.js'
import { readFileSync } from 'fs'

// Rolling 1-hour window of KA fires
const HOUR_MS = 60 * 60 * 1000
const fireHistory: { ts: number; cacheRead: number; cacheWrite: number }[] = []
const tickHistory: { ts: number }[] = []

function pruneOld(): void {
  const cutoff = Date.now() - HOUR_MS
  while (fireHistory.length && fireHistory[0].ts < cutoff) fireHistory.shift()
  while (tickHistory.length && tickHistory[0].ts < cutoff) tickHistory.shift()
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

export function startHeartbeat(
  cfg: ProxyConfig,
  tracker: SessionTracker,
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
      networkState: 'healthy',  // TODO: aggregate from sessions
    })
  }, cfg.healthHeartbeatSec * 1000)

  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as any).unref()
  }

  return () => clearInterval(timer)
}
