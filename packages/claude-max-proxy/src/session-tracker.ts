/**
 * SessionTracker — one KeepaliveEngine per CC session (one per cwd/tmux pane).
 *
 * Identity: X-Claude-Code-Session-Id header (CC includes it on every request).
 * Liveness: when we get first request from a session, resolve its source PID
 *   from TCP peer port via lsof (macOS) / /proc/net/tcp (Linux).
 *   On every KA tick, verify PID still alive via `kill -0`. If dead → drop session.
 */

import { readFileSync, readlinkSync } from 'node:fs'
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

/**
 * Паспорт владельца сессии: что это за процесс, откуда он запущен и кем.
 *
 * 🔴 ЗАЧЕМ, ЗАМЕР 04.09.2026. Семь сессий грелись сутки, четыре из них не сделав
 * НИ ОДНОГО настоящего хода, и опознать их было нечем: ни в журнале, ни в
 * снимках, ни в дампах тел не нашлось ни имени клиента, ни владельца — только
 * шестнадцатеричное имя сессии. Просьба фаундера дословно: «чтобы мы понимали,
 * что за процесс, как называется, кто его запустил, в общем, всё, что нужно
 * знать, чтобы было видно всё».
 *
 * Снимается ОДИН РАЗ на рождение сессии, не на каждом ходу: паспорт не меняется,
 * а чтение /proc стоит нескольких системных вызовов.
 *
 * 🔴 КОМАНДНАЯ СТРОКА ОБРЕЗАЕТСЯ И ЧИСТИТСЯ. В аргументах процесса живут ключи и
 * токены, а этот журнал читают люди и соседние службы; лучше короткое честное
 * начало команды, чем полная строка, которую нельзя показать.
 */
export interface OwnerPassport {
  pid: number
  /** Короткое имя процесса — `node`, `bun`, `python3`. */
  name: string | null
  /** Начало команды запуска, вычищенное от похожего на секреты. */
  cmd: string | null
  /** Рабочий каталог — по нему сразу виден проект, из которого пришли. */
  cwd: string | null
  /** Кто запустил: номер родителя и его имя. */
  ppid: number | null
  parentName: string | null
  /** Когда процесс поднялся, в секундах от старта машины. */
  startedSecAfterBoot: number | null
}

/** Убрать из строки то, что похоже на ключ или токен.
 *  Открыто ради испытания: это единственная защита между аргументами чужого
 *  процесса и журналом, который читают люди и соседние службы. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ey[A-Za-z0-9_-]{20,})/g, '<секрет>')
    .replace(/(--?(?:token|key|secret|password|api[-_]?key)[= ])\S+/gi, '$1<секрет>')
}

export function readOwnerPassport(pid: number): OwnerPassport {
  const out: OwnerPassport = {
    pid, name: null, cmd: null, cwd: null, ppid: null, parentName: null, startedSecAfterBoot: null,
  }
  try { out.name = readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null } catch { /* процесс мог уйти */ }
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
    out.cmd = raw ? scrubSecrets(raw).slice(0, 300) : null
  } catch { /* нет прав или процесс ушёл */ }
  try { out.cwd = readlinkSync(`/proc/${pid}/cwd`) } catch { /* чужой процесс — читать не дадут */ }
  try {
    // /proc/PID/stat: поле 4 — родитель, поле 22 — время старта. Имя процесса в
    // поле 2 стоит в скобках и МОЖЕТ СОДЕРЖАТЬ ПРОБЕЛЫ, поэтому разбор идёт от
    // закрывающей скобки, а не простым split по пробелам.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)
    const ppid = parseInt(tail[1], 10)
    if (Number.isFinite(ppid)) {
      out.ppid = ppid
      try { out.parentName = readFileSync(`/proc/${ppid}/comm`, 'utf8').trim() || null } catch { /* родитель ушёл */ }
    }
    const startTicks = parseInt(tail[19], 10)
    if (Number.isFinite(startTicks)) out.startedSecAfterBoot = Math.round(startTicks / 100)
  } catch { /* stat недоступен */ }
  return out
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

    // Паспорт владельца — один раз на рождение сессии. Без него сессия, чей
    // процесс мы не нашли, остаётся безымянной навсегда: замер 04.09.2026 —
    // семь таких грелись сутки, четыре не сделав ни одного настоящего хода, и
    // опознать их было решительно нечем.
    const owner = pid !== null ? readOwnerPassport(pid) : null
    emit({
      level: 'info',
      kind: 'SESSION_TRACKED',
      sessionId,
      pid,
      // Разворачиваем плоско: читатель журнала находит владельца грепом по
      // `ownerName=`, а не разбирая вложенный объект.
      ownerName: owner?.name ?? null,
      ownerCmd: owner?.cmd ?? null,
      ownerCwd: owner?.cwd ?? null,
      ownerPpid: owner?.ppid ?? null,
      ownerParentName: owner?.parentName ?? null,
      // Честно говорим, ПОЧЕМУ владельца нет, вместо молчаливого null: «порт не
      // назван» и «процесс не найден по порту» — разные беды с разным лечением.
      ownerUnresolved: pid === null ? (srcPort ? 'процесс по порту не найден' : 'порт источника не назван') : null,
      msg: pid !== null
        ? `сессия ${sessionId.slice(0, 8)} — владелец ${owner?.name ?? '?'} (${pid}), запущен из ${owner?.parentName ?? '?'}`
          + (owner?.cwd ? `, каталог ${owner.cwd}` : '')
        : `сессия ${sessionId.slice(0, 8)} — владелец НЕ ОПОЗНАН (${srcPort ? 'процесс по порту не найден' : 'порт источника не назван'});`
          + ' правило «жив ли тот, кто завёл сессию» к ней неприменимо',
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
