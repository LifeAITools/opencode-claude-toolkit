# Map: Token / Credentials Layer (from Explore agent, 2026-06-02)

> Captured for the per-session-org-pinning design. Source: token-rotation.ts, auth.ts,
> org-identity.ts, proxy-adapters.ts, proxy-client.ts.

## Decision-critical findings

1. **FileCredentialsProvider** (proxy-adapters.ts:51-107): in-memory `cached` StoredCredentials +
   `lastMtimeMs`. `getAccessToken()` re-reads disk when mtime changed or expired. `invalidate()`
   clears BOTH `cached` and `lastMtimeMs=0` (forces full re-read). Token comes straight from
   `~/.claude/.credentials.json`. NO auto-refresh here.
2. **fs.watch INDEPENDENCE (confirmed):** watcher (token-rotation.ts:384-410) watches ONLY
   `~/.claude/.credentials.json`; emits change → `detectRotation('fs.watch')`. Poll fallback every
   `tokenRotationPollIntervalMs` (default 30s). It does NOT touch org-identity. `FileOrgIdResolver`
   (org-identity.ts:91-117) reads `~/.claude.json` with its OWN 5-min TTL cache. → token and org-id
   detection are two decoupled clocks. THIS IS THE 2026-06-02 BUG ROOT.
3. **Deferred-apply IS in code — but only on the sdk.ts (in-process) path, NOT ProxyClient:**
   `TokenRotationManager` (token-rotation.ts) with `PendingRotation` SM (modes same-org /
   cross-org-applied / cross-org-deferred). `detectRotation()` decides; `checkPending()` re-evals on
   context-drop; `applyPending()` applies. Wired in sdk.ts (checkPending @1192, applyPending
   @1269). proxy-client.ts has ZERO references — forward always `this.credentials.getAccessToken()`
   (proxy-client.ts:662, 1014). So claude-max-proxy (native claude path) has NO deferred-apply.
4. **invalidate() callers (proxy-client.ts):** 533 (disarmSessions), 570 (reloadSessions),
   839 (upstream 401), 1165 (KA 401). NONE invalidate orgIdResolver.
5. **extractOrgId() JWT decode** (token-rotation.ts:614-625): returns null for real opaque
   `sk-ant-oat01-…` tokens (not JWTs). org-identity.ts (read ~/.claude.json) replaced it as the
   stable source. null = "unknown org" = safe fallback (no false block).
6. **Deferred-apply NOT wired (designed only):** signal-wire turn-boundary hook
   (applyPending('turn-boundary')), forced-expiry path in ensureAuth.

## Implication for the fix
The 2026-06-02 bug = two independent clocks (token via fs.watch instant; org-id via 5-min TTL,
never invalidated by reload). The mature per-session model already exists for sdk.ts (deferred
apply + pinning concept) but the proxy path was explicitly left on the global-token + warm-old-cache
model (docs/superpowers .../org-switch-keepalive design, "Out of scope: per-session distinct tokens").
