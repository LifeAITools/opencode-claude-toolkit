/**
 * token-rotation.ts — TokenRotationManager: deferred-apply state machine for
 * OAuth token rotations detected on the credential store.
 *
 * Owns the per-pid in-memory state machine that decides whether a freshly
 * detected token rotation should:
 *   - apply immediately (same-org / context below threshold / forced),
 *   - defer to a turn boundary (new-org and context ≥ threshold), or
 *   - apply on context-drop (deferred + context fell below threshold).
 *
 * The class is the *single* home for rotation logic per CR-10 — `src/sdk.ts`
 * delegates to it via a thin wrapper (≤30 LoC, see T9/T10) and never touches
 * the underlying state machine directly.
 *
 * Detection sources (T5 fills bodies):
 *   - `fs.watch(credentialStorePath)` push notifications (primary), and
 *   - `setInterval(statSync, pollIntervalMs)` poll fallback (covers fs.watch
 *      gaps on networked / virtualized filesystems).
 *
 * Cross-pid notification flows through an optional event-emitter callback
 * (`setEventEmitter`) registered by `opencode-signal-wire` in T13. When unset,
 * the audit log (JSONL) is the only sink.
 *
 * References (PRP token-rotation-deferred-apply):
 *   - REQ-09  Detect rotations via fs.watch + poll fallback
 *   - REQ-10  Decide apply-now vs defer based on context tokens + org-id diff
 *   - REQ-11  Emit `TokenRotatedPayload` (12-field schema) on every transition
 *   - CR-10   New rotation logic ONLY in this module — sdk.ts is delegate-only
 *   - CN-06   No new npm deps — built-in `fs`, `os`, `path`, `crypto` only
 *   - CN-09   sdk.ts ≤30 LoC delta for rotation wiring (enforced by T9/T10)
 *   - CN-10   `fs.watch` only when credential store exposes a `path` field
 *             (FileCredentialStore); MemoryCredentialStore skips the watcher
 *   - DB-05   `pendingRotation` is per-pid in-memory only — never persisted,
 *             never shared cross-pid; cross-pid coordination is via the
 *             `token.rotated` signal-wire event (REQ-11).
 *
 * Task T4 status: SKELETON ONLY. Public + private surface declared; method
 *                 bodies are stubs filled by:
 *                 - T5 (startWatcher / startPollFallback)
 *                 - T6 (detectRotation)
 *                 - T7 (checkPending / applyPending)
 *                 - T8 (close + audit-log helpers)
 */
import type { CredentialStore, StoredCredentials } from './types.js';
import type { ResolvedKeepaliveConfig } from './keepalive-config.js';
/**
 * Structural mirror of `@kiberos/signal-wire-core`'s `TokenRotatedPayload`
 * (REQ-11, 12 fields). Defined locally because:
 *   1. CN-06 forbids adding `@kiberos/signal-wire-core` as a dep of the
 *      core SDK (it currently lives only in `packages/opencode-signal-wire`).
 *   2. TS structural typing makes this interface assignable to/from the
 *      canonical type — the T13 bridge in opencode-signal-wire imports the
 *      canonical `TokenRotatedPayload` from sw-core and passes payloads
 *      through to `setEventEmitter()` without explicit casts.
 *
 * If you change a field here, mirror the change in
 * `/home/relishev/packages/signal-wire-core/src/domain/event.ts`.
 */
export interface TokenRotatedPayload {
    pid: number;
    spawnDepth: number;
    sessionId: string | null;
    oldHint: string;
    newHint: string;
    oldOrgId: string | null;
    newOrgId: string | null;
    contextTokens: number | null;
    mode: 'applied' | 'deferred' | 'forced' | 'same-org';
    appliedAt: 'immediate' | 'turn-boundary' | 'context-drop' | 'forced-expired' | null;
    forcedReason: 'old-token-expired' | 'old-refresh-failed' | 'old-api-rejected' | null;
    detectedAt: string;
}
/**
 * Per-pid in-memory record of a deferred rotation (DB-05). Created when
 * `detectRotation()` observes a new-org token while context is at/above
 * `tokenRotationContextThreshold`. Cleared by `applyPending()`.
 */
