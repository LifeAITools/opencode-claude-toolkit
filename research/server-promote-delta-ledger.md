# claude-max-proxy — server promote SAFETY-GATE delta ledger

**Generated:** 2026-05-28
**Purpose:** Confirm the NEW thin-router server preserves EVERY behavior of the OLD live monolith before a production deploy.

## Artifacts compared

- **OLD / LIVE (prod, source of truth):** `/home/relishev/.local/share/claude-max-proxy/src/server.ts` (703 lines, monolith, `PROXY_VERSION='0.8.6'` hardcoded).
- **NEW / DEV (candidate):** `/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/src/server.ts` (466 lines, thin router) + modules:
  - `/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/src/module.ts`
  - `.../src/managed-sessions.ts`
  - `.../src/modules/anthropic.ts`
  - `.../src/modules/admin.ts`
  - `.../src/modules/health.ts`
  - `.../src/modules/openai-compat.ts`
  - `.../src/config.ts`, `.../src/event-bus.ts`, `.../src/openai-translate.ts`

---

## 1. VERDICT

**RISKS-FOUND — NOT byte-clean for the `/v1/messages` hot path. Promote only after a deliberate decision on the 3 behavioral deltas below.**

The DEV thin-router is a **functional superset** of the LIVE monolith for routing/lifecycle/admin/health/stats — every LIVE route and lifecycle behavior has a DEV counterpart, and DEV adds OpenAI-compat routes that do not collide with existing ones. **However, the single most important production path — `POST /v1/messages` — is NOT a pure passthrough in DEV.** DEV introduces two new, unconditional/conditional transforms that LIVE never performed:

1. **`x-api-key` is stripped from forwarded headers for ALL requests** (incl. native CC). LIVE forwarded every header verbatim.
2. **Non-native-CC requests are enriched** (betas/billing/metadata/cache markers injected, `authorization`/`x-api-key` dropped, `user-agent` rewritten to `claude-cli/…`). LIVE forwarded the body+headers untouched.

These are almost certainly **intentional product evolution** (subscription-enrichment so 3rd-party Anthropic SDK clients look like native CC), not accidental regressions — but they change wire bytes vs prod and MUST be acknowledged as a behavioral delta before promote, because the gate is "preserve EVERY behavior". A third delta (the `kaCacheTtlSec` default) and the moved version source round out the list.

**Confidence:** High on route/lifecycle parity (read every line of both servers + all DEV modules + config + event-bus). The deltas are sourced to exact lines.

---

## 2. ROUTE-BY-ROUTE TABLE

