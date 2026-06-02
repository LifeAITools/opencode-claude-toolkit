# Design — Per-session org/token pinning in claude-max-proxy

**Date:** 2026-06-02
**Status:** draft (design) — awaiting user approval before plan
**Scope:** `src/proxy-client.ts`, `src/org-identity.ts`, `src/keepalive-engine.ts`
(claude-max SDK core); `packages/claude-max-proxy/src/server.ts` +
`quota-watcher.ts` + `modules/admin.ts` (daemon wiring).
**Supersedes the "out of scope" clause of** `2026-05-28-org-switch-keepalive-old-cache-design.md`
(which retained only the old token for KA warming; this design makes org/token a
true per-session property for REAL traffic).

## Problem (two layers, one root)

`claude-max-proxy` resolves "current account" through **two independent clocks**:

1. **Token** — `FileCredentialsProvider` (proxy-adapters.ts), invalidated
   *instantly* by the daemon's `fs.watch` on `~/.claude/.credentials.json`
   (`packages/claude-max-proxy/src/server.ts:257`, `quota-watcher.ts:296`) →
   `TOKEN_FILE_CHANGED` → `credentials.invalidate()`.
2. **Org identity** — `FileOrgIdResolver` (org-identity.ts), a **5-min TTL cache**
   over `~/.claude.json:oauthAccount.organizationUuid`, invalidated **only by
   timeout**. Nothing — not the fs.watch, not `reloadSessions()` — ever calls it.
   It has no `invalidate()` method.

