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
 * 4. Threshold detection: util5h ≥ 0.90 OR util7d ≥ 0.99 → critical.
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

/** Хранилище аккаунтов: оттуда берётся ТОЛЬКО человеческое имя аккаунта
 *  (почта + организация). Токены в этом файле не читаются. */
const ORG_VAULT_JSON = join(homedir(), '.claude-local', 'org-vault.json')
import {
  CLAUDE_LOCAL,
  STATS_JSONL,
  QUOTA_STATUS_JSON,
  TOKEN_EVENTS_JSONL,
  STATS_SCHEMA_VERSION,
  orgKeyFromOauth,
} from './quota-paths.js'

// ─── Paths ────────────────────────────────────────────────────────────
// Path SSOT lives in quota-paths.ts (shared with stats-emitter.ts, a
// separate process). Do NOT redefine paths here — import them.

// ─── Tunables ────────────────────────────────────────────────────────

const STATS_POLL_INTERVAL_MS = 1_000          // tail polling cadence
const QUOTA_WRITE_THROTTLE_MS = 5_000         // min interval between SSOT writes
const PID_STATE_PRUNE_AFTER_MS = 30 * 60_000  // forget pids silent >30min
/** How long a SESSION's account binding is remembered after it goes quiet.
 *
 *  🔴 DELIBERATELY 24× THE PID WINDOW, and the difference is not an oversight.
 *  A pid entry is a live measurement — its utilisation goes stale the moment
 *  the process stops reporting, so holding it longer would mean answering with
 *  a number that is no longer true. A session entry says only WHICH ACCOUNT the
 *  session runs on, and that does not decay: the pin is held for the session's
 *  whole life and only a human's explicit reload moves it (project rail
 *  `no-live-account-migration`). Ageing it out on the pid clock threw away a
 *  fact that was still correct.
 *
 *  And it threw it away for exactly the sessions that need it. The wake-router
 *  must not wake an agent whose 5h window is over 95% spent (founder, 2026-09-03);
 *  the agent most likely to be woken is the one that has been idle for hours —
 *  which is precisely the one a 30-minute clock had already forgotten. Its owner
 *  measured 2 of 6 live sessions resolvable at 13:14 that day.
 *
 *  Consumers still see `lastSeenAt` untouched, so an old reading is legible AS
 *  old; this window governs when we stop answering at all, not how fresh we
 *  claim the answer is. */
const SESSION_STATE_PRUNE_AFTER_MS = 12 * 60 * 60_000  // 12h
// 0.98 → 0.90 (2026-08-16, founder directive): agents given the critical signal at
// 98% could not finish their current step in the remaining 2% and ran into 100%
// and a 429 storm. 10% headroom buys a lossless wrap-up. Mirrors the engine-side
// stop wall (signal-wire quota-critical-5h, also 0.90).
const UTIL5H_CRITICAL = 0.90
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
  /** Stable per-organization key stamped by the emitter (multi-org hosts).
   *  When present it IS the account identity — no trajectory heuristics. */
  org?: string
  usage?: {
    in?: number
    out?: number
    cacheRead?: number
    cacheWrite?: number
  }
  rateLimit?: {
    status?: string
    claim?: string
    resetAt?: number       // 5h window, unix-seconds
    resetAt7d?: number     // 7d window, unix-seconds — a SEPARATE clock (see below)
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
  resetAt7d: number | null
  lastSeenAt: number          // ms
  lastUtil5hChange: number    // ms — when util5h last changed value
  level: 'ok' | 'warning' | 'critical'
}