| Route | LIVE behavior (file:line) | DEV location | Status |
|---|---|---|---|
| `POST /v1/messages` | LIVE `server.ts:441→324-355`: resolve sessionId, PID from peer port, collect **ALL** headers verbatim (incl. `x-api-key`), `captureBody`, then `proxyClient.handleRequest(rawBody, headers, …)` — **pure passthrough, no body/header mutation**. | `modules/anthropic.ts:18-51` | **CHANGED** — see §4-A. DEV strips `x-api-key` (line 29) for all; enriches body+headers when `!isNativeCC` (lines 34-41). |
| `GET /health` | `server.ts:445-447`: `{ok, uptime, sessions: tracker.size()}` (=`proxyClient.sessionCount()`). | `modules/health.ts:86-94` | **PRESERVED** — identical shape/source. |
| `GET /version` | `server.ts:449-451`: `{name:'@kiberos/claude-max-proxy', version, pid, uptime}`. | `modules/health.ts:95-104` | **PRESERVED** — identical (version now from package.json, §4-C). |
| `GET /stats` | `server.ts:453-455→370-429`: full state, `Cache-Control:no-store`. | `modules/health.ts:105-109,20-80` | **CHANGED (additive)** — adds `modules` + `openaiCompat` fields; `cacheConfig` default differs via config (§4-B). Core fields preserved. |
| `GET /admin/sessions` | `server.ts:457-462`: `{sessions:[{sessionId,pid,model,firstSeenAt,lastRequestAt}]}` from `tracker.list()`. | `modules/admin.ts:26-35` | **PRESERVED** — identical fields/source (`proxyClient.listSessions()`). |
| `POST /admin/sessions/managed` | `server.ts:467-483`: validate sessionId+workerId (400 if missing), find tracked PID, mark managed (ttl default 30_000), emit `SESSION_MANAGED`, return `{ok,sessionId,workerId}`. | `modules/admin.ts:38-52` | **PRESERVED** — same validation, same default ttl, same emit, same return. |
| `POST /admin/worker/heartbeat` | `server.ts:486-501`: validate workerId+activeSessionIds array (400 if missing), refresh matching managed entries, return `{ok,refreshed,total}`. | `modules/admin.ts:74-85` | **PRESERVED** — identical. `total` = managed count both. |
| `DELETE /admin/sessions/managed` | `server.ts:504-511`: validate sessionId (400 if missing), delete, return `{ok:existed,sessionId}`. | `modules/admin.ts:62-71` | **PRESERVED** — identical. |
| `GET /admin/sessions/managed` | `server.ts:514-521`: list managed `[{sessionId,...entry,staleSec}]`. | `modules/admin.ts:55-59` + `managed-sessions.ts:92-100` | **PRESERVED** — `list()` returns `{sessionId,workerId,lastHeartbeat,ttlMs,staleSec}`. **Minor:** LIVE spreads the whole entry (incl. `lastPid`); DEV's `list()` omits `lastPid`. See §4-D (low risk). |
| `POST /admin/shutdown` | `server.ts:523-527`: emit `PROXY_SHUTDOWN`, `setTimeout(shutdown,100)`, return `{ok,msg}`. | `modules/admin.ts:88-95` | **PRESERVED** — identical (shutdown injected via `createAdminModule(()=>shutdown())`). |
| `POST /admin/disarm` | `server.ts:529-544`: parse body (empty=all), `proxyClient.disarmSessions(reason,sessionId)`, return `{ok,disarmedCount,sessionIds,reason,tokenCacheInvalidated:true}`. | `modules/admin.ts:99-112` | **PRESERVED** — identical. |
| `POST /admin/reload` | `server.ts:546-564`: parse body, `proxyClient.reloadSessions(...)`, return `{ok,reloadedCount,sessionIds,reason,tokenCacheInvalidated:true,kaTimerKept:true}`. | `modules/admin.ts:115-128` | **PRESERVED** — identical. |
| `OPTIONS /v1/chat/completions` | — (LIVE: 404) | `modules/openai-compat.ts:30-34` | **DEV-ONLY** — CORS preflight. |
| `OPTIONS /v1/models` | — (LIVE: 404) | `modules/openai-compat.ts:35-39` | **DEV-ONLY** — CORS preflight. |
| `GET /v1/models` | — (LIVE: 404) | `modules/openai-compat.ts:42-46` | **DEV-ONLY** — model list. |
| `POST /v1/chat/completions` | — (LIVE: 404) | `modules/openai-compat.ts:49-147` | **DEV-ONLY** — OpenAI→Anthropic translation through `proxyClient.handleRequest`. |
| any unmatched | `server.ts:566`: `404 'Not Found'`. | `server.ts:329`: `404 'Not Found'`. | **PRESERVED** — same fallthrough. |

**Route-set conclusion:** No LIVE route dropped. DEV adds exactly 4 OpenAI-compat routes (2 OPTIONS, 1 GET, 1 POST). Baseline claim "identical except dev ADDS `/v1/chat/completions` and `/v1/models`" is **CONFIRMED** (plus the 2 OPTIONS preflights, which the structural pass under-counted but are additive and harmless).

**Route-matching semantics:** DEV `matchRoute` (`module.ts:92-101`) is exact `method===r.method && path===r.path` (with `*` wildcard support, unused here). LIVE is an inline `if`-chain with identical exact-match semantics. First-match-wins in both; DEV order = health, admin, anthropic, openai-compat (no overlapping paths, so order is irrelevant). **PRESERVED.**

---

## 3. GLUE / LIFECYCLE TABLE

