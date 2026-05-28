# claude-max-proxy — Independent Deploy Audit (2026-05-28)

Auditor: independent deploy auditor (depth-1 agent). All findings verified live against
`http://127.0.0.1:5050` and on-disk sources. UTC timestamps; local = UTC+3.

Live proxy identity at audit time:
- **version** `0.8.6`, **pid** `3904833`, mode `global`, port `5050`, uptime `7785s` (restart ≈ `2026-05-28T06:26:01Z`)
- Runs from `/home/relishev/.local/share/claude-max-proxy/src/server.ts` via systemd `claude-max-proxy.service` (Bun).

---

## 1. Verdict

**Partial. The eviction circuit breaker (this session's SDK work) IS fully deployed and live; the multi-contract OpenAI-compatible endpoints and the kibctl module-router refactor (previous session's dev work) are NOT.** The live proxy is the **old monolithic `server.ts`** — a hand-edited file at `/home/relishev/.local/share/claude-max-proxy/src/server.ts` (last modified 2026-05-27, 0 module imports, inline `if (url.pathname === ...)` routing). It serves only the Anthropic-native facade (`/v1/messages`) plus admin/health/stats. The OpenAI-compat surface (`/v1/chat/completions`, `/v1/models`, GPT→Claude mapping, json_schema structured outputs) exists **only in the divergent dev package** `packages/claude-max-proxy/` (thin-router + `modules/`) and returns **404 live**. KA is warm and healthy; the breaker armed cleanly on the last restart with zero trips on the current pid. So: the SDK-bundle deploy succeeded as intended; the OpenAI-compat / replatform deploy never happened (its PRD is `status: draft`).

---

## 2. Live endpoint matrix

Method: empty/invalid body (`-d '{}'` for POST). 404 = route absent; 200/400 = route exists.

| Endpoint | Method | HTTP (empty body) | LIVE? | Contract type |
|---|---|---|---|---|
| `/v1/messages` | POST | **400** | YES | Anthropic-native (facade/passthrough) |
| `/v1/chat/completions` | POST | **404** | **NO** | OpenAI-compatible |
| `/v1/models` | GET | **404** | **NO** | OpenAI-compatible |
| `/health` | GET | **200** | YES | Admin/ops |
| `/stats` | GET | **200** | YES | Admin/ops |
| `/admin/sessions` | GET | **200** | YES | Admin/ops |
| `/admin/sessions/managed` | GET | **200** | YES | Admin/ops |

Additional admin routes confirmed declared in live `server.ts` (not probed to avoid side effects):
`GET /version`, `POST /admin/sessions/managed`, `DELETE /admin/sessions/managed`,
`POST /admin/worker/heartbeat`, `POST /admin/shutdown`, `POST /admin/disarm`, `POST /admin/reload`.

---

## 3. LIVE vs DEV — the gaps

**Live server (`/home/relishev/.local/share/claude-max-proxy/src/server.ts`, 29002 bytes, 2026-05-27):**
- Monolith. Inline route dispatch via `req.method === ... && url.pathname === '...'` (lines 441–546).
- Imports: `config`, `event-bus`, `logger`, `session-tracker`, `upstream`, `heartbeat`, `discovery`, `@life-ai-tools/claude-code-sdk` (`ProxyClient`), `body-capture`. **No `loadModules`, no `modules/*`, no `matchRoute`** (grep count = 0).
- Declared routes: `/v1/messages`, `/health`, `/version`, `/stats`, and 8 `/admin/*` routes. **No `/v1/chat/completions`, no `/v1/models`.**

**Dev package (`/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/`, modules dated 2026-05-28 01:18–01:20):**
- Thin router: `server.ts` imports `loadModules`/`matchRoute` from `./module.js` and instantiates `createHealthModule`, `createAdminModule`, `createAnthropicModule`, `createOpenAICompatModule`. Dispatch is `matchRoute(allRoutes, req.method, url.pathname)`.
- `modules/openai-compat.ts` declares `/v1/chat/completions` (POST), `/v1/models` (GET + a second entry) — these are the routes 404ing live.
- `modules/anthropic.ts` → `/v1/messages`; `modules/admin.ts` → all admin routes; `modules/health.ts` → `/health` (+ advertises `/v1/chat/completions` and `/v1/models` in its capability payload).

**Endpoints in dev but MISSING live:**

| Endpoint | In dev module | Live |
|---|---|---|
| `POST /v1/chat/completions` | `modules/openai-compat.ts:32,51` | **404 (missing)** |
| `GET /v1/models` | `modules/openai-compat.ts:37,44` | **404 (missing)** |