interface AccountState {
  accountHint: string
  /** Почта аккаунта и название его организации — как их называет человек.
   *  Переносятся из хранилища аккаунтов (там они захватываются при входе), а не
   *  из конфигурации входа этой машины: та описывает ОДИН аккаунт, поэтому у
   *  остальных имя оставалось неизвестным и голый номер читался как поломка
   *  (вопрос фаундера 03.09.2026). Отсутствуют, когда аккаунта нет в хранилище. */
  accountEmail?: string
  /** То же значение под именем, которое читают потребители ниже по цепи
   *  (присутствие в SynqTask и поверхность Telegram). Два написания — цена
   *  того, что моё первое имя не совпало с уже читаемым. */
  account_email?: string
  orgName?: string
  util5h: number | null
  util7d: number | null
  resetAt: number | null
  /** 'observed' = resetAt came from the upstream rate-limit header on this
   *  aggregate; 'carried' = upstream omitted it, value is the remembered
   *  expectation from an earlier observation of the SAME account (re-tuned on
   *  every fresh observation, dropped once it expires). */
  resetAtSource?: 'observed' | 'carried'
  /**
   * ДВА ОКНА, ДВА ЧАСА, ДВА ПОЛЯ — И СРАЗУ В ISO.
   *
   * `resetAt` выше — пятичасовое окно в МИЛЛИСЕКУНДАХ, и оно остаётся ради тех, кто уже его
   * читает. Но одну и ту же отметку по дороге меряют по-разному: Anthropic шлёт СЕКУНДЫ, после
   * этого коллектора она едет МИЛЛИСЕКУНДАМИ, и угадывание по величине однажды напечатало
   * «год 58598». Поэтому конверсия живёт здесь — в единственном месте, где известно, из какого
   * заголовка пришло число и в чём оно измерено, — а наружу идёт ISO, у которого единицы нет.
   *
   * И это ДВА поля, а не одно: замер 2026-08-17 показал, что в один и тот же миг пятичасовое
   * окно сбрасывалось через 13 минут, а семидневное — через 142 часа. Совпадение обоих
   * заголовков, которое видно в логе, говорит лишь о том, что ОДИН источник кладёт одно
   * значение в оба, а не о том, что окна сбрасываются вместе.
   */
  reset5hAt: string | null
  reset7dAt: string | null
  level: 'ok' | 'warning' | 'critical'
  message: string
  issuedAt: string
  /** pidStates keys contributing to this account (composite `${pid}::${org}`
   *  for org-stamped traffic; bare pid for legacy). Consumers index the
   *  snapshot `pids` map by these to derive per-account last-seen freshness. */
  pids: string[]
}

/** session → org attribution (multi-org hosts): which organization served a
 *  given proxy session's traffic last. Consumers (badge, signal-wire hook)
 *  look their own session up here FIRST; pool aggregation is the fallback. */
interface SessionState {
  org: string
  lastSeenAt: number // ms
}

interface QuotaStatusFile {
  version: 1
  updatedAt: string
  accounts: Record<string, AccountState>
  pids: Record<string, PidState>
  sessions?: Record<string, SessionState>
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
  /** Per-organization key (orgKeyFromOauth) — same derivation the emitter
   *  stamps on stats lines; used to migrate state on token rotation. */
  orgKey: string | null
}

export interface QuotaWatcherOptions {
  credentialsPath: string
}

// ─── State ───────────────────────────────────────────────────────────

// Keyed by `${pid}::${org}` for org-stamped lines (one virtual client per
// concurrently-served org — see ingestStatsLine) and by the bare `${pid}` for
// legacy lines with no org field.
const pidStates = new Map<string, PidState>()
const accountStates = new Map<string, AccountState>()
const sessionStates = new Map<string, SessionState>()
/** resetAt carry-forward: upstream sends the rate-limit reset header only on
 *  SOME responses, so the aggregate's resetAt flickers to null while the
 *  window it described is still running. Whenever an account yields a real
 *  resetAt we record it here (timestamp of receipt + the suggested reset);
 *  null aggregates of the same account then reuse the expectation until it
 *  expires, and every fresh observation re-tunes it. Seeded from the previous
 *  quota-status.json at boot so a watcher restart doesn't forget expectations. */
const expectedResetAt = new Map<string, { resetAt: number; observedAt: number }>()
/** То же самое для НЕДЕЛЬНОГО окна — отдельной картой, а не вторым полем в первой: часы разные,
 *  и семидневная отметка переживает пятичасовую. Общая запись истекала бы по более раннему из
 *  двух сроков и уносила бы с собой ещё живое недельное ожидание. */