| Concern | LIVE (file:line) | DEV location | Status |
|---|---|---|---|
| Mode detection (`PROXY_MODE`, `PARENT_PID`, embedded guard exit-2) | `server.ts:68-78` | `server.ts:74-84` | **PRESERVED** — byte-identical. |
| Port ranges (global 5050-5099 / embedded 5100-5199) | `server.ts:84-85` | `server.ts:90-91` | **PRESERVED** — identical. |
| Config load (`loadConfig()`) | `server.ts:87` | `server.ts:93` | **PRESERVED** (config superset, §4-B). |
| Logger start | `server.ts:90` | `server.ts:96` | **PRESERVED**. |
| `PROXY_MODE_START` emit | `server.ts:92-98` | `server.ts:98-104` | **PRESERVED**. |
| Discovery acquire-slot / refuse-double-start / no-free-port exit | `server.ts:106-135` | `server.ts:112-141` | **PRESERVED** — identical logic + exit codes (0 on healthy existing, 1 on no port). |
| Embedded port pick (`findFreePort`) | `server.ts:136-151` | `server.ts:142-157` | **PRESERVED**. |
| `PROXY_CONFIG` emit | `server.ts:153-161` | `server.ts:159-167` | **PRESERVED**. |
| Body-capture boot (`startCaptureCleanup`, `BODY_CAPTURE` emit) | `server.ts:167-174` | `server.ts:173-180` | **PRESERVED**. |
| Credentials adapter | `server.ts:186` | `server.ts:192` | **PRESERVED**. |
| Managed-session persistence (load on boot / persist 10s / sweep 5s) | inline `server.ts:199-225,299-307` | `managed-sessions.ts` (`ManagedSessionService`), wired `server.ts:195-197` | **PRESERVED (refactored)** — same file `~/.claude-local/proxy-managed-sessions.json`, same TTL-fresh load filter, same 10s persist / 5s sweep. **Minor:** DEV `unref()`s the persist+sweep timers (`managed-sessions.ts:49-51,60-62`); LIVE does not. Harmless (shutdown clears them anyway). |
| ProxyClient construction (config block) | `server.ts:227-261` | `server.ts:199-220` | **PRESERVED** — identical config keys passed. |
| Liveness checker (PID + managed override) | inline `server.ts:244-260` | `server.ts:214-219` → `managed-sessions.ts:103-108` | **PRESERVED** — same semantics: `process.kill(pid,0)` then dead-PID managed-fresh+`lastPid===pid` check. |
| Credentials `fs.watch` (200ms debounce, invalidate) | `server.ts:270-290` | `server.ts:229-249` | **PRESERVED** — byte-identical. |
| `tracker` alias (`size`/`list` → proxyClient) | `server.ts:294-297` | `server.ts:253-256` | **PRESERVED**. |
| Heartbeat start | `server.ts:312` | `server.ts:263` | **PRESERVED** — `startHeartbeat(cfg, tracker, ()=>proxyClient.rateLimitSnapshot)`. |
| PID-from-peer-port resolution (`resolvePidFromPort`) | imported `server.ts:366`, used in handler `:335` | `modules/anthropic.ts:12,26` (and openai-compat.ts:12,87) | **PRESERVED** — same SDK/session-tracker import, same `srcPort ? resolve : null`. |
| `statsJson()` | `server.ts:370-429` | `modules/health.ts:20-80` | **CHANGED (additive)** — §4-B. |
| `Bun.serve` (port, host, idleTimeout 255) | `server.ts:433-436` | `server.ts:320-323` | **PRESERVED** — same options. |
| Discovery publish (global) | `server.ts:574-610` | `server.ts:337-373` | **PRESERVED** — `publishDiscoveryState`, `STARTUP` + `PROXY_STARTED` emits identical. |
| Embedded ready stdout JSON (`type:'ready'…`) | `server.ts:611-653` | `server.ts:374-416` | **PRESERVED** — byte-identical JSON shape + STARTUP/PROXY_STARTED emits. |
| Parent-PID watcher (embedded, 2s poll, self-exit) | `server.ts:657-677` | `server.ts:420-440` | **PRESERVED** — identical (incl. `unref`). |
| `shutdown()` (clear watcher, stopHeartbeat, proxyClient.stop, server.stop(true), clearDiscovery if global, stopLogger, exit 0) | `server.ts:681-691` | `server.ts:444-454` | **PRESERVED (one gap)** — see §4-E: DEV shutdown does NOT call `managedSessionsSvc.stop()` (final persist + timer clear). Low risk. |
| Signal handlers SIGTERM/SIGINT/SIGHUP | `server.ts:693-695` | `server.ts:456-458` | **PRESERVED** — identical. |
| `uncaughtException` / `unhandledRejection` guards | `server.ts:698-703` | `server.ts:461-466` | **PRESERVED** — byte-identical. |
| Module-load status / `INFO` emit | — | `server.ts:299-316` | **DEV-ONLY** — additive (module loader telemetry). |
| `setCompatVersion(cfg.ccCompatVersion)` | — | `server.ts:278` | **DEV-ONLY** — feeds enrichment compat-version (only matters for enriched/openai paths). |

