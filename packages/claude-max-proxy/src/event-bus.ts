/**
 * EventBus — in-process event emitter with typed events.
 *
 * Every observable thing in the proxy emits here. Logger + TUI + heartbeat
 * subscribe. Zero coupling between event source and consumer.
 */

import { EventEmitter } from 'node:events'

// ═══ Event taxonomy ════════════════════════════════════════════

export type EventLevel = 'error' | 'info' | 'debug'

/**
 * Two strictness levels:
 *
 *   - EventKind (closed union):  for subscribers — `onKind('X', ...)` gets
 *     autocomplete and typo-detection. Add a literal here when you add a
 *     subscriber for that kind.
 *
 *   - EmitKind (open string):    for emitters — telemetry kinds get added
 *     ad-hoc across the codebase (BODY_CAPTURE, STARTUP, ADMIN_DISARM, ...)
 *     and closing the union would force every new line of telemetry to
 *     touch this file. `string & {}` is the TanStack/Tailwind idiom that
 *     keeps autocomplete for known literals while accepting any string.
 *
 * Subscribers are few; emitters are many. Different strictness needs.
 */
export type EmitKind = EventKind | (string & {})

export interface BaseEvent {
  ts: string         // ISO timestamp
  level: EventLevel
  kind: EmitKind
  msg?: string       // optional human message
}

export type EventKind =
  // Lifecycle
  | 'PROXY_STARTED'
  | 'PROXY_SHUTDOWN'
  | 'PROXY_CONFIG'
  | 'PROXY_MODE_START'         // embedded/global mode identified at boot
  | 'PROXY_PARENT_GONE'         // embedded: parent PID died, self-terminating

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
  | 'TOKEN_FILE_CHANGED'        // emitted by quota-watcher fs.watch; consumed by upstream (invalidate) + KA engine (re-evaluate pause)

  // Rate limit / quota
  | 'UPSTREAM_RATE_LIMITED'     // emitted by upstream on 429; consumed by KA engine (pause/disarm decision)
  | 'KA_PAUSED'                  // engine paused KA fires, waiting for quota reset
  | 'KA_RESUMED_FROM_PAUSE'      // engine attempted post-reset fire; succeeded

  // Network
  | 'NETWORK_DEGRADED'
  | 'NETWORK_HEALTHY'

  // Heartbeat
  | 'HEALTH_HEARTBEAT'

  // OpenAI compat
  | 'OPENAI_COMPAT_REQUEST'
  | 'OPENAI_COMPAT_COMPLETE'
  | 'OPENAI_COMPAT_ERROR'

  // Generic
  | 'INFO'
  | 'WARN'
  | 'ERROR'

/** Importable event kind constants — modules MUST use these instead of inline strings. */
export const EVENT = {
  // Lifecycle
  PROXY_STARTED: 'PROXY_STARTED',
  PROXY_SHUTDOWN: 'PROXY_SHUTDOWN',
  PROXY_CONFIG: 'PROXY_CONFIG',
  PROXY_MODE_START: 'PROXY_MODE_START',
  PROXY_PARENT_GONE: 'PROXY_PARENT_GONE',
  // Session
  SESSION_TRACKED: 'SESSION_TRACKED',
  SESSION_DEAD: 'SESSION_DEAD',
  SESSION_MANAGED: 'SESSION_MANAGED',
  MANAGED_SESSIONS_RESTORED: 'MANAGED_SESSIONS_RESTORED',
  // Real request
  REAL_REQUEST_START: 'REAL_REQUEST_START',
  REAL_REQUEST_COMPLETE: 'REAL_REQUEST_COMPLETE',
  REAL_REQUEST_ERROR: 'REAL_REQUEST_ERROR',
  // Keepalive
  KA_TICK_IDLE: 'KA_TICK_IDLE',
  KA_FIRE_START: 'KA_FIRE_START',
  KA_FIRE_COMPLETE: 'KA_FIRE_COMPLETE',
  KA_FIRE_ERROR: 'KA_FIRE_ERROR',
  KA_DISARM: 'KA_DISARM',
  KA_RESUMED: 'KA_RESUMED',
  // Guards
  REWRITE_WARN: 'REWRITE_WARN',
  REWRITE_BLOCK: 'REWRITE_BLOCK',
  // Token
  TOKEN_ROTATED: 'TOKEN_ROTATED',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  TOKEN_REFRESH_FAILED: 'TOKEN_REFRESH_FAILED',
  TOKEN_NEEDS_RELOGIN: 'TOKEN_NEEDS_RELOGIN',
  TOKEN_FILE_CHANGED: 'TOKEN_FILE_CHANGED',
  // Rate limit
  UPSTREAM_RATE_LIMITED: 'UPSTREAM_RATE_LIMITED',
  KA_PAUSED: 'KA_PAUSED',
  KA_RESUMED_FROM_PAUSE: 'KA_RESUMED_FROM_PAUSE',
  // Network
  NETWORK_DEGRADED: 'NETWORK_DEGRADED',
  NETWORK_HEALTHY: 'NETWORK_HEALTHY',
  // Heartbeat
  HEALTH_HEARTBEAT: 'HEALTH_HEARTBEAT',
  // OpenAI compat
  OPENAI_COMPAT_REQUEST: 'OPENAI_COMPAT_REQUEST',
  OPENAI_COMPAT_COMPLETE: 'OPENAI_COMPAT_COMPLETE',
  OPENAI_COMPAT_ERROR: 'OPENAI_COMPAT_ERROR',
  // Generic
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
  // Body capture
  BODY_CAPTURE: 'BODY_CAPTURE',
  // Startup
  STARTUP: 'STARTUP',
} as const satisfies Record<string, string>

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

