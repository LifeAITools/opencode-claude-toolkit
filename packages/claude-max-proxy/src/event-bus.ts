/**
 * EventBus — in-process event emitter with typed events.
 *
 * Every observable thing in the proxy emits here. Logger + TUI + heartbeat
 * subscribe. Zero coupling between event source and consumer.
 */

import { EventEmitter } from 'node:events'

// ═══ Event taxonomy ════════════════════════════════════════════

export type EventLevel = 'error' | 'info' | 'debug'

export interface BaseEvent {
  ts: string         // ISO timestamp
  level: EventLevel
  kind: EventKind
  msg?: string       // optional human message
}

export type EventKind =
  // Lifecycle
  | 'PROXY_STARTED'
  | 'PROXY_SHUTDOWN'
  | 'PROXY_CONFIG'

  // Session lifecycle
  | 'SESSION_TRACKED'
  | 'SESSION_DEAD'

  // Real request
  | 'REAL_REQUEST_START'
  | 'REAL_REQUEST_COMPLETE'
  | 'REAL_REQUEST_ERROR'

  // Keepalive
  | 'KA_TICK_IDLE'          // timer ticked but not time to fire yet
  | 'KA_FIRE_START'
  | 'KA_FIRE_COMPLETE'
  | 'KA_FIRE_ERROR'
  | 'KA_DISARM'
  | 'KA_RESUMED'

  // Guards
  | 'REWRITE_WARN'
  | 'REWRITE_BLOCK'

  // Token
  | 'TOKEN_ROTATED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REFRESH_FAILED'
  | 'TOKEN_NEEDS_RELOGIN'

  // Network
  | 'NETWORK_DEGRADED'
  | 'NETWORK_HEALTHY'

  // Heartbeat
  | 'HEALTH_HEARTBEAT'

  // Generic
  | 'INFO'
  | 'WARN'
  | 'ERROR'

// Typed event payloads (per-kind shapes)

export interface SessionTrackedEvent extends BaseEvent {
  kind: 'SESSION_TRACKED'
  sessionId: string
  pid: number | null
}

export interface SessionDeadEvent extends BaseEvent {
  kind: 'SESSION_DEAD'
  sessionId: string
  reason: 'pid_gone' | 'idle_timeout' | 'explicit_close'
}

export interface RealRequestCompleteEvent extends BaseEvent {
  kind: 'REAL_REQUEST_COMPLETE'
  sessionId: string
  model: string
  durationMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
  rateLimit: {
    util5h: number | null
    util7d: number | null
    status: string | null
  }
}

export interface KaFireCompleteEvent extends BaseEvent {
  kind: 'KA_FIRE_COMPLETE'
  sessionId: string
  model: string
  durationMs: number
  idleMs: number
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  }
  rateLimit: {
    util5h: number | null
    util7d: number | null
  }
}

export interface KaDisarmEvent extends BaseEvent {
  kind: 'KA_DISARM'
  sessionId: string
  reason: string
}

export interface HealthHeartbeatEvent extends BaseEvent {
  kind: 'HEALTH_HEARTBEAT'
  sessions: number
  liveKa: number
  firesLastHour: number
  ticksLastHour: number
  avgCacheRead: number
  zeroCacheWrites: number
  util5h: number | null
  util7d: number | null
  tokenExpiresInSec: number | null
  networkState: 'healthy' | 'degraded'
}

// Union of all events for strict typing on .on handlers
export type ProxyEvent =
  | BaseEvent
  | SessionTrackedEvent
  | SessionDeadEvent
  | RealRequestCompleteEvent
  | KaFireCompleteEvent
  | KaDisarmEvent
  | HealthHeartbeatEvent

// ═══ EventBus singleton ═══════════════════════════════════════════

class TypedEventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(50)  // TUI + logger + heartbeat + per-session KA + admin
  }

  /** Emit a proxy event — auto-stamps ts if missing. */
  emitEvent(event: Omit<BaseEvent, 'ts'> & Partial<BaseEvent> & Record<string, unknown>): void {
    const full: ProxyEvent = {
      ts: event.ts ?? new Date().toISOString(),
      ...event,
    } as ProxyEvent
    this.emit('event', full)
    this.emit(full.kind, full)   // also fires per-kind listeners
  }

  onEvent(handler: (e: ProxyEvent) => void): () => void {
    this.on('event', handler)
    return () => this.off('event', handler)
  }

  onKind<K extends EventKind>(kind: K, handler: (e: ProxyEvent) => void): () => void {
    this.on(kind, handler)
    return () => this.off(kind, handler)
  }
}

export const bus = new TypedEventBus()

// Convenience shortcuts
export const emit = (e: Omit<BaseEvent, 'ts'> & Partial<BaseEvent> & Record<string, unknown>) =>
  bus.emitEvent(e)