const expectedReset7dAt = new Map<string, { resetAt: number; observedAt: number }>()
let lastWriteAt = 0
let pendingWrite = false
let lastCreds: CredsSnapshot = { expiresAt: null, hint: null, orgKey: null }
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

/** Carry forward what a restart must not forget, from the previous snapshot.
 *  Split out of the boot path so a test can drive it with a hand-built file
 *  instead of the machine's real one. */
function seedFromPreviousSnapshot(prev: QuotaStatusFile): void {
  const now = Date.now()
  for (const [hint, acc] of Object.entries(prev.accounts ?? {})) {
    if (typeof acc?.resetAt === 'number' && acc.resetAt > now) {
      expectedResetAt.set(hint, { resetAt: acc.resetAt, observedAt: now })
    }
    // Недельную отметку прежний снимок хранит уже в ISO — разбираем обратно в мс. Она живёт
    // днями, поэтому пережить перезапуск вотчера для неё важнее, чем для пятичасовой.
    const prev7d = acc?.reset7dAt ? Date.parse(acc.reset7dAt) : NaN
    if (Number.isFinite(prev7d) && prev7d > now) {
      expectedReset7dAt.set(hint, { resetAt: prev7d, observedAt: now })
    }
  }
  // Which account each SESSION runs on — seeded for the same reason, and it
  // matters to a reader outside this process.
  //
  // 🔴 MEASURED 2026-09-03 BY THE WAKE-ROUTER'S OWNER, who consumes this map.
  // The founder asked him to stop waking an agent whose 5h window is over 95%
  // spent. He can only judge a session whose account he can see — and at
  // 13:14 he saw 2 of 6 live sessions, against 24 of 30 two hours earlier.
  // The difference was not decay: the proxy had been redeployed in between,
  // and a restart emptied this map. Every sleeping session then stayed
  // invisible until it happened to call the model again, which for an idle
  // agent can be hours — precisely the agent the founder wants protected.
  //
  // Restoring is safe BECAUSE a session does not change accounts: the pin is
  // held for its whole life and only a human's explicit reload moves it
  // (project rail `no-live-account-migration`). So an entry read back from
  // disk names the same account it named before the restart. `lastSeenAt` is
  // carried over unchanged rather than stamped to now — a consumer deciding
  // on this must be able to see that the reading is old, and a fresh stamp
  // would be a lie about when we last heard from that session.
  for (const [sid, sess] of Object.entries(prev.sessions ?? {})) {
    if (typeof sess?.org === 'string' && typeof sess?.lastSeenAt === 'number') {
      sessionStates.set(sid, { org: sess.org, lastSeenAt: sess.lastSeenAt })
    }
  }
}

