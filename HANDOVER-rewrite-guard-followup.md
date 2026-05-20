# Handover — rewrite-guard follow-up: restart-persistence + org-awareness

**Repo:** `/home/relishev/projects/vibe/claude-code-sdk` (branch `main`, pushed).
**Status of base work:** agent-aware per-lineage KA + `reload()` + rewrite guard +
predictor — DONE, merged to `main`, deployed live on `:5050`. Guard ENABLED
(`~/.claude/keepalive.json` → `rewriteGuard.enabled:true`,
`overrideMarker:"[%cache-rewrite-ok%]"`). 472 tests green.

Two follow-up requirements below. Both are real, both verified-needed.

## REQ-1 — Persist `prefixHistory` across proxy restarts

**Root cause (verified live):** `ProxyClient.prefixHistory` (Map in
`src/proxy-client.ts`) is in-memory. On a daemon restart it is wiped → the
first request of every session looks like `isFirstRequest` to `predictCacheMiss`
→ classified `expected:cold-start` → guard never fires. So right after any
restart the guard is blind for one request per session — a session resumed into
a dead cache slips through unguarded.

**Fix:**
- Persist `prefixHistory` to disk: `~/.claude-local/proxy-prefix-history.json`,
  shape `{ "<sessionId>:<lineageKey>": { hashes:PrefixHashes, lastReqAt:number,
  orgId:string } }`.
- Load on `ProxyClient` construction; on load prune entries with
  `lastReqAt` older than ~1h.
- Save debounced (~2s) after `prefixHistory.set` in `predictCacheMiss`, and on
  `stop()`. Never block the request path; wrap in try/catch.
- File path config-driven (add to keepalive-config or a ProxyClient option),
  not hardcoded.

## REQ-2 — Org/token awareness — don't auto-burn quota after org switch

**Risk:** the cached prefix was written under OAuth token of org A. After
`claude login` to org B, replaying that prefix (KA fire OR a resumed real
request) cold-writes the FULL context against org B → burns org B quota
instantly, silently.

**Fix:**
- Extract the org-id from the current access token's JWT. The SDK already
  decodes org-id for token-rotation — REUSE that (see `token-rotation.ts` /
  `orgIdCacheTtlMs` in `keepalive-config.ts`). Do NOT re-implement JWT decode.
- Store `orgId` in each `prefixHistory` entry (the org under which that prefix
  was last cached).
- In `predictCacheMiss`: if the incoming request's current org-id differs from
  the stored entry's `orgId` → the cached prefix is cross-org → classify as a
  NON-expected rewrite. Add a rewrite class `anomalous:org-switch` to
  `classifyRewrite` (lineage.ts) — `expected:false` → guard blocks it (unless
  `[%cache-rewrite-ok%]` present). This stops the silent cross-org quota burn.
- Also verify: after a restart the proxy uses the CURRENT token — it already
  reads `~/.claude/.credentials.json` fresh on each request (credentials
  adapter + fsWatch in server.ts); confirm this still holds, no token cached
  across restart.

## Files to touch
- `src/proxy-client.ts` — prefixHistory persist (load/save/prune); org-id read
  per request; org compare in `predictCacheMiss`.
- `src/lineage.ts` — add `anomalous:org-switch` to `RewriteClass` +
  `classifyRewrite` (new ctx field e.g. `orgChanged`).
- `src/keepalive-config.ts` — config for the persist-file path (+ maybe a
  toggle). All values SSOT, hot-reloadable, no hardcode.
- `test/rewrite-guard.test.ts` — add: persistence survives a new ProxyClient
  instance; org-switch → blocked.

## Gotchas
- `predictCacheMiss` must stay non-throwing — observability/guard is advisory,
  never breaks the request path.
- The guard already skips tool-loop continuations (`isContinuation`) — keep it.
- Build: `bun run scripts/build-sdk.ts`; deploy: copy `dist/` →
  `~/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/`,
  then `systemctl --user restart claude-max-proxy.service`. `keepalive.json`
  changes are hot-reloaded — no restart needed for config.
- terser property-mangling is OFF (build-sdk.ts) — keep it off (introspection
  getters must survive).

## Verify when done
- 472+ tests green, typecheck clean SDK + proxy.
- Restart the daemon, then a previously-seen session's request is still
  classified correctly (not a false cold-start) → guard works post-restart.
- Simulate an org-id change → request classified `anomalous:org-switch` → 400
  unless `[%cache-rewrite-ok%]`.