**2026-06-02 incident (proven from logs):** after `claude login` (15:45 UTC
`TOKEN_FILE_CHANGED`) + `cli_reload` (15:55), real traffic switched to the new
org's token *immediately*, but the rewrite-guard still read the **stale** org-id
for up to 5 min → `orgChanged=false` → requests passed **silently onto the new
org**, and prefix-history recorded the *wrong* (stale) orgId. When the TTL caught
up (15:58+), the same lineages flipped to `orgChanged=true` → a cascade of
delayed `CACHE_REWRITE_BLOCKED (anomalous:org-switch)` 400s ("почти все сессии
свалились на него").

This is a **design gap**, not a bug to patch: the proxy never modelled org/token
as a per-session property. The user's desired model (U130): *old sessions keep
working on their old org/token until an explicit reload/marker; new sessions pick
up the new org by default; warn on large-context cross-org rewrite.*

## What already works (reuse, do not rebuild)

- **Org detection is org-based, not token-based** — a same-org ~8h refresh leaves
  `organizationUuid` untouched, so it never false-trips (org-identity.ts:29-35).
- **Per-session block with marker** — `orgChanged` → `anomalous:org-switch` → 400
  with `[%cache-rewrite-ok%]`, keyed `${sessionId}:${lineageKey}`
  (proxy-client.ts:715-794).
- **Snapshot already carries the old token** — `notifyRealRequestStart` stores
  `upstreamHeaders` incl. `Authorization` in the KA snapshot
  (keepalive-engine.ts); `orgSwitchPending` makes KA replay that old token to
  keep the old org's cache warm (2026-05-28 design, already shipped).
- **prefixHistory already stores per-lineage `orgId`** (proxy-client.ts:1465) and
  is reaped per session.
- **`reloadSessions(reason, sessionId?)`** already supports global + per-session
  (proxy-client.ts:560); daemon exposes it via `admin.ts:122` + `bin/claude-max`.

## Decisions (locked with the user, 2026-06-02)

**Core principle (user's words):** *"if I log into a different org, this will not
silently rewrite to new — old sessions keep posting to the old organization and
token."* A cross-org login is **non-blocking and non-migrating**: each session
**holds** its previous org+token and keeps working without interruption, until an
**explicit** switch or a genuine force condition.

- **Same-org token refresh** (safe rotation, `organizationUuid` unchanged) →
  **auto-adopt** the fresh token seamlessly. The snapshot is never used. This is
  the only automatic adoption.

- **Cross-org login** (a change that would invalidate the whole cached prefix) →
  each session **HOLDS** its pinned old org+token and **keeps serving real
  traffic on it** — NO 400, NO stop, NO silent migration. (This replaces the old
  `anomalous:org-switch` BLOCK: there is nothing to guard against, because we are
  not touching the new org at all.)

- **Explicit switch to the new org (rebind)** — only via one of:
  1. **`[%reload-ok%]` marker** in the message → rebind THIS session to the
     current org+token (then a full cache rewrite onto the new org is expected and
     allowed — the marker IS the consent; warn ~150k once).
  2. **cli `reload`** (centralized) → rebind ALL sessions to the file's current org.
  3. **cli `reload <sessionId>`** → rebind ONE session.

- **Force conditions** (the only events that end a hold without an explicit
  switch):
  - *pinned old token truly expired* (`now >= pin.expiresAt`, cross-org) →
    **401-stop** with a clear message ("`/reload` or re-send with `[%reload-ok%]`
    to continue on the current org; ~150k rewrite"). Never silently bills the new
    org.
  - *significant NON-org rewrite detected* (cold-start / system / tools changed
    above threshold, same org) → the **existing** rewrite-guard 400 with
    `[%cache-rewrite-ok%]` is unchanged. (Org holds and non-org rewrites are
    orthogonal.)

- **Two distinct markers** (do not conflate):
  - **`[%reload-ok%]`** (NEW, config `reloadMarker`) → switch org/token (rebind).
  - **`[%cache-rewrite-ok%]`** (existing, config `overrideMarker`) → consent to an
    expensive NON-org cache rewrite. Unchanged.

- **Reload scope:** BOTH — global (`reload`) + per-session (`reload <sessionId>`),
  reusing the existing `reloadSessions(reason, sessionId?)` signature.

- **Pin storage:** in-memory only. Proxy restart ⇒ every session rebinds to the
  current org (matches the user's "перезапуск подхватывает текущий"). No persistence.

## Architecture — two layers

### Layer 1 — Atomic account snapshot (kills the 2026-06-02 root cause)

Synchronise the two clocks: when the credentials file changes, org-id must be
re-read in lock-step, not on an independent TTL.

- **`OrgIdResolver` gains `invalidate(): void`**; `FileOrgIdResolver.invalidate()`
  clears its TTL cache (next `current()` re-reads `~/.claude.json`).
- **`ProxyClient.notifyCredentialsChanged()`** (new public method): calls
  `credentials.invalidate()` + `orgIdResolver.invalidate()` atomically, emits an
  event. The daemon calls it from the SAME fs.watch handler that already emits
  `TOKEN_FILE_CHANGED` (server.ts:257 / quota-watcher.ts), instead of only
  invalidating credentials. TTL stays as a fallback for missed fs events.

Effect: the 5-min silent window closes. Even without Layer 2, the proxy can no
longer pass real traffic onto a new org while believing it is the old one.

### Layer 2 — Per-session pin (the U130 model), orchestrated in ProxyClient

Org/token become a per-session property for REAL traffic, not just KA warming.

- **`sessionPins: Map<sessionId, { orgId: string|null; token: string; expiresAt: number }>`**
  in ProxyClient (sibling of `prefixHistory`/`lineagePrefix`; reaped in the same
  reaper loop by `sid` prefix). NOT added to the `Session` port (keeps the stable
  public port untouched).
- **Forward token selection** (replaces the bare `getAccessToken()` at
  proxy-client.ts:662). Pseudocode:
  ```
  account = { orgId: orgIdResolver.current(), token: await credentials.getAccessToken(), expiresAt }
  reloadAsked = inspectLastUserMessage(body, reloadMarker).hasMarker   // [%reload-ok%]
  pin = sessionPins.get(sessionId)

  if (!pin || reloadAsked) {                                          // new session OR explicit switch
    sessionPins.set(sessionId, account); use account.token            //   → (re)bind to current org+token
  } else if (pin.orgId === null || account.orgId === null
             || pin.orgId === account.orgId) {                        // same org (incl. safe refresh)
    pin.token = account.token; pin.expiresAt = account.expiresAt      //   → adopt fresh token, stay pinned to same org
    use account.token
  } else if (now < pin.expiresAt) {                                   // cross-org, old token still alive
    use pin.token                                                     //   → HOLD: keep posting to OLD org+token
  } else {                                                            // cross-org, old token truly expired (force)
    return 401-stop("/reload or [%reload-ok%]; ~150k rewrite")        //   → never silently migrate
  }
  ```
- **Cross-org no longer BLOCKS.** The previous `anomalous:org-switch` 400 path is
  removed for real traffic: a held session is posting to the OLD org, so there is
  no new-org quota to protect. The guard's 400 remains ONLY for non-org expensive
  rewrites (`expected:false` and NOT org-driven) gated by `[%cache-rewrite-ok%]`.
- **Rebind = overwrite the pin with the current account.** Triggers:
  1. new session (first request auto-pins current),
  2. **`[%reload-ok%]`** marker in the message (per-session explicit switch),
  3. `reloadSessions(reason, sessionId?)` (cli global or per-session).
- **KA uses the same pin.** While `pin.orgId !== account.orgId`, both real traffic
  AND the KA fire use `pin.token` (KA already does this via `orgSwitchPending`;
  now the flag is derived from the pin, and real traffic joins it instead of being
  blocked). On rebind the pin flips to the new account and KA resumes fresh-token
  warming on the new org.
- **Large-context warning** on rebind reuses the existing rewrite-class machinery
  (one cold rewrite onto the new org is expected after a `[%reload-ok%]` / cli reload).

`expiresAt` comes from the credentials file (`StoredCredentials.expiresAt` already
parsed by FileCredentialsProvider). Layer 2 requires reading it; if absent, treat
as "alive" and let the upstream 401 path (already handled) be the stop condition.

## Data flow (per session, on cross-org login)

```
claude login (new org) → credentials.json + claude.json change
  → daemon fs.watch → proxyClient.notifyCredentialsChanged()   [Layer 1: both caches invalidated atomically]
old session next real req:
  account.orgId = NEW, pin.orgId = OLD, old token still alive
  → forward uses pin.token (OLD) → old session KEEPS POSTING to OLD org, no block  [Layer 2 HOLD]
new session first req:
  no pin → auto-pins NEW account → runs on NEW org                            [Layer 2]
user choice (old session):
  • send [%reload-ok%]               → rebind pin to NEW → this req on NEW (warns ~150k)
  • cli reload [<sessionId>]         → rebind all / one session to NEW
  • do nothing                       → stays on OLD org+token (held)
  • old token expires while held     → cross-org forced event → 401-stop ("/reload or [%reload-ok%]")
non-org expensive rewrite (same org) → existing guard 400 with [%cache-rewrite-ok%]  (unchanged)
```

## Components / boundaries

- `org-identity.ts` — add `invalidate()` to `OrgIdResolver` + `FileOrgIdResolver`.
- `keepalive-config.ts` — add `reloadMarker` (default `"[%reload-ok%]"`), SSOT +
  hot-reload, alongside the existing `rewriteGuard.overrideMarker`.
- `proxy-client.ts` — `notifyCredentialsChanged()`; `sessionPins` map + reap;
  per-session token-selection (hold/adopt/rebind/401) at the forward path;
  rebind on `[%reload-ok%]` marker + inside `reloadSessions`; **remove the
  `anomalous:org-switch` 400 path for real traffic** (org no longer blocks; it
  holds). The guard's 400 stays for non-org expensive rewrites only.
- `keepalive-engine.ts` — token-replay mechanic unchanged (`orgSwitchPending`);
  the pending flag is now derived from / cleared with the pin (set when
  `pin.orgId !== account.orgId`, cleared on rebind).
- `packages/claude-max-proxy/src/server.ts` + `quota-watcher.ts` — call
  `proxyClient.notifyCredentialsChanged()` from the existing credentials fs.watch
  handler (in addition to emitting `TOKEN_FILE_CHANGED`).
- `packages/claude-max-proxy/src/modules/admin.ts` + `bin/claude-max` — unchanged
  routing; rebind happens inside `reloadSessions`.

## Error handling

- `~/.claude.json` transiently unreadable → `orgIdResolver.current()` returns
  `null` → pin/account comparison degrades to "same/unknown ⇒ use fresh token"
  (no false 401, no false window) — matches existing null-safe behaviour.
- Old token expired mid same-org → fresh token adopted (org==org branch); never a
  401-stop for a same-org refresh.
- Snapshot/pin missing token → fall back to fresh `getAccessToken()` (today's
  behaviour).
- Concurrency: pin keyed per `sessionId`; sub-agent fan-out shares the parent
  session's pin (same org) — correct, they are the same account.

## Testing (high-level — detailed TDD steps go in the plan)

1. **Layer 1:** `notifyCredentialsChanged()` invalidates BOTH credentials and
   org-id; a stale org-id is re-read on the next `current()` (no 5-min window).
2. **Same-org refresh:** pin.orgId == account.orgId → forward uses the FRESH
   token, never the snapshot (regression-pin the token≠org invariant).
3. **Cross-org HOLD (the headline behaviour):** after a cross-org login, the old
   session's forward uses pin.token (OLD org) and returns **200, NOT 400** — no
   `anomalous:org-switch` block. A NEW session auto-pins and uses the new token →
   two sessions, two orgs, concurrently.
4. **Cross-org, old token expired (force):** forward returns 401-stop with the
   `/reload` / `[%reload-ok%]` instructions; never silently bills the new org.
5. **Rebind via `[%reload-ok%]`:** a message carrying the reload marker overwrites
   the pin to the current account; that request + subsequent ones run on the new
   org (one expected cold rewrite).
6. **Rebind via cli reload:** `reloadSessions()` (global) and
   `reloadSessions(_, sid)` (one session) overwrite the pin(s) to the current
   account; next forward uses the new token.
7. **Non-org rewrite still guarded:** a same-org cold-start/system/tools rewrite
   above threshold still returns the existing 400 with `[%cache-rewrite-ok%]`
   (orthogonal to org holds).
8. Full suite + typecheck green; existing rewrite-guard / keepalive tests adjusted
   only where the org-switch-block path is intentionally replaced by hold.

## Out of scope / non-goals

- No on-disk profiles / `/profile` command (that is the separate, opencode-scoped
  `per-instance-credentials` PRP). This design is proxy-internal, single global
  credential file, pin held in memory.
- No persistence of pins across proxy restart (restart = rebind current, by design).
- No change to org **detection** (already correct, org-based).
- No auto-grant of the cross-org rewrite (the manual per-session decision is the
  desired UX).
- The opencode in-process path (`sdk.ts` `TokenRotationManager` deferred-apply) is
  a separate consumer and is untouched here.