### Env vars / feature flags

| Env var | LIVE | DEV | Status |
|---|---|---|---|
| `PROXY_MODE`, `PROXY_PARENT_PID`, `PROXY_PORT`, `PROXY_HOST` | yes | yes | PRESERVED |
| `LOG_LEVEL`/`LOG_FORMAT`/`LOG_FILE`/`LOG_JSONL` | yes | yes | PRESERVED |
| `KA_INTERVAL_SEC`, `KA_IDLE_TIMEOUT_SEC`, `KA_MIN_TOKENS`, `KA_REWRITE_*` | yes | yes | PRESERVED |
| `KA_CACHE_TTL_SEC` | default **300** (config.ts:127 LIVE) | default **3600** (config.ts:121 DEV) | **CHANGED** — §4-B. Both honor explicit env; only the unset-default differs. |
| `HEALTH_HEARTBEAT_SEC`, `CLAUDE_CREDENTIALS_PATH`, `ANTHROPIC_UPSTREAM_URL` | yes | yes | PRESERVED |
| `CLAUDE_MAX_PROXY_CAPTURE_BODIES` / `_CAPTURE_TTL_HOURS` | via body-capture.ts | same import | PRESERVED |
| `OPENAI_COMPAT_AUTH_TOKEN`, `OPENAI_COMPAT_THINKING` | — | DEV-only (config.ts:148-151) | DEV-ONLY |
| `CC_COMPAT_VERSION`, `EXTRA_BETA_FLAGS` | — | DEV-only (config.ts:153-154) | DEV-ONLY (affects enrichment only) |

### Side-effect integrations

| Side-effect | LIVE | DEV | Status |
|---|---|---|---|
| Body-capture file dumps | yes (`captureBody` in handler) | yes (`anthropic.ts:43`, also openai path does NOT call captureBody) | **PRESERVED for `/v1/messages`**. (OpenAI path not capturing is DEV-only/additive.) |
| Managed-session JSON persistence | yes | yes | PRESERVED |
| Discovery state file write/clear | yes | yes | PRESERVED |
| Event-bus emits | yes | yes + new OPENAI_COMPAT_* + module-load INFO | PRESERVED + additive |
| `loadKeepaliveConfig()` hot-read in /stats | yes (`server.ts:407`) | yes (`health.ts:56`) | PRESERVED |

---

## 4. 🔴 MISSING-IN-DEV / REGRESSION RISKS

No LIVE route or lifecycle step is **absent** in DEV. The risks are **behavioral changes on preserved routes**, ordered by blast radius.

### 4-A. 🔴 HIGH — `POST /v1/messages` is no longer a pure passthrough
LIVE (`server.ts:338-354`) forwards the request **verbatim**: every header (incl. `x-api-key`) and the unmodified `rawBody` go straight to `proxyClient.handleRequest`. DEV (`modules/anthropic.ts:28-49`) introduces two transforms:

1. **`x-api-key` stripped unconditionally** (`anthropic.ts:29`: `if (k.toLowerCase() !== 'x-api-key') headers[k]=v`). Applies to **native CC too**. If anything downstream (SDK `handleRequest` / upstream) ever relied on `x-api-key` being present on the forwarded request, this changes the wire. (In practice the SDK injects OAuth and Anthropic ignores `x-api-key` for OAuth requests — but this is a wire-byte change vs prod and must be acknowledged.)
2. **Enrichment for non-native-CC** (`anthropic.ts:34-41`): when `user-agent` lacks `claude-cli/` AND no `x-claude-code-agent-id`, the body is run through `enrichAnthropicRequest` (openai-translate.ts:956+) which injects betas, rewrites `user-agent` to `claude-cli/${CC_COMPAT_VERSION}`, drops `authorization`+`x-api-key`, injects `metadata.user_id`, billing attribution, cache markers. LIVE never did this.

**Native-CC impact:** native claude CLI sets `user-agent: claude-cli/…`, so `isNativeCC===true` → enrichment is **skipped**; the only residual change for native CC is the `x-api-key` strip (item 1). **Third-party Anthropic SDK consumers** (Cursor, raw SDK) WILL see materially different forwarded requests vs prod.

