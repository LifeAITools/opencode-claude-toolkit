/**
 * SessionTracker — one KeepaliveEngine per CC session (one per cwd/tmux pane).
 *
 * Identity: X-Claude-Code-Session-Id header (CC includes it on every request).
 * Liveness: when we get first request from a session, resolve its source PID
 *   from TCP peer port via lsof (macOS) / /proc/net/tcp (Linux).
 *   On every KA tick, verify PID still alive via `kill -0`. If dead → drop session.
 */

import { spawnSync } from 'bun'
import { KeepaliveEngine, type KeepaliveEngineOptions } from '@life-ai-tools/claude-code-sdk'
import { emit } from './event-bus.js'

export interface TrackedSession {
  sessionId: string
  pid: number | null
  firstSeenAt: number
  lastRequestAt: number
  engine: KeepaliveEngine
  model: string | null
  lastUsage: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  } | null
  /** When set, PID liveness is ignored. Session stays alive as long as
   *  Worker heartbeat is fresh (lastManagedHeartbeat within managedTtlMs). */
  managed?: {
    workerId: string
    lastHeartbeat: number
    ttlMs: number  // default 30_000 — reap if no heartbeat for this long
  }
}

/** Resolve source PID from TCP ESTABLISHED peer port (localhost:<srcPort>). */
export function resolvePidFromPort(srcPort: number): number | null {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync(['lsof', '-nP', `-iTCP:${srcPort}`, '-sTCP:ESTABLISHED', '-F', 'p'])
      const out = new TextDecoder().decode(r.stdout)
      const m = out.match(/^p(\d+)/m)
      return m ? parseInt(m[1]) : null
    }
    if (process.platform === 'linux') {
      // /proc/net/tcp line format: sl local:PORT remote:PORT ...inode
      const { readFileSync, readdirSync, readlinkSync } = require('fs') as typeof import('fs')
      const hex = srcPort.toString(16).toUpperCase().padStart(4, '0')
      const contents = readFileSync('/proc/net/tcp', 'utf8') + '\n' + (() => {
        try { return readFileSync('/proc/net/tcp6', 'utf8') } catch { return '' }
      })()
      // Match local address ending :PORT (hex)
      const lines = contents.split('\n').filter((l: string) => {
        const parts = l.trim().split(/\s+/)
        return parts[1]?.endsWith(':' + hex)
      })
      if (lines.length === 0) return null
      // Extract inode (10th col)
      const inodes = new Set(lines.map((l: string) => l.trim().split(/\s+/)[9]))
      // Scan /proc/*/fd/* for socket:[inode] match
      for (const pid of readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue
        try {
          const fds = readdirSync(`/proc/${pid}/fd`)
          for (const fd of fds) {
            try {
              const link = readlinkSync(`/proc/${pid}/fd/${fd}`)
              const m = link.match(/^socket:\[(\d+)\]$/)
              if (m && inodes.has(m[1])) return parseInt(pid)
            } catch {}
          }
        } catch {}
      }
      return null
    }
    return null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Exported for consumers who need it (e.g. for isOwnerAlive DI callback). */
export { processAlive }

// ─── Tracker ──────────────────────────────────────────────────

export class SessionTracker {
  private sessions = new Map<string, TrackedSession>()

  /** Only used by tests / diagnostics. */
  get _sessions(): ReadonlyMap<string, TrackedSession> { return this.sessions }

  private readonly engineFactory: (sessionId: string) => KeepaliveEngineOptions

  constructor(engineFactory: (sessionId: string) => KeepaliveEngineOptions) {
    this.engineFactory = engineFactory
  }

