---
created: 2026-05-20
project: /home/relishev/projects/vibe/claude-code-sdk
purpose: "Handover — claude-max-proxy session: shipped work + OPEN quota-pipeline fix"
status: active
---

# Handover — claude-max-proxy / cognitive-work-engine session

## ✅ RESOLVED 2026-05-20 — quota pipeline rebuilt as 3 decoupled stages

The break was diagnosed deeper than "writer dead": the emitter had MOVED (logger's
`logJsonl` path changed in the 0.8.3 upgrade), and quota-watcher was both orphaned
AND tailing the old dead path. Rather than re-wire the old coupling, rebuilt the
pipeline per user's architecture: **emitter → processor → injector**, each hot-
restartable, each corruption-resilient (keep last-good + log on bad data).

- **Stage 1 EMITTER** (in-proxy): NEW `src/stats-emitter.ts` subscribes to bus
  `REAL_REQUEST_COMPLETE`/`KA_FIRE_COMPLETE`, writes a NARROW VERSIONED contract
  `{v:1, ts, pid, type:"stream", model, usage, rateLimit:{util5h,util7d,status}}`
  to `~/.claude-local/claude-max-stats.jsonl`. Decoupled from verbose logging so
  proxy log changes never break downstream. Started in `server.ts` next to logger.
- **Stage 2 PROCESSOR** (own service): `src/quota-watcher.ts` got `import.meta.main`
  standalone bootstrap + bus→stdout sink for observability. Runs as
  `claude-max-quota-watcher.service` (NOT wired into server.ts — deliberate: its
  logic hot-restarts WITHOUT cooling proxy KA sessions). Per-line schema-`v`
  validation; bad JSON / unknown version / bad shape → skip + counted + throttled
  `QUOTA_WATCHER_LINE_REJECTED` log, last-good aggregate retained.
- **Stage 3 INJECTOR** (hook): `signal-wire-hook.sh` quota block now persists
  `quota-status.json`→`quota-status.last-good.json` on fresh reads; on
  missing/corrupt live file serves last-good (kept-previous) + throttled log to
  `~/.claude-local/quota-injector.log`; staleness flagged `quotaStale`+`quotaSource`
  instead of fail-closed empty. Shipped via plugin bump **2.16.9 → 2.16.10** (pushed).
- **SSOT**: `src/quota-paths.ts` holds the 3 file paths + `STATS_SCHEMA_VERSION`,
  imported by emitter + processor (separate processes).

VERIFIED end-to-end: emitter armed + writing v1 lines; processor computing
quota-status (util5h/util7d live); injector renders non-empty meta + falls back to
last-good on corrupt/missing + logs; corruption guard rejects bad lines keeping
aggregate; processor hot-restart leaves proxy PID unchanged (KA untouched).

## Shipped this session (all in `main`, pushed: github LifeAITools/opencode-claude-toolkit)

`claude-code-sdk` 0.16.0 → **0.20.3**, deployed to
`~/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/`,
`systemctl --user restart claude-max-proxy.service`. 532 tests green.
- REQ-2 org-awareness (`anomalous:org-switch`), `src/org-identity.ts`.
- KA-aware guard fix; `expected:proxy-restart`; block-dump (`src/rewrite-dump.ts`,
  `~/.claude-local/rewrite-guard-blocks/`).
- KA snapshot persistence across restart — `src/ka-snapshot-store.ts`,
  engine `revive()`/`serializeState()`, `~/.claude-local/proxy-ka-snapshots.json`.
- `extractSessionIdFromBody` + `server.ts` keys SDK-agents by `metadata.user_id`.
- `CC_VERSION_CHANGED` event.
- **Per-lineage KA idle clock** (`b6d9ed7`) — `LineageStat.lastWarmedAt`; tick
  uses per-lineage idle; abort only same-lineage. Fixes KA starvation in busy
  multi-agent sessions. VERIFIED: 28 KA fires post-deploy (was 0).
- **Problem B** (`1b9ac4d`) — `isAutomatedAgent()`; guard never hard-blocks
  automated agents (SDK workers / sub-agents) → `CACHE_REWRITE_UNGUARDED`.

`cognitive-work-engine` (github relishev/cognitive-work-engine, pushed `69b1589`):
proxy routing by default (`.cwa.yaml` `proxy:`), pinned `@anthropic-ai/claude-agent-sdk`
to `0.2.76`, stable per-worker `sessionId` + `resume`, `scripts/verify-proxy.mjs`.

## Current state
- Rewrite guard: **re-enabled** (`~/.claude/keepalive.json` rewriteGuard.enabled=true)
  — safe now (per-lineage KA + problem B both fixed).
- `184ebad8` runaway re-cache (`273b340cd011:46a83205c80` main agent, 9 cold
  writes) — root cause = KA starvation, fixed by `b6d9ed7`; 28 KA fires confirm
  KA now works. Re-verify: `grep 184ebad8 ...jsonl | grep KA_FIRE_COMPLETE`.

## Gotchas
- `~/.local/share/claude-max-proxy/` is NOT a git repo — `server.ts` edited live
  (manual `src.bak-*` copies). The `extractSessionIdFromBody` import there is live-only.
- `cognitive-work-engine` working tree has pre-existing non-mine WIP in `src/` —
  do NOT `git add -A`; stage explicit files.
- bun is at `~/.bun/bin/bun` (not on PATH for subagents).
- Build: `bun run scripts/build-sdk.ts`; deploy: copy `dist/*` to the proxy
  node_modules; `systemctl --user restart claude-max-proxy.service`.
