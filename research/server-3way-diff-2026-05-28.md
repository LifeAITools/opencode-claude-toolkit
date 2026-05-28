# 3-way diff: live monolith ↔ dev thin-router ↔ intent (claude-max-proxy server)

Session: d3cd323a · Date: 2026-05-28

## Artifacts
- **LIVE** (running): `/home/relishev/.local/share/claude-max-proxy/src/server.ts` — 703 lines, hand-edited monolith, NOT a git repo. systemd runs this file.
- **DEV thin-router**: `/home/relishev/projects/vibe/claude-code-sdk/packages/claude-max-proxy/src/server.ts` — 466 lines + `src/modules/{anthropic,openai-compat,admin,health}.ts`.
- **INTENT**: PRP `kibctl-proxy-replatform` (PRD `status: draft`; architect-review `reviewed`; plan `validated`).

## Route delta
| Route | LIVE | DEV | Note |
|---|---|---|---|
| `/v1/messages` (Anthropic native) | ✅ | ✅ | preserved |
| `/v1/chat/completions` (OpenAI-compat) | ❌ | ✅ | **intended ADD, not live** |
| `/v1/models` (OpenAI-compat) | ❌ | ✅ | **intended ADD, not live** |
| `/health` `/stats` `/version` | ✅ | ✅ | preserved |
| `/admin/{sessions,sessions/managed,disarm,reload,shutdown,worker/heartbeat}` | ✅ | ✅ | preserved |

So DEV = LIVE routes **+ {/v1/chat/completions, /v1/models}**. No routes were dropped.

## Live-only glue — was it preserved in the refactor? (the auditor's "months of un-mirrored edits" fear)
Verified each high-risk live-only concern IS present in the dev refactor:
- `captureBody` (wire-research body dumper) → `modules/anthropic.ts:43` ✅
- `resolvePidFromPeerPort` (PID-from-TCP-peer) → `modules/anthropic.ts:12` ✅
- `x-claude-code-session-id` session isolation → `modules/anthropic.ts:22` ✅
- `cacheConfig` hot-read of keepalive.json in stats → `modules/health.ts:54` ✅
- heartbeat / discovery / logger / event-bus wiring → present in dev `server.ts`

## The ONE intentional behavioral delta
- **LIVE** lists sessions via a local `tracker` (`SessionTracker.list()`).
- **DEV** lists via `proxyClient.listSessions()` / `sessionCount()` — session state moved INTO the SDK ProxyClient.
- This is the INTENDED architecture change (SDK becomes SSOT for session state), NOT a lost live edit.

## Corrected verdict
Divergence is **smaller than the audit feared**: the dev thin-router is a faithful refactor of the live monolith **plus** the OpenAI-compat addition. No live-only logic appears dropped; the only behavioral change is the intentional session-state-into-SDK move.

## Still required before promoting DEV → LIVE (do NOT blind hot-swap)
1. True line-by-line `diff` of admin/handler bodies (this summary is structural, not exhaustive).
2. **Scratch-port smoke test**: run the dev thin-router on a non-5050 port against the freshly-deployed SDK; curl every endpoint (incl. `/v1/chat/completions` with `openai` SDK, `/v1/messages`, admin, health) before swapping live.
3. Confirm dev server's SDK API usage (`listSessions`, `sessionCount`, `handleRequest`, `disarmSessions`, `reloadSessions`, `cacheMetricsSnapshot`) matches the deployed SDK bundle (just refreshed this session).
4. Backup live `src/` (already pattern in `safe-upgrade-proxy.sh`) + keep rollback.

## Root cause of the gap (feeds CLAUDE.md lessons)
- Previous session BUILT + dev-TESTED OpenAI-compat + module refactor, declared "done", but NEVER deployed/verified it live → feature exists, delivers zero value.
- The deployed proxy is hand-edited in place (not a git repo) → guaranteed drift from source = the reason a "3-way" diff is even needed.
- "Tests green in dev" was treated as task completion; the live-verification gate was skipped.
