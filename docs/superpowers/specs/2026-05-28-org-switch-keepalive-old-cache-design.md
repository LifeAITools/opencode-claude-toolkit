# Design — Org-switch keepalive: warm the OLD cache until the user decides

**Date:** 2026-05-28
**Status:** approved (design)
**Scope:** `src/proxy-client.ts`, `src/keepalive-engine.ts` (claude-max SDK; consumed by the claude-max-proxy daemon)

## Problem

When the user switches Anthropic **organization** (`claude /login` to a different org → `~/.claude.json:oauthAccount.organizationUuid` changes and the OAuth token is replaced), the previous org's prompt cache becomes unreachable: Anthropic scopes the cache to the **org**, and the new token bills/reads a different org. Each live session's first post-switch request is a full cache rewrite.

The proxy already detects this and blocks the rewrite per session with an override marker (good). But two gaps remain relative to the desired behavior:

1. **A blocked request still disturbs keepalive (KA).** The KA-mutating call `notifyRealRequestStart` runs *before* the rewrite-guard decides to block, so a request the user has NOT confirmed already aborts the in-flight warm, marks the lineage warmed, and clobbers the pending snapshot.
2. **KA cannot warm the OLD org's cache during the decision window.** Each KA fire overrides the request's `Authorization` with a freshly-fetched *current* token, so after a switch KA can only touch the *new* org. The user wants: for each session, KA keeps warming the **previous** cache (with the previous token) while the current request is rejected-with-marker, and the user decides per session — send the marker (rewrite onto the new org) or start a new session.

## What ALREADY works (do not rebuild)

- **Org detection is org-based, not token-based.** `FileOrgIdResolver` reads `oauthAccount.organizationUuid` from `~/.claude.json` (`src/org-identity.ts:59`), wired into `ProxyClient` (`src/proxy-client.ts:389`, used at `:1319`). A same-org token rotation/refresh leaves `organizationUuid` untouched, so it never trips a switch (`src/proxy-client.ts:1357-1362`). This is exactly the token≠org invariant: org-change ⟹ token-change, token-change ⇏ org-change.
- **Per-session block with marker.** `orgChanged` feeds `classifyRewrite` → `anomalous:org-switch` (not `expected`) → the rewrite-guard returns 400 with `[%cache-rewrite-ok%]` (`src/proxy-client.ts:715-778`), keyed per `${sessionId}:${lineageKey}`.
- **The snapshot already carries the old token.** `upstreamHeaders` gets `Authorization: Bearer <getAccessToken()>` (`src/proxy-client.ts:~641`) and is passed into `notifyRealRequestStart` → stored in `pendingSnapshots[key].headers` (`src/keepalive-engine.ts:675`). The token captured at warm-time is therefore present in the registry; the fire just discards it.

## Changes

### Change 1 — Rewrite-guard precedes KA mutation (ordering cleanup)

In `ProxyClient.handleRequest`, today the order is: `notifyRealRequestStart` (`:703`) → `predictCacheMiss` (`:706`) → guard block (`:715-778`). `notifyRealRequestStart` mutates KA state (`abortController.abort()` of the in-flight fire `keepalive-engine.ts:746`; `lineageStats…lastWarmedAt = now` `:650`; `pendingSnapshots.set` `:672`).

Reorder so a blocked request is a **no-op for KA**:

1. Compute `lineageKey(body)` directly (it is a pure function — `keepalive-engine.ts:635` — exported/reused, no priming needed).
2. Run `predictCacheMiss` + the rewrite-guard decision using that key.
3. **Only if the request is NOT blocked**, call `notifyRealRequestStart` and proceed.

Result: while a session sits in the org-switch decision window, its KA keeps firing the **already-registered** snapshot undisturbed (the blocked request neither aborts the warm nor re-points the snapshot).

Constraints:
- `predictCacheMiss` currently overwrites `prefixHistory`/`lineagePrefix` as a side effect (`:1322-1326`). When the request is going to be blocked, that history MUST NOT advance (otherwise the next, marker-carrying retry would compare against the blocked attempt and misclassify). Split prediction into a pure "assess" (no writes) and a "commit" (advance history) step; commit only on the non-blocked path.
- The automated-agent passthrough (`isAutomatedAgent`, `:741`) keeps its current behavior: it is not blocked, so it flows through `notifyRealRequestStart` normally.

### Change 2 — KA warms the OLD cache with the snapshot's own token, only inside the org-switch window

Per lineage (`${sessionId}:${lineageKey}`), track an **org-switch-pending** flag: set when `predictCacheMiss` observes `orgChanged === true` and the request was blocked (user not yet consented); cleared when the user proceeds (marker accepted → a real request completes and re-registers the snapshot under the new org/token), or when the old token expires, or on idle-timeout/owner-dead.

