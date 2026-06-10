/**
 * Default adapters for ProxyClient ports.
 *
 * These are the zero-config implementations that ship with SDK so that
 * the most common usage pattern is simply:
 *
 *   const client = new ProxyClient({
 *     config,
 *     credentialsProvider: new FileCredentialsProvider(),
 *   })
 *
 * Each adapter is:
 *   - Small (under 100 lines)
 *   - Single-responsibility (implements ONE port interface)
 *   - Reasonable default (works for 90% of cases out of the box)
 *   - Replaceable (consumers can swap for custom adapters)
 */

import { readFileSync, statSync } from 'fs'
import type {
  ICredentialsProvider,
  IEventEmitter,
  ILivenessChecker,
  ISessionStore,
  IUpstreamFetcher,
  ProxyEvent,
  Session,
} from './proxy-ports.js'
import type { StoredCredentials, CredentialsFile } from './types.js'

// ═══ Adapter 1: FileCredentialsProvider ═══════════════════════════════
//
// Reads ~/.claude/.credentials.json (or custom path) with caching +
// mtime-based invalidation for cross-process refresh coordination.
//
// This adapter does NOT perform OAuth refresh itself — it only READS
// the latest tokens from disk. Actual refresh is delegated to whichever
// process owns the refresh lifecycle (e.g. native claude CLI, or an
// explicit refresh call from another component).
//
// For clients that need refresh logic, compose this with a separate
// RefreshingCredentialsProvider (not shipped — out of scope for v1).

export interface FileCredentialsProviderOptions {
  /** Path to credentials.json. Default: ~/.claude/.credentials.json */
  path?: string
  /** Buffer before actual expiry to count as "expired". Default: 5 min */
  expiryBufferMs?: number
}

export class FileCredentialsProvider implements ICredentialsProvider {
  private readonly path: string
  private readonly expiryBufferMs: number
  private cached: StoredCredentials | null = null
  private lastMtimeMs = 0

  constructor(opts: FileCredentialsProviderOptions = {}) {
    this.path = opts.path ?? defaultCredentialsPath()
    this.expiryBufferMs = opts.expiryBufferMs ?? 5 * 60 * 1000
  }

  async getAccessToken(): Promise<string> {
    // Re-read if disk changed (cross-process refresh detected)
    if (this.mtimeChanged()) this.cached = null

    if (!this.cached || this.isExpired(this.cached)) {
      this.cached = this.readFromDisk()
    }

    if (!this.cached?.accessToken) {
      throw new Error(`No valid OAuth credentials at ${this.path} — run \`claude login\` or equivalent`)
    }

    return this.cached.accessToken
  }

  invalidate(): void {
    this.cached = null
    this.lastMtimeMs = 0
  }

  /** Expiry (ms epoch) of the currently-cached token, or null if none cached.
   *  Feeds the per-session pin's "is the held cross-org token still alive?" check. */
  currentExpiresAt(): number | null {
    return this.cached?.expiresAt ?? null
  }

  /** Refresh token of the cached credential — feeds the per-org vault. */
  currentRefreshToken(): string | null {
    if (!this.cached) this.cached = this.readFromDisk()
    return this.cached?.refreshToken ?? null
  }

  private readFromDisk(): StoredCredentials | null {
    try {
      const raw = readFileSync(this.path, 'utf8')
      this.lastMtimeMs = this.getMtime()
      const data: CredentialsFile = JSON.parse(raw)
      return data.claudeAiOauth ?? null
    } catch {
      return null
    }
  }

  private mtimeChanged(): boolean {
    const m = this.getMtime()
    if (m !== this.lastMtimeMs) return true
    return false
  }

  private getMtime(): number {
    try { return statSync(this.path).mtimeMs } catch { return 0 }
  }

  private isExpired(c: StoredCredentials): boolean {
    if (!c.expiresAt) return false  // no expiry info → trust it
    return Date.now() + this.expiryBufferMs >= c.expiresAt
  }
}

function defaultCredentialsPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const dir = process.env.CLAUDE_CONFIG_DIR || `${home}/.claude`
  return `${dir}/.credentials.json`
}

// ═══ Adapter 2: ConsoleEventEmitter ═══════════════════════════════════
//
// Minimal observability — writes events to stderr as JSON Lines.
// Good enough for debugging; not meant for production log aggregation.
// Consumers with proper logging infra (proxy-package, opencode) should
// swap this for a richer implementation.

export interface ConsoleEventEmitterOptions {
  /** Minimum level to emit. Default: 'info' */
  minLevel?: 'error' | 'info' | 'debug'
  /** Format: 'json' (JSONL) or 'human' (colored). Default: 'human' */
  format?: 'json' | 'human'
  /** Custom write target. Default: process.stderr */
  writeTarget?: (line: string) => void
}

const LEVEL_RANK: Record<string, number> = { error: 0, info: 1, debug: 2 }

export class ConsoleEventEmitter implements IEventEmitter {
  private readonly minRank: number
  private readonly format: 'json' | 'human'
  private readonly write: (line: string) => void

  constructor(opts: ConsoleEventEmitterOptions = {}) {
    this.minRank = LEVEL_RANK[opts.minLevel ?? 'info'] ?? 1
    this.format = opts.format ?? 'human'
    this.write = opts.writeTarget ?? ((line: string) => process.stderr.write(line + '\n'))
  }

