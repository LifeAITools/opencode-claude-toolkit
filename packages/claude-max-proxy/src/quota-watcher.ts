/**
 * Quota Watcher — Stage 2 of the quota pipeline (the PROCESSOR).
 *
 * Pipeline:  stats-emitter.ts (Stage 1, in-proxy)  →  THIS (Stage 2)  →
 *            signal-wire-hook.sh (Stage 3, injector).
 *
 * Runs as its OWN process (claude-max-quota-watcher.service), not inside the
 * proxy — see the `import.meta.main` block at the bottom. The decoupling is
 * deliberate: this compute logic can be hot-restarted without cooling the
 * proxy's warmed KA sessions. Stages communicate only via on-disk files whose
 * paths + wire-schema version are the SSOT in quota-paths.ts.
 *
 * ─── Responsibilities ────────────────────────────────────────────────
 *
 * 1. Tail ~/.claude-local/claude-max-stats.jsonl in real time.
 *    Each line is a versioned record written by the proxy's stats-emitter.ts
 *    for every upstream response carrying rate-limit utilisation. Shape:
 *
 *      { v, ts, pid, type:"stream", model,
 *        usage: { in, out, cacheRead, cacheWrite },
 *        rateLimit: { status, resetAt?, util5h, util7d } }
 *
 *    Kernel-side O_APPEND atomicity guarantees lines land intact even
 *    with N parallel writers (max line size << PIPE_BUF=4096). So tailing
 *    is contention-free. Every line is validated (JSON + schema `v` + shape);
 *    a bad line is skipped + counted + logged, never crashing the loop, and
 *    the last-good aggregate is retained.
 *
 * 2. Aggregate per-pid + per-accountHint quota state.
 *    accountHint is inferred from observed util5h/util7d clustering: pids
 *    that consistently report the same util5h trajectory belong to the
 *    same Anthropic account. (Multiple pids can share an account; one pid
 *    can switch accounts via re-login.)
 *
 * 3. fs.watch ~/.claude/.credentials.json. On every change:
 *      - Read new credentials (just expiresAt + accessToken hash).
 *      - Compare to last-known. If expiresAt jumped significantly (>60s
 *        difference vs cached), this is a re-login (new account or
 *        manual refresh), not routine rotation.
 *      - Append a TOKEN_FILE_CHANGED event to ~/.claude-local/
 *        token-events.jsonl with old vs new hint and expiresAt.
 *      - Emit TOKEN_FILE_CHANGED to event-bus (so it appears in
 *        proxy.log + heartbeat).
 *
 * 4. Threshold detection: util5h ≥ 0.98 OR util7d ≥ 0.99 → critical.
 *    Per-pid critical state is reported to ~/.claude-local/
 *    quota-status.json (atomic write tmp+rename).
 *
 * ─── Output files (THIS module is sole writer) ───────────────────────
 *
 * ~/.claude-local/quota-status.json
 *   Snapshot of currently-known per-account and per-pid quota state.
 *   Atomic write (tmpfile + rename) every state change, throttled to
 *   ≥5s between writes (no firehose of identical state).
 *
 *   Schema:
 *     {
 *       version: 1,
 *       updatedAt: ISO,
 *       accounts: {
 *         <accountHint>: {
 *           accountHint,
 *           util5h, util7d, resetAt, level: "ok"|"warning"|"critical",
 *           message,
 *           issuedAt: ISO,
 *           pids: [<pid>...]
 *         }
 *       },
 *       pids: {
 *         <pid>: {
 *           pid, accountHint, util5h, util7d, level,
 *           lastSeenAt, lastResetAt
 *         }
 *       }
 *     }
 *
 * ~/.claude-local/token-events.jsonl
 *   Append-only timeline of token rotation events. Survives proxy
 *   restarts (we only append; never truncate). Each line is a single JSON:
 *
 *     { ts, kind: "TOKEN_FILE_CHANGED" | "TOKEN_REFRESHED" | "PROXY_BOOT",
 *       prevExpiresAt, newExpiresAt, prevHint, newHint, ... }
 *
 * ─── Hot-restart contract ────────────────────────────────────────────
 *
 * This process can be stopped/restarted freely. On boot it tails the stats
 * stream from the CURRENT end (no history replay) and rebuilds aggregate
 * state from live traffic. quota-status.json is written atomically
 * (tmp+rename) so a reader (the injector) never observes a torn file.
 */