**Architecture answer:** the live server is the **old monolith**, NOT the refactored thin-router. The dev replatform is real code but **un-deployed**; its driving PRD (`PRPs/kibctl-proxy-replatform/02-prd.md`) is `status: draft`.

---

## 4. Eviction breaker status — CONFIRMED LIVE

Deployed SDK bundle `/home/relishev/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/index.js` contains all expected symbols:
- `EvictionCircuitBreaker` ✓
- `KA_DISARM_EVICTION_BREAKER` ✓
- `isServerSideEviction` ✓
- `EVICTION_BREAKER_ARMED` ✓

Runtime confirmation in `/home/relishev/.claude-local/claude-max-proxy.jsonl`:
```
{"ts":"2026-05-28T06:26:01.819Z","level":"info","kind":"EVICTION_BREAKER_ARMED","cooldownSec":300,"minTrips":1,"enabled":true}
```
This timestamp matches the current pid's start (uptime 7785s ⇒ ≈06:26:01Z). The breaker armed on the latest restart with `enabled:true`, `cooldownSec:300`, `minTrips:1`.

**No false trips on current pid:** `0` occurrences of `KA_FIRE_EVICTION_DETECTED`/`KA_DISARM_EVICTION_BREAKER` in the jsonl, and `0` lines for pid `3904833` in `claude-max-debug.log`. (The disarm/detected lines present in debug.log are from OLD pids `3537203`/`3538431` at `06:04`, i.e. BEFORE the 06:26 restart — correctly attributed to prior runs, not the live one.)

---

## 5. KA health — WARM

Recent `KA_FIRE_COMPLETE` events (since restart) in `claude-max-proxy.jsonl` show `cacheCreationInputTokens: null` (no new cache writes from KA fires — warm reuse), through `2026-05-28T08:34:03Z`.

`/stats` cacheMetrics (60s window): `hitRate 0.947`, `kaCount 0`, `coldStartCount 0`, `avgCacheRead ≈229,699`, `maxCacheRead 370,253`, `estimatedSavedTokens ≈3,927,859`. Rate-limit status `allowed` (5h util 0.25, 7d util 0.20). KA timers running across registered sessions. **Healthy; no eviction storm.**

---

## 6. Recommendations

1. **To make OpenAI-compat live**, the dev thin-router + `modules/` must be deployed to `/home/relishev/.local/share/claude-max-proxy/src/`, replacing the monolithic `server.ts`. This is the *only* way `/v1/chat/completions` and `/v1/models` become non-404 — they do not exist in the live file at all.
2. **Risk of deploying the refactored `server.ts` — HIGH, do not hot-swap blindly:**
   - The live `server.ts` has been **hand-edited live for months** (multiple `.bak-*` siblings: `server.ts.bak-20260520-...`, `.pre-ttlscan-bak`, plus edited `config.ts`, `quota-watcher.ts`, `logger.ts`). It may contain live-only fixes (quota pipeline, TTL scan, body-capture wiring) that the dev package — branched earlier — does **not** have. A straight replace could regress quota/KA behavior.
   - kibctl-proxy-replatform AC-11 (no endpoint regression) and AC-09a (all 9 admin endpoints integration-tested) are **unmet** — there is no evidence the dev modules were validated against the live admin contract.
   - **Recommended path:** (a) 3-way diff live `server.ts` vs dev `server.ts` vs the nearest `.bak` to inventory live-only edits; (b) port any live-only logic into the dev modules; (c) run the dev package's `test/openai-compat.test.ts` + an admin-contract integration pass; (d) deploy to a **scratch port** (embedded mode, 5100–5199) and re-run the §2 matrix + a single minimal `/v1/chat/completions` smoke (`max_tokens:1`) before promoting to the systemd unit; (e) keep the current `server.ts` as `.bak` for instant rollback.
3. **Eviction breaker + KA: no action needed** — deployed, armed, warm, zero false trips on the live pid.
4. **Hygiene:** the kibctl-proxy-replatform PRD is still `status: draft` despite the dev code existing — update its status/execution-log to reflect that modules are built-but-undeployed, so the next session doesn't assume it shipped.

---

### Evidence index (full paths)
- Live server: `/home/relishev/.local/share/claude-max-proxy/src/server.ts`
- Deployed SDK bundle: `/home/relishev/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/index.js`
- Dev thin-router: `/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/src/server.ts`
- Dev modules: `/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/src/modules/{anthropic,openai-compat,admin,health}.ts`
- Proxy event log: `/home/relishev/.claude-local/claude-max-proxy.jsonl`
- Debug log: `/home/relishev/.claude-local/claude-max-debug.log`
- Replatform PRD: `/home/relishev/projects/vibe/claude-code-sdk/PRPs/kibctl-proxy-replatform/02-prd.md`
