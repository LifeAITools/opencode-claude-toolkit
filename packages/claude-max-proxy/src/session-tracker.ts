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
}

/** Resolve source PID from TCP ESTABLISHED peer port (localhost:<srcPort>). */
function resolvePidFromPort(srcPort: number): number | null {
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

  /** Reap sessions whose owning PID is dead. Called periodically. */
  reapDead(): string[] {
    const killed: string[] = []
    for (const [sid, sess] of this.sessions.entries()) {
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
}