export interface PendingRotation {
    oldHint: string;
    newHint: string;
    oldOrgId: string | null;
    newOrgId: string | null;
    /** epoch ms — observability only; NOT a decision input (CN-07). */
    detectedAt: number;
}
/**
 * Result of `checkPending()` — tells `sdk.ensureAuth` what to do this turn.
 */
export type CheckPendingResult = {
    action: 'apply-now';
    credentials: StoredCredentials;
    mode: 'applied' | 'forced' | 'same-org';
    forcedReason?: 'old-token-expired' | 'old-refresh-failed' | 'old-api-rejected';
} | {
    action: 'continue-with-old';
    pending: PendingRotation;
} | {
    action: 'no-pending';
};
/**
 * State machine + side-effect runner for OAuth token rotations.
 *
 * Lifecycle: constructed once per SDK instance (per pid), `close()`d on
 * shutdown. Watchers/timers start in the constructor; bodies are filled
 * by T5–T8.
 */
export declare class TokenRotationManager {
    private credentialStore;
    private contextTokensProvider;
    private getConfig;
    private pendingRotation;
    private orgIdCache;
    private watcher;
    private pollTimer;
    private closed;
    private eventEmitter;
    /** Updated by `detectRotation`; baseline for diffing the next observation. */
    private lastSeenHint;
    /**
     * Throttle flag for `contextTokensProvider` failures (CR-09): we log the
     * first throw, then suppress subsequent identical errors to avoid log
     * spam if the provider is persistently broken.
     */
    private contextProviderThrew;
    /**
     * Counter throttling `maybeRotateLog()` invocations (DB-08, T8). We
     * stat() the rotation log on the FIRST append (catches startup case
     * where prior session left an oversized log) and on every 100th append
     * thereafter. NFR-01: avoids a syscall per rotation event in steady
     * state — appends are rare anyway, so this is mostly belt-and-braces.
     */
    private appendCallCount;
    constructor(credentialStore: CredentialStore, contextTokensProvider: (() => number | null) | undefined, getConfig: () => Pick<ResolvedKeepaliveConfig, 'tokenRotationContextThreshold' | 'tokenRotationPollIntervalMs' | 'orgIdCacheTtlMs' | 'tokenRotationLogMaxBytes' | 'tokenRotationLogRetentionDays'>);
    /**
     * Called by `sdk.ensureAuth` before the Defect 1 mtime-check (T10).
     *
     * Three-step decision:
     *   1. Layer-3 detection (DB-01): trigger `detectRotation('ensureAuth')`
     *      so any rotation that fs.watch + poll missed gets observed before
     *      we read state. detectRotation owns its own state mutations + emit
     *      — we just trigger it.
     *   2. No pending → caller proceeds normally.
     *   3. Pending exists → re-evaluate threshold gate (CR-03 / REQ-07).
     *      Context may have dropped since the deferral was set; if so, we
     *      auto-resolve via `applyPending('context-drop')`. Else we tell
     *      the caller to continue with the OLD token until a safe boundary.
     *
     * Note: the `forced-expired` path is NOT taken here. The caller
     * (`sdk.ensureAuth`) detects expiry/refresh-failure and explicitly
     * invokes `applyPending('forced-expired', ...)`.
     */
    checkPending(): Promise<CheckPendingResult>;
    /**
     * Apply a deferred rotation. Called by:
     *   - opencode-signal-wire `chat.message` hook at turn boundary
     *     (T13, reason='turn-boundary'),
     *   - `checkPending()` itself when context drops (reason='context-drop'),
     *   - `sdk.ensureAuth` on forced-expiry (T10, reason='forced-expired'
     *      with one of the 3 `forcedReason` values).
     *
     * Idempotent: no-op when there's no pending rotation. NOT an error —
     * callers may speculatively invoke without knowing pending state
     * (e.g. T13 turn-boundary hook fires every turn).
     *
     * Runtime invariant: `forcedReason` is REQUIRED when
     * `reason === 'forced-expired'`. We throw rather than silently dropping
     * the field — calls without it are programmer errors.
     *
     * Side-effects on success:
     *   - lastSeenHint advances to the new token (no longer "deferred").
     *   - pendingRotation cleared (DB-05: ephemeral per-pid state gone).
     *   - orgIdCache cleared so the next detectRotation re-reads the
     *     post-rotation identity fresh.
     *   - One audit-log line + one emitter callback fire via emitEvent.
     */
    applyPending(reason: 'turn-boundary' | 'context-drop' | 'forced-expired', forcedReason?: 'old-token-expired' | 'old-refresh-failed' | 'old-api-rejected'): Promise<void>;
    /** Read-only: is there a deferred rotation waiting? */
    hasPending(): boolean;
    /**
     * Register a cross-pid event emitter (called by opencode-signal-wire
     * bridge in T13). When set, every detect/apply emits via this callback
     * in addition to the in-process audit log; when unset, only the audit
     * log is written.
     *
     * Mode `'same-org'` events are always passed through here — the bridge
     * is responsible for any UX-level filtering (CR-02: bridge drops the
     * same-org banner emit).
     */
    setEventEmitter(emit: (payload: TokenRotatedPayload) => void): void;
    /**
     * Stop the watcher + poll timer; idempotent. T8 fills body (rotation/retention).
     *
     * Minimal interim implementation so T6 smoke tests can construct, exercise,
     * and tear down managers without leaking timers/fds. The audit-log rotation
     * + retention work lands in T8 — this body grows then.
     */
    close(): void;
    /**
     * Layer-1 detection (REQ-01, DB-01): `fs.watch` push notifications on the
     * credential store file. Only attaches when the store exposes a `.path`
     * field (CN-10) — `MemoryCredentialStore` and other in-memory stores
     * lack one and silently skip the watcher (poll fallback also no-ops for
     * them, but instantiation must not throw — verified in T5 smoke #2).
     *
     * `persistent: false` so the fd never keeps the event loop alive on its
     * own (NFR-01: zero CPU when idle, ≤1 fd per pid). All fs operations
     * here are wrapped in try/catch — init failures degrade gracefully to
     * the poll fallback (NFR-05).
     */
    private startWatcher;
    /**
     * Layer-2 detection (REQ-02, DB-01): periodic poll covering filesystems
     * where `fs.watch` is unreliable (network mounts, some virtualized FS,
     * editors that swap-write atomically). Interval comes from
     * `tokenRotationPollIntervalMs` (default 30 s).
     *
     * `.unref()` so the timer alone never keeps the process alive
     * (NFR-01). Errors inside `detectRotation` are logged there; the
     * `.catch(() => {})` here is a belt-and-braces guard so an unhandled
     * rejection can't escape the timer callback (NFR-05).
     */
    private startPollFallback;
    /**
     * Core diff/decide step. Triggered by:
     *   - fs.watch callback (`source='fs.watch'`),
     *   - setInterval poll fallback (`source='poll'`),
     *   - `sdk.ensureAuth` pre-check (`source='ensureAuth'`).
     *
     * Algorithm (8 steps, plan §T6):
     *   1. closed → return.
     *   2. read fresh creds; null → return.
     *   3. compute freshHint.
     *   4. freshHint === lastSeenHint → no real change; return.
     *   5. lastSeenHint === '' → bootstrap (initialize, no event).
     *   6. pending exists & freshHint === pending.newHint → already pending; return.
     *   7. pending exists & freshHint === pending.oldHint → user reverted; clear.
     *   8. NEW rotation: extract orgIds, snapshot context, decide same-org /
     *      cross-org-applied / cross-org-deferred; emit + audit-log.
     *
     * Errors are logged via `logBestEffort` — never thrown (caller's
     * `.catch(() => {})` swallows; we own observability internally per T5
     * gotcha note).
     */
    private detectRotation;
    /**
     * Decode the `organization_id` claim out of an OAuth refresh-token JWT.
     *
     * The Anthropic refresh token is a standard 3-part JWT
     * (`header.payload.signature`). We don't verify the signature — we
     * trust the credential file's integrity (it lives at 0o600 in
     * `~/.claude/.credentials.json`); we only need the org-id claim.
     *
     * Uses Node's built-in `Buffer.from(..., 'base64url')` — no new dep
     * (CN-06). All failure modes (malformed token, non-JSON payload,
     * missing claim) collapse to `null`, which downstream code treats
     * as "unknown org" (cross-org for safety, per DB-04).
     */
    private extractOrgId;
    /**
     * Get the current org-id with a TTL cache (REQ-14, DB-10, default 5min).
     *
     * Cache hit is sync-fast (just a clock comparison). Cache miss does
     * one `credentialStore.read()` (the JWT decode itself is local CPU
     * work — no I/O). The cache exists to amortize the `read()` across
     * many `detectRotation('ensureAuth')` calls per turn (CN-08).
     *
     * Note: `detectRotation` ALWAYS extracts `newOrgId` fresh (via
     * `extractOrgId()` directly on the just-read creds) — the cache only
     * answers "what was the org before this rotation?".
     */
    private getCachedOrgId;
    /**
     * Append a single rotation record to `~/.claude/token-rotation.log`
     * as one JSONL line (REQ-12, DB-08). Best-effort — never throws
     * (NFR-05).
     *
     * T8: size-based rotation + retention added. We call
     * `maybeRotateLog()` on the first append (catches startup case where
     * a prior session left an oversized log) and every 100th append
     * thereafter (steady-state throttle — a stat() per append would be
     * wasteful, and rotations are rare anyway).
     */
    private appendRotationLog;
    /**
     * Size-based audit-log rotation with retention (DB-08, T8).
     *
     * 2-level rotation scheme:
     *   token-rotation.log     — current (active append target)
     *   token-rotation.log.1   — most recently rotated
     *   token-rotation.log.2   — second-oldest; deleted on next rotate if
     *                            its mtime is older than retention window.
     *
     * Triggered when `token-rotation.log` exceeds
     * `tokenRotationLogMaxBytes` (default 10 MiB). Retention check fires
     * only against `.log.2` because `.log.1` was just produced by the
     * previous rotation and is by definition the freshest archive.
     *
     * Failure modes (NFR-05): every fs op is wrapped — a missing file, a
     * permission error, or a rename clash never throws to the caller.
     * Worst case the log just keeps growing; we'd rather lose retention
     * than drop a rotation event.
     *
     * CN-07 carve-out: `Date.now()` is used here only for mtime-age
     * comparison (operational housekeeping). It is NOT a token-decision
     * gate.
     */
    private maybeRotateLog;
    /**
     * Route a rotation event to its two destinations:
     *   1. Optional cross-pid emitter (signal-wire bridge, T13). Same-org
     *      events ARE passed through here — bridge owns CR-02 filtering.
     *   2. The in-process audit log (always, for every mode — CR-06).
     *
     * Emitter callback errors are caught so a buggy bridge can't break
     * the state machine.
     */
    private emitEvent;
    /**
     * Best-effort append to `~/.claude/claude-max-debug.log`. Mirrors the
     * `TOKEN_FILE_CHANGED` marker pattern in `sdk.ts:940-944`. Never throws
     * — log directory may not exist, disk may be full, etc. (NFR-05).
     *
     * Caller is responsible for the leading `[<ISO>]` timestamp + trailing
     * details; this helper only owns the trailing `\n` and the swallow.
     */
    private logBestEffort;
}
//# sourceMappingURL=token-rotation.d.ts.map