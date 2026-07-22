/**
 * config-dir-lock.ts — cross-process lock on the Claude config dir
 * (`~/.claude`), using the SAME primitive the native `claude` CLI uses so the
 * proxy's active-org `.credentials.json` co-write is mutually-exclusive with
 * the native CLI's own OAuth refresh.
 *
 * The native CLI locks the config dir via `proper-lockfile.lock(claudeDir)`
 * (`claude-code-source/src/utils/auth.ts:1491`), which creates `<dir>.lock`.
 * Locking the SAME path here is what gives true mutual exclusion — a
 * different lock object (e.g. `sdk.ts`'s `.token-refresh-lock` mkdir lock)
 * protects nothing against the native CLI (architect-review H1).
 *
 * ELOCKED-retry discipline mirrors the reference: up to MAX_RETRIES=5 attempts,
 * `sleep(1000 + rand*1000)` between them. Returns `null` when the lock could
 * not be acquired (a peer/native-CLI is mid-refresh) — the caller then re-reads
 * disk and proceeds fail-soft rather than double-refreshing.
 */
/**
 * Acquire the config-dir lock. Resolves to a release function, or `null` if
 * another process holds it after all retries (caller should fail-soft).
 * Never throws for ELOCKED; unexpected errors also resolve to `null` so a
 * lock subsystem fault degrades to "behave as if unlocked" rather than
 * breaking a request path.
 */
export declare function acquireConfigDirLock(configDir: string, maxRetries?: number): Promise<(() => Promise<void>) | null>;
//# sourceMappingURL=config-dir-lock.d.ts.map