import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher,
} from 'fs'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import { emit, bus } from './event-bus.js'
import {
  CLAUDE_LOCAL,
  STATS_JSONL,
  QUOTA_STATUS_JSON,
  TOKEN_EVENTS_JSONL,
  STATS_SCHEMA_VERSION,
} from './quota-paths.js'

// ─── Paths ────────────────────────────────────────────────────────────
// Path SSOT lives in quota-paths.ts (shared with stats-emitter.ts, a
// separate process). Do NOT redefine paths here — import them.

// ─── Tunables ────────────────────────────────────────────────────────

const STATS_POLL_INTERVAL_MS = 1_000          // tail polling cadence
const QUOTA_WRITE_THROTTLE_MS = 5_000         // min interval between SSOT writes
const PID_STATE_PRUNE_AFTER_MS = 30 * 60_000  // forget pids silent >30min
const UTIL5H_CRITICAL = 0.98
const UTIL7D_CRITICAL = 0.99
const UTIL5H_WARNING = 0.85
const UTIL7D_WARNING = 0.95
const TOKEN_REFRESH_DELTA_MS = 60_000          // expiresAt jump > 60s = real change

// ─── Types ───────────────────────────────────────────────────────────

interface StatsLine {
  v?: number               // wire-schema version stamped by stats-emitter; absent = legacy
  ts?: string
  pid?: number
  ses?: string
  type?: string
  usage?: {
    in?: number
    out?: number
    cacheRead?: number
    cacheWrite?: number
  }
  rateLimit?: {
    status?: string
    claim?: string
    resetAt?: number       // unix-seconds
    util5h?: number | null
    util7d?: number | null
  }
}

interface PidState {
  pid: number
  accountHint: string         // sha256(util5h-trajectory + first-seen) prefix
  util5h: number | null
  util7d: number | null
  resetAt: number | null
  lastSeenAt: number          // ms
  lastUtil5hChange: number    // ms — when util5h last changed value
  level: 'ok' | 'warning' | 'critical'
}

interface AccountState {
  accountHint: string
  util5h: number | null
  util7d: number | null
  resetAt: number | null
  /** 'observed' = resetAt came from the upstream rate-limit header on this
   *  aggregate; 'carried' = upstream omitted it, value is the remembered
   *  expectation from an earlier observation of the SAME account (re-tuned on
   *  every fresh observation, dropped once it expires). */
  resetAtSource?: 'observed' | 'carried'
  level: 'ok' | 'warning' | 'critical'
  message: string
  issuedAt: string
  pids: number[]
}

interface QuotaStatusFile {
  version: 1
  updatedAt: string
  accounts: Record<string, AccountState>
  pids: Record<string, PidState>
}

interface TokenEvent {
  ts: string
  kind: 'TOKEN_FILE_CHANGED' | 'TOKEN_REFRESHED' | 'PROXY_BOOT' | 'PROXY_SHUTDOWN'
  prevExpiresAt?: number | null
  newExpiresAt?: number | null
  prevHint?: string | null
  newHint?: string | null
  expiresInSec?: number | null
  reason?: string
}

interface CredsSnapshot {
  expiresAt: number | null
  hint: string | null   // sha256(accessToken)[0:12]
}

export interface QuotaWatcherOptions {
  credentialsPath: string
}

// ─── State ───────────────────────────────────────────────────────────

const pidStates = new Map<number, PidState>()
const accountStates = new Map<string, AccountState>()
/** resetAt carry-forward: upstream sends the rate-limit reset header only on
 *  SOME responses, so the aggregate's resetAt flickers to null while the
 *  window it described is still running. Whenever an account yields a real
 *  resetAt we record it here (timestamp of receipt + the suggested reset);
 *  null aggregates of the same account then reuse the expectation until it
 *  expires, and every fresh observation re-tunes it. Seeded from the previous
 *  quota-status.json at boot so a watcher restart doesn't forget expectations. */