**Assessment:** intentional product feature (subscription enrichment), but it IS a behavioral delta vs LIVE. **Decision required:** confirm enrichment is desired-in-prod and that native CC tolerates the `x-api-key` strip. If you want byte-for-byte prod parity on this deploy, this is a blocker; if the enrichment ship is the goal, it's expected.

### 4-B. 🟡 MEDIUM — `/stats` payload + `KA_CACHE_TTL_SEC` default changed
- **`cacheConfig` default:** LIVE `kaCacheTtlSec` defaults to **300**, DEV to **3600** (config.ts:127 vs 121). This flows into ProxyClient construction and the per-session KA cache-TTL behavior, not just /stats display. The comment claims wire-autoscan downlocks to 300 when it sees un-upgraded markers, so the effective behavior may converge — but the **default that ProxyClient is constructed with differs**, which can change KA fire cadence for sessions whose markers are already 1h-upgraded. **Verify this is intended** (the DEV comment says the SDK now upgrades CC markers to `ttl:'1h'`, justifying 3600). Either way it's a real default change.
- **`/stats` adds** `modules:{loaded,failed}` (health.ts:34) and `openaiCompat:{…}` (health.ts:72-78). Additive — existing consumers reading `proxy`/`sessions`/`rateLimit`/`config`/`cacheConfig`/`cacheMetrics` are unaffected. Field order changed but JSON consumers don't care.

### 4-C. 🟢 LOW — version source moved
LIVE hardcodes `PROXY_VERSION='0.8.6'` (server.ts:59). DEV reads it from `package.json` at `import.meta.dir/../package.json` (server.ts:62-65), currently **`1.0.0`**. So `/version`, `/stats.proxy.version`, STARTUP/PROXY_STARTED `pkg`, and openai `system_fingerprint` will report `1.0.0` instead of `0.8.6`. Cosmetic but visible; confirm `1.0.0` is the intended published version.

### 4-D. 🟢 LOW — `/admin/sessions/managed` GET drops `lastPid`
LIVE (`server.ts:516-519`) spreads the full managed entry into each item (includes `lastPid`). DEV `list()` (`managed-sessions.ts:92-100`) returns only `{sessionId,workerId,lastHeartbeat,ttlMs,staleSec}` — **no `lastPid`**. Any consumer reading `lastPid` from this admin endpoint would regress. Unlikely (internal Worker integration), but a strict field-level delta.

### 4-E. 🟢 LOW — `shutdown()` doesn't flush ManagedSessionService
DEV `shutdown()` (server.ts:444-454) never calls `managedSessionsSvc.stop()` (which does a final `persist()` + clears its timers). LIVE relied on the 10s interval persist; on shutdown LIVE also left the last ≤10s of heartbeats unpersisted, so behavior is roughly equivalent — but DEV added a `stop()` with a final persist and **didn't wire it**, so the up-to-10s persistence-gap that existed in LIVE is preserved rather than fixed. Not a regression vs LIVE; flagged only because the capability exists and is unused. (DEV timers are `unref`'d so they won't block exit.)

### Summary of MISSING-IN-DEV
- **Zero** routes or lifecycle steps are missing/absent.
- **One HIGH behavioral delta** (4-A, `/v1/messages` enrichment + `x-api-key` strip) — the only item that could silently change production wire behavior; requires an explicit promote decision.
- Three LOW + one MEDIUM behavioral deltas, all either intentional or cosmetic.

---

## 5. DEV-ONLY ADDITIONS (interference check)

| Addition | Interference with existing routes? |
|---|---|
| `POST /v1/chat/completions`, `GET /v1/models`, `OPTIONS /v1/chat/completions`, `OPTIONS /v1/models` | **None.** Distinct pathnames; `matchRoute` is exact method+path. They do NOT shadow `/v1/messages` or any admin/health route. Module load order (health→admin→anthropic→openai-compat) is irrelevant given no path overlap. |
| `modules` + `openaiCompat` blocks in `/stats` | Additive JSON fields only. |
| Module-load `INFO` event + per-module "loaded" emit | Telemetry only. |
| `setCompatVersion(cfg.ccCompatVersion)` | Affects enrichment output only; no effect on routes when enrichment is skipped (native CC). |
| `ManagedSessionService` timer `unref()` | Behavior-neutral vs LIVE except it won't keep the event loop alive (correct for a daemon that exits via `process.exit`). |