export function startQuotaWatcher(opts: QuotaWatcherOptions): () => void {
  ensureDir(CLAUDE_LOCAL)

  // 0. Seed resetAt expectations from the previous snapshot BEFORE the boot
  //    write below wipes it — a watcher restart must not forget a still-valid
  //    reset time that upstream may not repeat for a while.
  try {
    seedFromPreviousSnapshot(JSON.parse(readFileSync(QUOTA_STATUS_JSON, 'utf8')) as QuotaStatusFile)
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
    // Self-heal on a traffic-less reset: pollStatsTail only rewrites the SSOT
    // when new stats lines arrive, so a 5h window that resets while the host
    // is idle would otherwise keep advertising the PRE-reset utilization.
    try { applyResetPassed() } catch { /* best-effort — next tick retries */ }
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

  // Org-key rotation migration: the org key is token-derived (no real org uuid
  // exists in the creds), so a refresh-token rotation changes it while the
  // ORGANIZATION stays the same. Carry account state + reset expectations over
  // so quota continuity (and resetAt carry-forward) survive rotation. A true
  // org switch (re-login to another org) migrates too — harmless, since the
  // old org's pids stop producing lines and the migrated state is overwritten
  // by the new org's next readings.
  const prevOrg = lastCreds.orgKey
  const newOrg = fresh.orgKey
  if (prevOrg && newOrg && prevOrg !== newOrg) {
    const exp = expectedResetAt.get(prevOrg)
    if (exp) {
      expectedResetAt.set(newOrg, exp)
      expectedResetAt.delete(prevOrg)
    }
    const exp7 = expectedReset7dAt.get(prevOrg)
    if (exp7) {
      expectedReset7dAt.set(newOrg, exp7)
      expectedReset7dAt.delete(prevOrg)
    }
    const acct = accountStates.get(prevOrg)
    if (acct) {
      accountStates.set(newOrg, { ...acct, accountHint: newOrg })
      accountStates.delete(prevOrg)
    }
    for (const s of pidStates.values()) {
      if (s.accountHint === prevOrg) s.accountHint = newOrg
    }
    for (const s of sessionStates.values()) {
      if (s.org === prevOrg) s.org = newOrg
    }
    emit({
      level: 'info',
      kind: 'ORG_KEY_MIGRATED',
      msg: `org key rotated with token: ${prevOrg} → ${newOrg} (state migrated)`,
    })
  }

  lastCreds = fresh
}

function readCreds(path: string): CredsSnapshot {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    const oauth = parsed?.claudeAiOauth
    if (!oauth?.accessToken) return { expiresAt: null, hint: null, orgKey: null }
    return {
      expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null,
      hint: createHash('sha256').update(oauth.accessToken).digest('hex').slice(0, 12),
      orgKey: orgKeyFromOauth(oauth),
    }
  } catch {
    return { expiresAt: null, hint: null, orgKey: null }
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
  const resetAt7d = line.rateLimit?.resetAt7d
    ? line.rateLimit.resetAt7d * 1000
    : null
  const ts = line.ts ? Date.parse(line.ts) : Date.now()

  // skip rows with no rate-limit info (KA fires sometimes lack it)
  if (util5h === null && util7d === null) return

  // Per-ORG virtual client. Every stats line carries the SINGLE proxy process
  // pid (the emitter stamps PROXY_PID on all orgs), so keying pidStates by the
  // bare pid collapses every concurrently-served org onto ONE oscillating
  // account: recomputeAccountFromPids then finds zero pids for the just-left
  // org and DELETES it, so accounts never holds more than one org at a time.
  // The reader (signal-wire hook) can't find its session's org → falls through
  // to the only present org → shows a DIFFERENT org's quota (a session on a
  // healthy org sees an exhausted org's util, and vice-versa — false
  // cross-org display feeding both the badge AND the agent's quota gate).
  // Key by `${pid}::${org}` so each live org is its own virtual client and the
  // per-pid model keeps one AccountState per org. Legacy lines without an org
  // field keep the bare-pid key (pre-multi-org behaviour, trajectory-inferred).
  const hasOrg = typeof line.org === 'string' && line.org.length > 0
  const pidKey = hasOrg ? `${pid}::${line.org}` : String(pid)
  const prev = pidStates.get(pidKey)
  const utilChanged = !prev || prev.util5h !== util5h || prev.util7d !== util7d

  // Account identity: the emitter's per-organization stamp wins outright
  // (exact attribution on multi-org hosts). Trajectory-clustering heuristics
  // remain ONLY for legacy lines that predate the `org` field.
  const accountHint = hasOrg
    ? (line.org as string)
    : inferAccountHint(pid, util5h, resetAt, prev)

  const state: PidState = {
    pid,
    accountHint,
    util5h,
    util7d,
    resetAt,
    resetAt7d,
    lastSeenAt: ts,
    lastUtil5hChange: utilChanged ? ts : (prev?.lastUtil5hChange ?? ts),
    level: classifyLevel(util5h, util7d),
  }
  pidStates.set(pidKey, state)
  // session → org attribution for consumers (multi-org per-session lookup).
  if (typeof line.ses === 'string' && line.ses) {
    sessionStates.set(line.ses, { org: accountHint, lastSeenAt: ts })
  }
  recomputeAccountFromPids(accountHint)
  // Pid moved between accounts (legacy re-login / trajectory swap on a bare-pid
  // key) — recompute the old account too so it doesn't keep a phantom claim on
  // this pid. For org-stamped lines the org is part of pidKey, so prev always
  // shares accountHint and this branch is a no-op (orgs no longer evict each
  // other — the whole point of the composite key).
  if (prev && prev.accountHint !== accountHint) {
    recomputeAccountFromPids(prev.accountHint)
  }
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

/**
 * Человеческое имя аккаунта по его номеру: почта и название организации,
 * захваченные при входе и лежащие в хранилище аккаунтов.
 *
 * Читается с кэшем по времени правки файла: сборка состояния зовётся на каждом
 * событии, а хранилище меняется только на входе или обновлении токена. Из файла
 * берутся ТОЛЬКО два поля — токены не читаются, не логируются и не попадают
 * никуда дальше этой функции.
 *
 * Отсутствие остаётся отсутствием: нет записи — нет полей, и потребитель сам
 * решит, что показать вместо имени. Выдуманное имя было бы хуже номера.
 */
function lookupAccountIdentity(accountHint: string): { email?: string; orgName?: string } {
  try {
    const st = statSync(ORG_VAULT_JSON)
    if (st.mtimeMs !== vaultCacheMtime) {
      vaultCacheMtime = st.mtimeMs
      vaultCache = new Map()
      const raw = JSON.parse(readFileSync(ORG_VAULT_JSON, 'utf8')) as {
        orgs?: Record<string, { accountEmail?: string; orgName?: string }>
      }
      for (const [orgId, entry] of Object.entries(raw.orgs ?? {})) {
        if (!entry || typeof entry !== 'object') continue
        vaultCache.set(orgId, {
          ...(typeof entry.accountEmail === 'string' ? { email: entry.accountEmail } : {}),
          ...(typeof entry.orgName === 'string' ? { orgName: entry.orgName } : {}),
        })
      }
    }
  } catch {
    // Хранилища нет или оно нечитаемо — это не повод ронять учёт квоты.
    return {}
  }
  // accountHint — это orgId целиком либо его начало (историческая форма).
  const exact = vaultCache.get(accountHint)
  if (exact) return exact
  for (const [orgId, v] of vaultCache) {
    if (orgId.startsWith(accountHint)) return v
  }
  return {}
}

let vaultCacheMtime = -1
let vaultCache = new Map<string, { email?: string; orgName?: string }>()

function recomputeAccountFromPids(accountHint: string): void {
  // Aggregate: max util5h, max util7d, latest resetAt, pids list
  let util5h: number | null = null
  let util7d: number | null = null
  let resetAt: number | null = null
  let resetAt7d: number | null = null
  const pids: string[] = []

  for (const [pidKey, s] of pidStates.entries()) {
    if (s.accountHint !== accountHint) continue
    pids.push(pidKey)
    if (s.util5h != null && (util5h == null || s.util5h > util5h)) util5h = s.util5h
    if (s.util7d != null && (util7d == null || s.util7d > util7d)) util7d = s.util7d
    if (s.resetAt != null && (resetAt == null || s.resetAt > resetAt)) resetAt = s.resetAt
    if (s.resetAt7d != null && (resetAt7d == null || s.resetAt7d > resetAt7d)) resetAt7d = s.resetAt7d
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

  // Ровно тот же перенос для недельного окна: заголовок приходит не на каждом ответе, а окно от
  // этого не перестаёт идти. Своя карта — потому что истекают эти две отметки в разное время.
  if (resetAt7d != null) {
    expectedReset7dAt.set(accountHint, { resetAt: resetAt7d, observedAt: Date.now() })
  } else {
    const exp7 = expectedReset7dAt.get(accountHint)
    if (exp7) {
      if (exp7.resetAt > Date.now()) resetAt7d = exp7.resetAt
      else expectedReset7dAt.delete(accountHint)
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

  const known = lookupAccountIdentity(accountHint)

  accountStates.set(accountHint, {
    accountHint,
    // 🔴 ЧЕЛОВЕЧЕСКОЕ ИМЯ АККАУНТА, А НЕ ОДИН ЛИШЬ ЕГО НОМЕР.
    //
    // Случай 03.09.2026: фаундер увидел в подвале письма агента голый
    // `02b4bfd1` и спросил, почему не указан адрес почты. Владелец
    // telegram-surface показывает почту, как только она приезжает, — она просто
    // не приезжала: он читал её из конфигурации входа Claude Code, а та
    // описывает ОДИН аккаунт, под которым машина залогинена сейчас. Для
    // остальных трёх честно печаталось «неизвестно», и это читалось как
    // поломка.
    //
    // Между тем почта КАЖДОГО аккаунта у нас уже есть: она захватывается при
    // входе и лежит в хранилище (org-vault.json, поля accountEmail/orgName).
    // Здесь мы её просто переносим в файл квоты, чтобы всякий потребитель
    // называл аккаунт так, как его называет человек. Токены из хранилища НЕ
    // читаются и никуда не попадают.
    // 🔴 ДВА НАПИСАНИЯ, И ЭТО НЕ НЕБРЕЖНОСТЬ, А ПОПРАВКА К СОБСТВЕННОЙ ОШИБКЕ.
    // Я написал соседу «поле называется ровно так, как ваш код уже читает» — и
    // это было НЕВЕРНО, он проверил прежде чем поверить. И его сторона, и
    // среднее звено (присутствие в SynqTask) читают `email` / `account_email`;
    // я же положил третье написание `accountEmail`, то есть имя доехало бы до
    // файла и НИКУДА дальше, а на месте осталось бы старое объяснение «машина
    // залогинена под другим аккаунтом» — уже неверное, но приходящее ВМЕСТО
    // поля, а не вместе с ним. Пишем оба: тогда цепочка сходится без правок у
    // двух чужих владельцев.
    ...(known.email ? { accountEmail: known.email, account_email: known.email } : {}),
    ...(known.orgName ? { orgName: known.orgName } : {}),
    util5h,
    util7d,
    resetAt,
    ...(resetAtSource ? { resetAtSource } : {}),
    // Наружу — ISO по обоим окнам. Единицы кончаются здесь: дальше по цепи никто уже не должен
    // гадать, секунды это или миллисекунды (однажды угадали и напечатали «год 58598»).
    reset5hAt: isoFromMs(resetAt),
    reset7dAt: isoFromMs(resetAt7d),
    level,
    message,
    issuedAt,
    pids: pids.sort(),
  })
}

function levelRank(l: 'ok' | 'warning' | 'critical'): number {
  return l === 'critical' ? 2 : l === 'warning' ? 1 : 0
}

/** Отметка времени наружу: миллисекунды → ISO. `null` остаётся `null` — «не знаем» должно
 *  выглядеть как «не знаем», а не как эпоха. Заведомо невозможная величина тоже даёт `null`:
 *  секунды, принятые за миллисекунды, дают 1970-й, а обратная ошибка — пятьдесят восьмой век,
 *  и обе лучше показать пустотой, чем правдоподобной ложью. */
function isoFromMs(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  // 2001-09-09 (1e12 мс) .. 2286-11-20 (1e13 мс) — окно, в которое попадает любая настоящая
  // отметка в миллисекундах и не попадает ни одна в секундах.
  if (ms < 1e12 || ms > 1e13) return null
  try { return new Date(ms).toISOString() } catch { return null }
}

function pct(v: number | null): string {
  if (v == null) return '?'
  return `${(v * 100).toFixed(0)}%`
}

/**
 * Self-heal the SSOT when a 5h window reset passes with ZERO traffic.
 *
 * The snapshot is otherwise rewritten only when new stats lines arrive (live
 * traffic), so after a reset on an idle host the file kept advertising the
 * PRE-reset utilization — consumers (signal-wire quota hints) alarmed
 * "util5h=0.96 critical" minutes after the window had already rolled
 * (founder gap 2026-06-12: reset 15:50Z, hint still showed 0.96 at 15:53Z
 * while the live HEALTH_HEARTBEAT already reported 0.01).
 *
 * Once `now >= resetAt` for an account (pid-observed, account-aggregate, or
 * carried expectation), the recorded util5h belongs to the PREVIOUS window:
 * zero it (a fresh window starts at 0 until new usage), recompute levels, and
 * force a write so the file heals within one poll tick. util7d is untouched —
 * the 7-day window does not reset at the 5h boundary. Runs every poll tick;
 * no-ops until a reset actually passes.
 */
function applyResetPassed(): void {
  const now = Date.now()
  const touched = new Set<string>()
  for (const p of pidStates.values()) {
    if (p.resetAt != null && now >= p.resetAt) touched.add(p.accountHint)
  }
  for (const [hint, acc] of accountStates.entries()) {
    if (acc.resetAt != null && now >= acc.resetAt) touched.add(hint)
  }
  for (const [hint, exp] of expectedResetAt.entries()) {
    if (exp.resetAt <= now) {
      expectedResetAt.delete(hint)
      touched.add(hint)
    }
  }
  for (const [hint, exp7] of expectedReset7dAt.entries()) {
    if (exp7.resetAt <= now) {
      expectedReset7dAt.delete(hint)
      touched.add(hint)
    }
  }
  if (touched.size === 0) return
  for (const hint of touched) {
    for (const p of pidStates.values()) {
      if (p.accountHint !== hint) continue
      // A pid pinned to a FUTURE window (fresh observation racing this sweep)
      // is not part of the reset that just passed — leave it alone.
      if (p.resetAt != null && p.resetAt > now) continue
      p.util5h = 0
      p.resetAt = null
      p.level = classifyLevel(0, p.util7d)
    }
    recomputeAccountFromPids(hint)
  }
  emit({
    level: 'info',
    kind: 'QUOTA_RESET_PASSED',
    msg: `5h reset passed for ${touched.size} account(s) — util5h zeroed pending fresh traffic`,
    accounts: Array.from(touched),
  })
  writeQuotaStatus()
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
    sessions: Object.fromEntries(sessionStates),
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
  for (const [pidKey, s] of pidStates.entries()) {
    if (s.lastSeenAt < cutoff) {
      affectedAccounts.add(s.accountHint)
      // Reap when the real process is gone, OR when this is a per-org virtual
      // client (composite `${pid}::${org}` key): the proxy pid is shared across
      // orgs, so there is no distinct OS process to kill-0 probe — staleness is
      // its only liveness signal, and leaving it would pin a long-idle org's
      // account forever (the proxy pid never dies). Bare-pid (legacy) entries
      // still reap by the process check so a live proxy keeps its account warm
      // between bursts.
      if (pidKey.includes('::') || !isPidAlive(s.pid)) {
        pidStates.delete(pidKey)
        continue
      }
      // Pid alive but silent — keep state but mark stale by zeroing util
      // (or just leave as-is; lastSeenAt suffices for consumers)
    }
  }
  for (const h of affectedAccounts) recomputeAccountFromPids(h)
  // Sessions are plain ids (no liveness probe possible) — prune by age only,
  // on their OWN much longer clock: an account binding stays true while the
  // session sleeps, and forgetting it blinds the wake-router to the very
  // agents it is supposed to protect. See SESSION_STATE_PRUNE_AFTER_MS.
  const sessionCutoff = now - SESSION_STATE_PRUNE_AFTER_MS
  for (const [ses, s] of sessionStates.entries()) {
    if (s.lastSeenAt < sessionCutoff) sessionStates.delete(ses)
  }
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

// ─── Test surface (additive; not used in production) ─────────────────
//
// Lets unit tests drive the PURE processor logic (ingest → aggregate →
// snapshot) without spinning the file-tailing daemon. Mirrors the
// `invalidateTokenCache` test-export pattern in upstream.ts.
export const __testing = {
  ingestStatsLine,
  pruneStaleStates,
  seedFromPreviousSnapshot,
  snapshot: (): QuotaStatusFile => ({
    version: 1,
    updatedAt: new Date().toISOString(),
    accounts: Object.fromEntries(accountStates),
    pids: Object.fromEntries(pidStates),
    sessions: Object.fromEntries(sessionStates),
  }),
  reset: (): void => {
    pidStates.clear()
    accountStates.clear()
    sessionStates.clear()
    expectedResetAt.clear()
    expectedReset7dAt.clear()
  },
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