  /** Called at start of every real request — creates session on first seen. */
  getOrCreate(sessionId: string, srcPort: number | null): TrackedSession {
    let session = this.sessions.get(sessionId)
    if (session) return session

    const pid = srcPort ? resolvePidFromPort(srcPort) : null
    const engine = new KeepaliveEngine(this.engineFactory(sessionId))

    session = {
      sessionId,
      pid,
      firstSeenAt: Date.now(),
      lastRequestAt: Date.now(),
      engine,
      model: null,
      lastUsage: null,
    }
    this.sessions.set(sessionId, session)

    emit({
      level: 'info',
      kind: 'SESSION_TRACKED',
      sessionId,
      pid,
    })

    return session
  }

  /** Reap sessions whose owning PID is dead. Called periodically.
   *  Worker-managed sessions use heartbeat TTL instead of PID liveness. */
  reapDead(): string[] {
    const killed: string[] = []
    const now = Date.now()
    for (const [sid, sess] of this.sessions.entries()) {
      // Worker-managed session: check heartbeat freshness, not PID
      if (sess.managed) {
        const age = now - sess.managed.lastHeartbeat
        if (age > sess.managed.ttlMs) {
          sess.engine.stop()
          this.sessions.delete(sid)
          killed.push(sid)
          emit({
            level: 'info',
            kind: 'SESSION_DEAD',
            sessionId: sid,
            reason: 'managed_heartbeat_stale',
            workerId: sess.managed.workerId,
            staleSinceMs: age,
          })
        }
        continue
      }
      // Normal PID-based liveness
      if (sess.pid !== null && !processAlive(sess.pid)) {
        sess.engine.stop()
        this.sessions.delete(sid)
        killed.push(sid)
        emit({
          level: 'info',
          kind: 'SESSION_DEAD',
          sessionId: sid,
          reason: 'pid_gone',
        })
      }
    }
    return killed
  }

  /** Shutdown all sessions (stop KA engines). */
  stopAll(): void {
    for (const sess of this.sessions.values()) {
      try { sess.engine.stop() } catch {}
    }
    this.sessions.clear()
  }

  size(): number { return this.sessions.size }

  list(): TrackedSession[] {
    return Array.from(this.sessions.values())
  }

  /**
   * Get session by ID (used for just-in-time PID check by engine's
   * isOwnerAlive callback — reads the session's resolved PID).
   */
  get(sessionId: string): TrackedSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Check if a session's owner process is still alive.
   * Returns true if:
   *   - Session not yet registered (PID not resolved) — default to alive
   *   - PID resolved AND still running
   * Returns false only when PID was resolved and process has exited.
   */
  isOwnerAlive(sessionId: string): boolean {
    const sess = this.sessions.get(sessionId)
    if (!sess) return true           // unknown session — don't falsely kill
    // Worker-managed: alive if heartbeat is fresh
    if (sess.managed) {
      return (Date.now() - sess.managed.lastHeartbeat) < sess.managed.ttlMs
    }
    if (sess.pid === null) return true // PID never resolved — don't kill
    return processAlive(sess.pid)
  }

  /** Mark a session as Worker-managed. PID liveness is ignored;
   *  session stays alive as long as Worker heartbeats arrive. */
  markManaged(sessionId: string, workerId: string, ttlMs: number = 30_000): boolean {
    const sess = this.sessions.get(sessionId)
    if (!sess) return false
    sess.managed = { workerId, lastHeartbeat: Date.now(), ttlMs }
    emit({ level: 'info', kind: 'SESSION_MANAGED', sessionId, workerId })
    return true
  }

  /** Worker heartbeat — refresh lastHeartbeat for all sessions owned by this Worker. */
  workerHeartbeat(workerId: string, activeSessionIds: string[]): number {
    let refreshed = 0
    const now = Date.now()
    for (const sid of activeSessionIds) {
      const sess = this.sessions.get(sid)
      if (sess?.managed?.workerId === workerId) {
        sess.managed.lastHeartbeat = now
        refreshed++
      }
    }
    return refreshed
  }

  /** Unmark a session as Worker-managed (falls back to PID-based liveness). */
  unmarkManaged(sessionId: string): boolean {
    const sess = this.sessions.get(sessionId)
    if (!sess?.managed) return false
    delete sess.managed
    return true
  }
}