const expectedResetAt = new Map<string, { resetAt: number; observedAt: number }>()
let lastWriteAt = 0
let pendingWrite = false
let lastCreds: CredsSnapshot = { expiresAt: null, hint: null }
let credsWatcher: FSWatcher | null = null
let statsTailTimer: ReturnType<typeof setInterval> | null = null
let statsFileOffset = 0  // byte offset into stats.jsonl for tail-from-end
let statsBuffer = ''     // residual line fragment between polls

// ─── Corruption accounting ───────────────────────────────────────────
// A bad input line must NEVER crash the tail loop or poison the aggregate.
// We count rejections by reason and surface them on a throttled bus warning
// so the failure is observable without firehosing the log on a persistently
// malformed stream.
const CORRUPTION_REPORT_THROTTLE_MS = 60_000
const rejected = { badJson: 0, badSchema: 0, badShape: 0 }
let lastCorruptionReportAt = 0

function reportCorruption(reason: string, sample: string): void {
  if (reason === 'badJson') rejected.badJson++
  else if (reason === 'badSchema') rejected.badSchema++
  else rejected.badShape++

  const now = Date.now()
  if (now - lastCorruptionReportAt < CORRUPTION_REPORT_THROTTLE_MS) return
  lastCorruptionReportAt = now
  emit({
    level: 'error',
    kind: 'QUOTA_WATCHER_LINE_REJECTED',
    msg: `rejected stats lines (kept last-good aggregate): badJson=${rejected.badJson} badSchema=${rejected.badSchema} badShape=${rejected.badShape}; last reason=${reason}`,
    sample: sample.slice(0, 160),
  })
}

// ─── Public API ──────────────────────────────────────────────────────

export function startQuotaWatcher(opts: QuotaWatcherOptions): () => void {
  ensureDir(CLAUDE_LOCAL)

  // 0. Seed resetAt expectations from the previous snapshot BEFORE the boot
  //    write below wipes it — a watcher restart must not forget a still-valid
  //    reset time that upstream may not repeat for a while.
  try {
    const prev = JSON.parse(readFileSync(QUOTA_STATUS_JSON, 'utf8')) as QuotaStatusFile
    const now = Date.now()
    for (const [hint, acc] of Object.entries(prev.accounts ?? {})) {
      if (typeof acc?.resetAt === 'number' && acc.resetAt > now) {
        expectedResetAt.set(hint, { resetAt: acc.resetAt, observedAt: now })
      }
    }
  } catch {
    // first boot / missing / corrupt previous snapshot — nothing to seed
  }

  // 1. Boot event
  appendTokenEvent({
    ts: new Date().toISOString(),
    kind: 'PROXY_BOOT',
    reason: 'quota-watcher started',
  })

  // 2. Initial credentials snapshot (no event — we have nothing to compare to)
  lastCreds = readCreds(opts.credentialsPath)
  emit({
    level: 'info',
    kind: 'QUOTA_WATCHER_BOOT',
    msg: `quota-watcher online; tracking ${STATS_JSONL}`,
    credsHint: lastCreds.hint,
    credsExpiresInSec: lastCreds.expiresAt
      ? Math.floor((lastCreds.expiresAt - Date.now()) / 1000)
      : null,
  })

  // 3. fs.watch credentials
  startCredsWatcher(opts.credentialsPath)

  // 4. Tail stats.jsonl from CURRENT END (don't replay history at boot)
  initStatsTailFromEnd()
  statsTailTimer = setInterval(() => {
    try { pollStatsTail() } catch (e) {
      emit({ level: 'error', kind: 'QUOTA_WATCHER_TAIL_ERROR', msg: String(e) })
    }
  }, STATS_POLL_INTERVAL_MS)
  ;(statsTailTimer as any)?.unref?.()

  // Initial empty SSOT write so consumers see the file exists
  writeQuotaStatus()

  return () => stopQuotaWatcher()
}

function stopQuotaWatcher(): void {
  if (statsTailTimer) clearInterval(statsTailTimer)
  if (credsWatcher) credsWatcher.close()
  appendTokenEvent({
    ts: new Date().toISOString(),
    kind: 'PROXY_SHUTDOWN',
    reason: 'quota-watcher stopped',
  })
}