/**
 * Usage subset on REAL_REQUEST_COMPLETE / KA_FIRE_COMPLETE events.
 *
 * Required totals are always emitted. Optional TTL-split + cache-deleted
 * subfields are OMITTED from the event when the Anthropic response did NOT
 * include `usage.cache_creation.*` / `usage.cache_deleted_input_tokens` —
 * NOT written as 0 or null. This preserves the "field absent" semantic for
 * downstream stats consumers (REQ-05, plan §527-528 backward-compat
 * contract). When a writer serializes this event with JSON.stringify the
 * omitted keys naturally disappear from the line.
 */
export interface UsageEventPayload {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  cacheCreation5mInputTokens?: number
  cacheCreation1hInputTokens?: number
  cacheDeletedInputTokens?: number
}

export interface RealRequestCompleteEvent extends BaseEvent {
  kind: 'REAL_REQUEST_COMPLETE'
  sessionId: string
  model: string
  durationMs: number
  usage: UsageEventPayload
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
  usage: UsageEventPayload
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

export interface TokenFileChangedEvent extends BaseEvent {
  kind: 'TOKEN_FILE_CHANGED'
  prevHint: string | null
  newHint: string | null
  expiresInSec: number | null
  reason: string                  // 're-login (account/token swap)' | 'token refresh'
}

/**
 * Upstream returned 429. Carries data needed by KA engine to decide pause vs disarm.
 * `resetAt` is epoch-ms preferred; if upstream only gave retry-after seconds, sum'd to now.
 * `requestKind` tells whether this was a user request ('real') or a KA fire ('ka').
 */
export interface UpstreamRateLimitedEvent extends BaseEvent {
  kind: 'UPSTREAM_RATE_LIMITED'
  sessionId: string | null
  resetAt: number | null          // epoch ms when quota resets; null if upstream gave no hint
  retryAfterSec: number | null    // raw retry-after header value if present
  requestKind: 'real' | 'ka'
  status: number                  // upstream HTTP status (always 429 here, but explicit for symmetry)
}

export interface KaPausedEvent extends BaseEvent {
  kind: 'KA_PAUSED'
  sessionId: string
  resetAt: number | null
  reason: string                  // 'cache_outlives_quota_wait'
  cacheDiesAt: number | null      // epoch ms when current snapshot cache expires
  snapshotSize: number            // input tokens in current snapshot
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
  | TokenFileChangedEvent
  | UpstreamRateLimitedEvent
  | KaPausedEvent

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

// ═══ Adapter: SDK IEventEmitter → proxy bus ═════════════════════════
//
// ProxyClient (from SDK) expects an IEventEmitter. We wrap our own bus so
// every event from SDK flows through the same logger/TUI/heartbeat chain.
//
// IEventEmitter's event shape is structural (level + kind + arbitrary fields).
// Our bus accepts the same — just relaying.

import type { IEventEmitter, ProxyEvent as SDKProxyEvent } from '@life-ai-tools/claude-code-sdk'

export class BusEventEmitterAdapter implements IEventEmitter {
  emit(event: SDKProxyEvent): void {
    // Route SDK event through our TypedEventBus — same fanout as native emit().
    // SDK's kind is a string; we accept any string (TypedEventBus lists known
    // kinds for TS tooling, but runtime accepts string).
    bus.emitEvent(event as any)
  }
}