While a lineage is org-switch-pending, the KA fire for that lineage uses the **snapshot's own** `Authorization` header (the old token captured at last warm) instead of overriding it with `getToken()`:

- Today (`keepalive-engine.ts:1189-1195` and the second path `:1575-1579`):
  `const token = await this.getToken(); const headers = { ...best.headers, Authorization: 'Bearer ' + token }`.
- New: if the lineage is org-switch-pending AND the snapshot carries an `Authorization` header, fire with `headers = { ...best.headers }` (snapshot token preserved). Otherwise unchanged (fresh `getToken()`).

Token-expiry is the natural, bounded end of warming: a KA fire with an expired old token returns 401 → existing error classification (`keepalive-engine.ts:181` → `auth`) disarms that lineage. No new expiry bookkeeping needed; the existing 401 path is the stop condition. This keeps the warm best-effort within the old token's remaining life — which covers the human decision window.

When the user sends `[%cache-rewrite-ok%]`: the request is no longer blocked → Change-1 path runs `notifyRealRequestStart` with the NEW token → on completion the snapshot re-registers under the new org/token, the org-switch-pending flag clears, and KA resumes normal fresh-token warming on the new org.

When the user starts a NEW session: the old session receives no more real requests; KA keeps warming the old cache until the old token expires (401 → disarm) or `idleTimeoutMs`/owner-dead winds it down. The new session primes fresh on the new org normally.

## Data flow (per session, on org switch)

```
claude /login (new org)  →  ~/.claude.json.organizationUuid changes + token replaced
                          →  TOKEN_FILE_CHANGED (daemon fs.watch) invalidates token cache
session's next real req   →  assess (pure): orgChanged=true → anomalous:org-switch
                          →  guard: BLOCK (400 + marker)   [history NOT advanced]
                          →  mark lineage org-switch-pending
                          →  KA tick fires snapshot with OLD token → OLD org cache stays warm
user choice per session:
  • send marker           →  not blocked → notifyRealRequestStart(new token) → complete
                             → snapshot re-registers (new org), pending cleared, normal KA resumes
  • start new session      →  old lineage idle; warms until old token 401 / idle-timeout → disarm
  • (no action, token dies) →  KA fire 401 → auth-class disarm of that lineage
```

## Components / boundaries

- `ProxyClient.handleRequest` — reordered: pure assess+guard first, KA priming only on the proceed path.
- `predictCacheMiss` → split into `assessCacheMiss` (pure, returns the verdict + whether orgChanged) and `commitPrefixHistory` (advances `prefixHistory`/`lineagePrefix`). Block path calls assess only.
- `KeepaliveEngine` — new per-lineage `orgSwitchPending` set (or a field on the registered snapshot). Setter called from `ProxyClient` when a block with `orgChanged` happens; cleared on snapshot re-registration / disarm. The two KA fire sites consult it to choose the token source.
- `org-identity` / detection — unchanged (reused as-is).

## Error handling

- Old token expired during window → KA fire 401 → existing `auth` classification disarms that lineage (the stop condition). No crash, no false warming.
- `~/.claude.json` transiently unreadable → `orgIdResolver.current()` returns `null` → `orgChanged` stays false (existing behavior `:1362`), so no false window. Safe degrade.
- Snapshot lacks an `Authorization` header (shouldn't happen on the proxy path, but defensively) → fall back to fresh `getToken()` (current behavior).
- Concurrency: org-switch-pending keyed per `${sessionId}:${lineageKey}` — sub-agent fan-out cannot cross-set another lineage's flag.

## Testing

- **Ordering (Change 1):** a blocked org-switch request does NOT abort the in-flight KA, does NOT advance `prefixHistory`, does NOT update `lineageStats.lastWarmedAt`. A subsequent marker-carrying retry classifies correctly (not poisoned by the blocked attempt).
- **Old-token warming (Change 2):** with a lineage flagged org-switch-pending and a snapshot carrying token T_old, the KA fire's outgoing headers carry `Bearer T_old` (not the current `getToken()` value). When the flag is clear, the fire uses fresh `getToken()`.
- **Window end — marker:** after a non-blocked (marker) request completes, the flag clears and the next KA fire uses the fresh token.
- **Window end — token expiry:** a KA fire returning 401 disarms the lineage (no infinite stale-token loop).
- **Same-org token rotation does NOT open a window** (regression-pin the token≠org invariant): `organizationUuid` unchanged → `orgChanged=false` → no flag, KA keeps fresh-token warming.
- Full suite + typecheck green; no regression in existing rewrite-guard / keepalive tests.

## Out of scope / non-goals

- No per-session distinct *credential stores* or multi-org concurrent operation: there is one global credential file; this design only **retains and replays the already-captured old token** for warming during a bounded window, it does not manage multiple live tokens.
- No change to org **detection** (already correct and org-based).
- No auto-granting of the rewrite (explicitly rejected by the user — the per-session manual decision is the desired UX).