// ─── Credentials watcher ─────────────────────────────────────────────

function startCredsWatcher(path: string): void {
  try {
    credsWatcher = watch(path, { persistent: false }, (evt) => {
      if (evt !== 'change' && evt !== 'rename') return
      // Slight delay — coalesce rapid writes (atomic-rename pattern from
      // claude CLI may produce multiple events for one logical change)
      setTimeout(() => onCredsChange(path), 50)
    })
    credsWatcher?.unref?.()
    emit({
      level: 'info',
      kind: 'TOKEN_WATCHER_INIT',
      msg: `fs.watch active on ${path}`,
    })
  } catch (e: any) {
    emit({
      level: 'error',
      kind: 'TOKEN_WATCHER_FAIL',
      msg: `fs.watch ${path} failed: ${e?.message ?? String(e)}`,
    })
  }
}

function onCredsChange(path: string): void {
  const fresh = readCreds(path)
  const expiresDelta =
    fresh.expiresAt != null && lastCreds.expiresAt != null
      ? Math.abs(fresh.expiresAt - lastCreds.expiresAt)
      : null
  const isReallyDifferent =
    fresh.hint !== lastCreds.hint ||
    (expiresDelta != null && expiresDelta > TOKEN_REFRESH_DELTA_MS)

  if (!isReallyDifferent) {
    // Touch with same content (e.g. mtime bumped without real change). Ignore.
    return
  }

  const evt: TokenEvent = {
    ts: new Date().toISOString(),
    kind: 'TOKEN_FILE_CHANGED',
    prevHint: lastCreds.hint,
    newHint: fresh.hint,
    prevExpiresAt: lastCreds.expiresAt,
    newExpiresAt: fresh.expiresAt,
    expiresInSec: fresh.expiresAt
      ? Math.floor((fresh.expiresAt - Date.now()) / 1000)
      : null,
    reason: lastCreds.hint && fresh.hint && lastCreds.hint !== fresh.hint
      ? 're-login (account/token swap)'
      : 'token refresh',
  }
  appendTokenEvent(evt)
  emit({
    level: 'info',
    kind: 'TOKEN_FILE_CHANGED',
    msg: `${evt.reason}: hint ${lastCreds.hint ?? '(none)'} → ${fresh.hint ?? '(none)'}, expires in ${evt.expiresInSec}s`,
    prevHint: lastCreds.hint,
    newHint: fresh.hint,
    expiresInSec: evt.expiresInSec,
  })
  lastCreds = fresh
}

function readCreds(path: string): CredsSnapshot {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth
    if (!oauth?.accessToken) return { expiresAt: null, hint: null }
    return {
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      hint: createHash('sha256').update(oauth.accessToken).digest('hex').slice(0, 12),
    }
  } catch {
    return { expiresAt: null, hint: null }
  }
}

// ─── Stats tail ──────────────────────────────────────────────────────

function initStatsTailFromEnd(): void {
  try {
    const st = statSync(STATS_JSONL)
    statsFileOffset = st.size
  } catch {
    statsFileOffset = 0
  }
}

function pollStatsTail(): void {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(STATS_JSONL)
  } catch {
    return
  }

  // Detect truncation/rotation: file shorter than our offset → start from 0
  if (st.size < statsFileOffset) {
    statsFileOffset = 0
    statsBuffer = ''
  }

  if (st.size === statsFileOffset) return // nothing new

  // Read incremental tail
  const stream = createReadStream(STATS_JSONL, {
    start: statsFileOffset,
    end: st.size - 1,
    encoding: 'utf8',
  })

  let chunk = ''
  stream.on('data', (data) => { chunk += data })
  stream.on('end', () => {
    statsFileOffset = st.size
    statsBuffer += chunk
    const lines = statsBuffer.split('\n')
    statsBuffer = lines.pop() ?? ''  // residual
    for (const line of lines) {
      if (!line.trim()) continue
      let parsed: StatsLine
      try {
        parsed = JSON.parse(line) as StatsLine
      } catch {
        // Malformed JSON — skip + count. Partial-write race shouldn't happen
        // with O_APPEND but tolerate weirdness; aggregate stays last-good.
        reportCorruption('badJson', line)
        continue
      }
      // Schema gate: a future emitter format must never silently corrupt a
      // running processor. Accept our known version, and legacy lines with no
      // `v` (best-effort). Any other version → reject + log.
      if (parsed.v !== undefined && parsed.v !== STATS_SCHEMA_VERSION) {
        reportCorruption('badSchema', line)
        continue
      }
      try {
        ingestStatsLine(parsed)
      } catch (e: any) {
        // A bad shape that slipped past JSON.parse must not kill the loop.
        reportCorruption('badShape', line)
      }
    }
    maybeWriteQuotaStatus()
  })
  stream.on('error', () => { /* swallow; next tick retries */ })
}