  emit(event: ProxyEvent): void {
    try {
      const rank = LEVEL_RANK[event.level] ?? 1
      if (rank > this.minRank) return

      const ts = event.ts ?? new Date().toISOString()
      if (this.format === 'json') {
        this.write(JSON.stringify({ ts, ...event }))
        return
      }

      // Human-readable: "HH:mm:ss.SSS  LEVEL  KIND  msg  k=v k=v"
      const time = ts.slice(11, 23)
      const level = event.level.toUpperCase().padEnd(5)
      const kind = event.kind.padEnd(22)
      const extras: string[] = []
      for (const [k, v] of Object.entries(event)) {
        if (['ts', 'level', 'kind', 'msg'].includes(k)) continue
        if (v === null || v === undefined) continue
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
        extras.push(`${k}=${s.length > 120 ? s.slice(0, 117) + '...' : s}`)
      }
      const msg = event.msg ? ` ${event.msg}` : ''
      const kv = extras.length ? ' ' + extras.join(' ') : ''
      this.write(`${time} ${level} ${kind}${msg}${kv}`)
    } catch {
      // Emitter must never throw. Silent fallback.
    }
  }
}

// ═══ Adapter 3: NullEventEmitter ═════════════════════════════════════
//
// Discards all events. Useful for tests or when the consumer wants
// zero I/O overhead. Implementations of emit() should still be correct;
// ProxyClient may still depend on the method being callable.

export class NullEventEmitter implements IEventEmitter {
  emit(_event: ProxyEvent): void { /* intentional no-op */ }
}

// ═══ Adapter 4: InMemorySessionStore ═════════════════════════════════
//
// Default session storage — a Map with PID-based liveness via kill(pid, 0).
// Suitable for single-process proxies (global daemon, embedded, in-process).
//
// Multi-host scenarios would implement a Redis-backed ISessionStore instead,
// but ProxyClient doesn't care about the backing — it just calls the port.

export class InMemorySessionStore<EngineT = unknown> implements ISessionStore<EngineT> {
  private sessions = new Map<string, Session<EngineT>>()
  private readonly liveness: ILivenessChecker

  constructor(liveness: ILivenessChecker = new DefaultLivenessChecker()) {
    this.liveness = liveness
  }

  getOrCreate(
    sessionId: string,
    ownerPid: number | null,
    engineFactory: () => EngineT,
  ): Session<EngineT> {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session: Session<EngineT> = {
      sessionId,
      pid: ownerPid,
      firstSeenAt: Date.now(),
      lastRequestAt: Date.now(),
      engine: engineFactory(),
      model: null,
      lastUsage: null,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): Session<EngineT> | undefined {
    return this.sessions.get(sessionId)
  }

  list(): Session<EngineT>[] {
    return Array.from(this.sessions.values())
  }

  size(): number {
    return this.sessions.size
  }

  isOwnerAlive(sessionId: string): boolean {
    const sess = this.sessions.get(sessionId)
    if (!sess) return true              // unknown → don't falsely kill
    if (sess.pid === null) return true  // no PID resolved → don't kill
    // PID 1 (init/systemd) is never a realistic session owner — it would
    // mean the real parent died and this PID was re-parented to init.
    // Treat as "owner gone" so we disarm KA for that session.
    if (sess.pid === 1) return false
    return this.liveness.isAlive(sess.pid)
  }

  reapDead(): string[] {
    const killed: string[] = []
    for (const [sid, sess] of this.sessions.entries()) {
      if (sess.pid === null) continue  // no PID = never reap
      // Reap if PID is dead OR re-parented to init (owner died, kernel reparented)
      const dead = sess.pid === 1 || !this.liveness.isAlive(sess.pid)
      if (dead) {
        // Stop engine if it has a stop() method
        try { (sess.engine as any)?.stop?.() } catch { /* engine cleanup best-effort */ }
        this.sessions.delete(sid)
        killed.push(sid)
      }
    }
    return killed
  }

  stopAll(): void {
    for (const sess of this.sessions.values()) {
      try { (sess.engine as any)?.stop?.() } catch { /* cleanup */ }
    }
    this.sessions.clear()
  }
}

// ═══ Adapter 5: DefaultLivenessChecker ═══════════════════════════════
//
// POSIX kill(pid, 0) — standard Unix technique. Sends signal 0 (no-op)
// to check if process exists + we have permission to signal it. Works
// on macOS, Linux, BSD. On Windows: fails gracefully (returns false),
// which would mean all PIDs look dead — fine for non-Windows proxy.

export class DefaultLivenessChecker implements ILivenessChecker {
  /**
   * Answers ONLY the question: is this PID currently a running process?
   * Does NOT filter by legitimacy (e.g. "is this a realistic owner PID")
   * — that's ISessionStore's concern.
   *
   * Invalid inputs (0, negative) return false since there's no such PID.
   */
  isAlive(pid: number): boolean {
    if (!pid || pid < 1) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err: any) {
      // ESRCH = no such process (truly dead)
      // EPERM = process exists but we lack permission to signal it —
      //        treat as ALIVE (common when checking root PIDs as user,
      //        or PID 1 which is always alive but requires privileges).
      if (err.code === 'EPERM') return true
      return false
    }
  }
}

// ═══ Adapter 6: NativeFetchUpstream ══════════════════════════════════
//
// Default upstream transport — uses global fetch (Node 18+, Bun, Deno).
// Zero dependencies. Consumers needing tracing/retries/mTLS would replace
// this with a custom adapter.

export class NativeFetchUpstream implements IUpstreamFetcher {
  async fetch(
    url: string,
    init: {
      method: 'POST'
      headers: Record<string, string>
      body: string
      signal?: AbortSignal
    },
  ): Promise<Response> {
    return fetch(url, init)
  }
}
