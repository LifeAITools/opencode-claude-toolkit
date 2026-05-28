/**
 * ManagedSessionService — Worker-managed session lifecycle extracted from server.ts.
 *
 * Sessions marked as "managed" have their liveness supplemented by Worker
 * heartbeats instead of relying solely on PID checks. This lets KA engines
 * keep firing for sessions whose subprocess PID has died but whose Worker
 * is still alive and will respawn it.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { IManagedSessions } from './module.js'

interface ManagedEntry {
  workerId: string
  lastHeartbeat: number
  ttlMs: number
  lastPid?: number | null
}

const DEFAULT_FILE = join(homedir(), '.claude-local', 'proxy-managed-sessions.json')

export class ManagedSessionService implements IManagedSessions {
  private readonly sessions = new Map<string, ManagedEntry>()
  private persistTimer: ReturnType<typeof setInterval> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private readonly filePath: string

  constructor(filePath?: string) {
    this.filePath = filePath ?? DEFAULT_FILE
  }

  start(onEvent?: (e: Record<string, unknown>) => void): void {
    // Load persisted sessions (best-effort)
    try {
      const raw = JSON.parse(readFileSync(this.filePath, 'utf8')) as Record<string, ManagedEntry>
      const now = Date.now()
      for (const [sid, m] of Object.entries(raw)) {
        if (now - m.lastHeartbeat < m.ttlMs) this.sessions.set(sid, m)
      }
      if (this.sessions.size > 0) {
        onEvent?.({ level: 'info', kind: 'MANAGED_SESSIONS_RESTORED', count: this.sessions.size })
      }
    } catch { /* file doesn't exist or parse failed */ }

    // Persist every 10s
    this.persistTimer = setInterval(() => this.persist(), 10_000)
    if (this.persistTimer && typeof this.persistTimer === 'object' && 'unref' in this.persistTimer) {
      (this.persistTimer as any).unref()
    }

    // Sweep stale every 5s
    this.sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const [sid, m] of this.sessions.entries()) {
        if (now - m.lastHeartbeat > m.ttlMs) this.sessions.delete(sid)
      }
    }, 5_000)
    if (this.sweepTimer && typeof this.sweepTimer === 'object' && 'unref' in this.sweepTimer) {
      (this.sweepTimer as any).unref()
    }
  }

  stop(): void {
    if (this.persistTimer) clearInterval(this.persistTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.persist()
  }

  mark(sessionId: string, workerId: string, ttlMs = 30_000, lastPid: number | null = null): void {
    this.sessions.set(sessionId, { workerId, lastHeartbeat: Date.now(), ttlMs, lastPid })
  }

  unmark(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  heartbeat(workerId: string, activeSessionIds: string[]): number {
    const now = Date.now()
    let refreshed = 0
    for (const sid of activeSessionIds) {
      const m = this.sessions.get(sid)
      if (m && m.workerId === workerId) {
        m.lastHeartbeat = now
        refreshed++
      }
    }
    return refreshed
  }

  list(): { sessionId: string; workerId: string; lastHeartbeat: number; ttlMs: number; staleSec: number }[] {
    return Array.from(this.sessions.entries()).map(([sid, m]) => ({
      sessionId: sid,
      workerId: m.workerId,
      lastHeartbeat: m.lastHeartbeat,
      ttlMs: m.ttlMs,
      staleSec: (Date.now() - m.lastHeartbeat) / 1000,
    }))
  }

  /** Check if a dead PID belongs to a managed session with fresh heartbeat. */
  isAliveByPid(pid: number): boolean {
    for (const [, m] of this.sessions.entries()) {
      if ((Date.now() - m.lastHeartbeat) < m.ttlMs && m.lastPid === pid) return true
    }
    return false
  }

  get size(): number { return this.sessions.size }

  getEntry(sessionId: string): ManagedEntry | undefined {
    return this.sessions.get(sessionId)
  }

  private persist(): void {
    try {
      mkdirSync(join(homedir(), '.claude-local'), { recursive: true })
      const obj: Record<string, ManagedEntry> = {}
      for (const [sid, m] of this.sessions) obj[sid] = m
      writeFileSync(this.filePath, JSON.stringify(obj), 'utf8')
    } catch { /* best-effort */ }
  }
}