function ingestStatsLine(line: StatsLine): void {
  const pid = line.pid
  if (typeof pid !== 'number' || pid < 1) return
  if (line.type !== 'stream') return // we care about real upstream responses

  const util5h = line.rateLimit?.util5h ?? null
  const util7d = line.rateLimit?.util7d ?? null
  const resetAt = line.rateLimit?.resetAt
    ? line.rateLimit.resetAt * 1000
    : null
  const ts = line.ts ? Date.parse(line.ts) : Date.now()

  // skip rows with no rate-limit info (KA fires sometimes lack it)
  if (util5h === null && util7d === null) return

  const prev = pidStates.get(pid)
  const utilChanged = !prev || prev.util5h !== util5h || prev.util7d !== util7d

  // Account hint inference: trajectory clustering by util5h+resetAt window.
  // Pids sharing the same (util5h band, resetAt) within a 60s window are
  // "same account". For first-seen pids we hash their first util5h+resetAt
  // signature; subsequent pids matching that signature inherit the hint.
  const accountHint = inferAccountHint(pid, util5h, resetAt, prev)

  const state: PidState = {
    pid,
    accountHint,
    util5h,
    util7d,
    resetAt,
    lastSeenAt: ts,
    lastUtil5hChange: utilChanged ? ts : (prev?.lastUtil5hChange ?? ts),
    level: classifyLevel(util5h, util7d),
  }
  pidStates.set(pid, state)
  recomputeAccountFromPids(accountHint)
}

function classifyLevel(
  util5h: number | null,
  util7d: number | null,
): 'ok' | 'warning' | 'critical' {
  const u5 = util5h ?? 0
  const u7 = util7d ?? 0
  if (u5 >= UTIL5H_CRITICAL || u7 >= UTIL7D_CRITICAL) return 'critical'
  if (u5 >= UTIL5H_WARNING || u7 >= UTIL7D_WARNING) return 'warning'
  return 'ok'
}

// Account hint: sha256 over (util5h-bucket, util7d-bucket, resetAt-bucket).
// Bucket coarsening: util5h to 2 decimal places, resetAt to nearest hour.
// This intentionally collapses small variations within an account while
// distinguishing different accounts whose 5h/7d windows differ.
function inferAccountHint(
  pid: number,
  util5h: number | null,
  resetAt: number | null,
  prev: PidState | undefined,
): string {
  // If we already have a hint for this pid AND the util/reset hasn't shifted
  // dramatically, keep it. Drama threshold: util5h delta > 0.5 OR resetAt
  // delta > 1h → likely account swap.
  if (prev) {
    const u5delta = Math.abs((util5h ?? 0) - (prev.util5h ?? 0))
    // resetAt is only present on SOME upstream responses. A missing header is
    // NOT evidence of an account swap — comparing null as 0 made every header
    // flicker look like a >1h "drama", re-hashing the pid to a fresh hint and
    // breaking per-account continuity (incl. resetAt carry-forward). Compare
    // only when both sides actually carry a value.
    const resetDelta = resetAt != null && prev.resetAt != null
      ? Math.abs(resetAt - prev.resetAt)
      : 0
    if (u5delta < 0.5 && resetDelta < 60 * 60_000) return prev.accountHint
  }

  const bucket = JSON.stringify({
    u5: util5h != null ? Math.round(util5h * 100) / 100 : null,
    reset: resetAt != null ? Math.floor(resetAt / (60 * 60_000)) : null,
  })
  return createHash('sha256').update(bucket).digest('hex').slice(0, 12)
}