**Conclusion:** DEV-only additions are isolated and do not alter any preserved route's behavior.

---

## 6. SMOKE-TEST CHECKLIST (scratch-port validation, next phase)

Start DEV on an embedded scratch port (`PROXY_MODE=embedded PROXY_PARENT_PID=$$ PROXY_PORT=5151`) and run against LIVE on 5050 for diff. **Do NOT spend quota** — most checks are GET/admin; only one real `/v1/messages` check needs a token, defer or use a recorded body.

1. **`GET /health`** — assert `{ok:true, uptime:int, sessions:int}` shape matches LIVE. (no quota)
2. **`GET /version`** — DEV returns `version:'1.0.0'` (LIVE `0.8.6`); confirm `1.0.0` is intended (4-C). (no quota)
3. **`GET /stats`** — diff JSON vs LIVE: confirm `proxy/sessions/rateLimit/config/cacheConfig/cacheMetrics` present & same shape; confirm new `modules`+`openaiCompat` present; **confirm `cacheConfig.cacheTtlMs`/`config` reflect the intended `KA_CACHE_TTL_SEC` default** (4-B). Header `Cache-Control: no-store` present. (no quota)
4. **`POST /admin/sessions/managed`** with `{}` → expect `400 {error:'sessionId and workerId required'}`; with valid body → `{ok,sessionId,workerId}` and a `SESSION_MANAGED` log line. (no quota)
5. **`GET /admin/sessions/managed`** — confirm list shape; **note `lastPid` absent in DEV** (4-D) — verify no consumer depends on it. (no quota)
6. **`POST /admin/worker/heartbeat`** valid + invalid → `{ok,refreshed,total}` / `400`. (no quota)
7. **`DELETE /admin/sessions/managed`** → `{ok:existed,sessionId}` / `400` on missing. (no quota)
8. **`POST /admin/disarm`** empty body → `{ok,disarmedCount,sessionIds,reason:'admin_disarm',tokenCacheInvalidated:true}`. (no quota)
9. **`POST /admin/reload`** empty body → `{…,kaTimerKept:true}`. (no quota)
10. **`GET /admin/sessions`** — `{sessions:[{sessionId,pid,model,firstSeenAt,lastRequestAt}]}`. (no quota)
11. **`POST /v1/messages` header passthrough (CRITICAL, 4-A):** send a request with a dummy `x-api-key` and a **native** `user-agent: claude-cli/2.x` to BOTH proxies pointed at a local capture/echo upstream (`ANTHROPIC_UPSTREAM_URL=http://127.0.0.1:<echo>`) — confirm: DEV drops `x-api-key`, body unchanged (no enrichment because native); LIVE keeps `x-api-key`. **Do NOT hit real Anthropic.** This is the decision-gate test for 4-A.
12. **`POST /v1/messages` enrichment (4-A):** same echo-upstream, send a **non-native** request (`user-agent: python-anthropic`); confirm DEV injects betas/`user-agent=claude-cli/…`/metadata while LIVE forwards verbatim. Decide whether the enrichment is the intended prod behavior.
13. **OPTIONS `/v1/chat/completions`** → DEV returns CORS preflight (LIVE 404). Additive — just confirm it doesn't 500. (no quota)
14. **`GET /v1/models`** → DEV returns model list (LIVE 404). (no quota)
15. **404 fallthrough** — `GET /nonexistent` → `404 'Not Found'` on both. (no quota)
16. **Lifecycle:** confirm DEV embedded prints the `{type:'ready',mode:'embedded',port,pid,...}` stdout line; SIGTERM cleanly exits (discovery cleared only in global; managed-sessions file written by the 10s timer before exit). (no quota)
17. **Double-start refusal (global):** start DEV global while LIVE global healthy → DEV must exit 0 with "Refusing to start second GLOBAL instance". (no quota)

---

### One-line gate
**PROMOTE-SAFE for routing/admin/health/lifecycle. RISKS-FOUND on `/v1/messages`:** DEV strips `x-api-key` (all requests) and enriches non-native-CC bodies — a deliberate behavioral change vs the LIVE pure-passthrough. Confirm this is intended (subscription-enrichment ship), plus the `KA_CACHE_TTL_SEC` 300→3600 default and version `0.8.6→1.0.0`, before deploy. No routes or lifecycle steps are missing.