function recomputeAccountFromPids(accountHint: string): void {
  // Aggregate: max util5h, max util7d, latest resetAt, pids list
  let util5h: number | null = null
  let util7d: number | null = null
  let resetAt: number | null = null
  const pids: number[] = []

  for (const s of pidStates.values()) {
    if (s.accountHint !== accountHint) continue
    pids.push(s.pid)
    if (s.util5h != null && (util5h == null || s.util5h > util5h)) util5h = s.util5h
    if (s.util7d != null && (util7d == null || s.util7d > util7d)) util7d = s.util7d
    if (s.resetAt != null && (resetAt == null || s.resetAt > resetAt)) resetAt = s.resetAt
  }
  if (pids.length === 0) {
    accountStates.delete(accountHint)
    return
  }

  // resetAt carry-forward (see expectedResetAt above): observed → remember/re-tune;
  // null → reuse the unexpired expectation; expired expectation → drop it.
  let resetAtSource: 'observed' | 'carried' | undefined
  if (resetAt != null) {
    resetAtSource = 'observed'
    expectedResetAt.set(accountHint, { resetAt, observedAt: Date.now() })
  } else {
    const exp = expectedResetAt.get(accountHint)
    if (exp) {
      if (exp.resetAt > Date.now()) {
        resetAt = exp.resetAt
        resetAtSource = 'carried'
      } else {
        expectedResetAt.delete(accountHint)
      }
    }
  }

  const level = classifyLevel(util5h, util7d)
  const resetInMin = resetAt
    ? Math.max(0, Math.round((resetAt - Date.now()) / 60_000))
    : null
  const message = level === 'critical'
    ? `QUOTA CRITICAL on account ${accountHint}: util5h=${pct(util5h)} util7d=${pct(util7d)}. Reset in ${resetInMin}min. STOP NEW WORK. Either wait for reset (cache preserved) OR switch org via 'claude /login' (forces ~150k cw cache rebuild on new org).`
    : level === 'warning'
    ? `Quota warning on account ${accountHint}: util5h=${pct(util5h)} util7d=${pct(util7d)}. Reset in ${resetInMin}min.`
    : `Quota OK on account ${accountHint}.`

  const prev = accountStates.get(accountHint)
  // issuedAt only updates when level transitions UP (ok→warning, warning→critical)
  // so consumers can dedup by issuedAt without missing reissues.
  const issuedAt =
    prev && levelRank(prev.level) >= levelRank(level)
      ? prev.issuedAt
      : new Date().toISOString()

  accountStates.set(accountHint, {
    accountHint,
    util5h,
    util7d,
    resetAt,
    ...(resetAtSource ? { resetAtSource } : {}),
    level,
    message,
    issuedAt,
    pids: pids.sort(),
  })
}

function levelRank(l: 'ok' | 'warning' | 'critical'): number {
  return l === 'critical' ? 2 : l === 'warning' ? 1 : 0
}

function pct(v: number | null): string {
  if (v == null) return '?'
  return `${(v * 100).toFixed(0)}%`
}

// ─── SSOT writer (atomic, throttled) ─────────────────────────────────

function maybeWriteQuotaStatus(): void {
  const now = Date.now()
  pruneStaleStates(now)
  if (now - lastWriteAt < QUOTA_WRITE_THROTTLE_MS) {
    if (!pendingWrite) {
      pendingWrite = true
      const delay = QUOTA_WRITE_THROTTLE_MS - (now - lastWriteAt)
      setTimeout(() => { pendingWrite = false; writeQuotaStatus() }, delay)
    }
    return
  }
  writeQuotaStatus()
}

function writeQuotaStatus(): void {
  const file: QuotaStatusFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts: Object.fromEntries(accountStates),
    pids: Object.fromEntries(
      Array.from(pidStates.entries()).map(([pid, s]) => [String(pid), s]),
    ),
  }
  const tmp = QUOTA_STATUS_JSON + '.tmp'
  try {
    writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
    renameSync(tmp, QUOTA_STATUS_JSON)
    lastWriteAt = Date.now()
  } catch (e: any) {
    emit({
      level: 'error',
      kind: 'QUOTA_STATUS_WRITE_FAIL',
      msg: e?.message ?? String(e),
    })
  }
}

function pruneStaleStates(now: number): void {
  const cutoff = now - PID_STATE_PRUNE_AFTER_MS
  const affectedAccounts = new Set<string>()
  for (const [pid, s] of pidStates.entries()) {
    if (s.lastSeenAt < cutoff) {
      affectedAccounts.add(s.accountHint)
      // Also reap if pid is dead (kill -0 check)
      if (!isPidAlive(pid)) {
        pidStates.delete(pid)
        continue
      }
      // Pid alive but silent — keep state but mark stale by zeroing util
      // (or just leave as-is; lastSeenAt suffices for consumers)
    }
  }
  for (const h of affectedAccounts) recomputeAccountFromPids(h)
}

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e: any) {
    return e?.code === 'EPERM'
  }
}

// ─── Append-only token events log ────────────────────────────────────

function appendTokenEvent(evt: TokenEvent): void {
  try {
    appendFileSync(TOKEN_EVENTS_JSONL, JSON.stringify(evt) + '\n', 'utf8')
  } catch (e: any) {
    emit({
      level: 'error',
      kind: 'TOKEN_EVENTS_APPEND_FAIL',
      msg: e?.message ?? String(e),
    })
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

function ensureDir(d: string): void {
  if (!existsSync(d)) {
    try { mkdirSync(d, { recursive: true }) } catch { /* ignore */ }
  }
}

// ─── Standalone entry (the PROCESSOR runs as its own service) ─────────
//
// Run via `bun run src/quota-watcher.ts` under its own systemd unit
// (claude-max-quota-watcher.service). Decoupling the processor from the
// proxy is deliberate: its compute logic can be hot-restarted with
// `systemctl --user restart claude-max-quota-watcher` WITHOUT cooling the
// proxy's warmed KA sessions. The proxy only runs the stats EMITTER; this
// process owns the compute → quota-status.json stage; the hook owns inject.
if (import.meta.main) {
  // Observability: standalone we are NOT inside the proxy, so logger.ts (which
  // subscribes the bus → file) is not running. Attach a minimal bus→stdout
  // sink here so this process's events — crucially QUOTA_WATCHER_LINE_REJECTED
  // corruption reports — land in claude-max-quota-watcher.log via systemd.
  bus.onEvent((e: any) => {
    const ts = (e.ts ?? new Date().toISOString()).slice(11, 23)
    const extras = Object.entries(e)
      .filter(([k]) => !['ts', 'level', 'kind', 'msg'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ')
    process.stdout.write(
      `${ts} ${String(e.level ?? 'info').toUpperCase().padEnd(5)} ${String(e.kind ?? '').padEnd(26)} ${e.msg ?? ''}${extras ? ' ' + extras : ''}\n`,
    )
  })

  const credentialsPath =
    process.env.CLAUDE_CREDENTIALS_PATH
      ? process.env.CLAUDE_CREDENTIALS_PATH.replace(/^~/, homedir())
      : join(homedir(), '.claude', '.credentials.json')

  const stop = startQuotaWatcher({ credentialsPath })

  // startQuotaWatcher().unref()s its timers so it never keeps the *proxy*
  // process alive when embedded. Standalone we DO want to stay alive — a
  // ref'd no-op timer holds the event loop open until a signal arrives.
  const keepAlive = setInterval(() => {}, 1 << 30)

  const shutdown = () => {
    clearInterval(keepAlive)
    try { stop() } catch { /* best effort */ }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // Never crash the processor on an unexpected error — log and keep tailing.
  process.on('uncaughtException', (err: any) => {
    emit({
      level: 'error',
      kind: 'QUOTA_WATCHER_UNCAUGHT',
      msg: `uncaughtException: ${err?.message ?? String(err)}`,
    })
  })

  emit({
    level: 'info',
    kind: 'QUOTA_WATCHER_STANDALONE',
    msg: `quota-watcher running standalone (creds=${credentialsPath})`,
  })
}
