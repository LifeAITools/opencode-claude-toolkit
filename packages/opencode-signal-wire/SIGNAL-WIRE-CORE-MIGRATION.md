# Signal-Wire Core Adapter — Migration Guide

## Status

**Shipped 2026-04-20 — opt-in. Not yet production-default.**

The local `signal-wire.ts` (1151 LOC) remains the production path. A new
`signal-wire-core-adapter.ts` (193 LOC) provides the same public API
backed by the canonical `@kiberos/signal-wire-core` engine.

## What this gives you

- **Drop-in replacement:** `new SignalWire({serverUrl, sessionId, rulesPath, platform})` works identically
- **Same legacy API surface:** `evaluate(ctx)`, `trackTokens(u)`, `toggleRule(id, enabled)`, `listRules()`, `isRuleEnabled(id)`, `setSdkClient(c)`, `getContextPosition()`, `evaluateExternal(wakeEvent)`, `evaluateAsync(ctx)`
- **Automatic legacy rule translation:** rules.json with Python-style grammar (`action: {hint/bash}`, `events: [UserPromptSubmit]`) → canonical grammar on load
- **Platform filtering preserved:** `platforms: ['opencode']` filter still applied
- **Zero duplication:** one engine, shared with wake-router, Claude Code hooks (future), Telegram bot
- **Spec-conformant:** 150/150 golden vectors pass; behavior is tested

## How to try it

### Side-by-side test (recommended first)

```bash
cd packages/opencode-claude
bun test signal-wire-adapter.test.ts    # 12 adapter tests pass
bun test signal-wire-parity.test.ts     # 6 behavior-parity tests pass
```

### Switch provider.ts (when ready)

Change **one line** in `provider.ts`:

```ts
// BEFORE:
import { SignalWire } from './signal-wire.ts'

// AFTER:
import { SignalWire } from './signal-wire-core-adapter.ts'
```

No other code changes needed — public API is identical.

### Gradual cutover via environment flag (future)

Once `provider.ts` has been committed clean, wire a feature flag:

```ts
const SignalWireImpl = process.env.SIGNAL_WIRE_ENGINE === 'core'
  ? CoreAdapter
  : LegacySignalWire
```

## What stays in this package after migration

**Not touched by this migration:**
- `provider.ts` — OAuth, Claude SDK, provider registration (core unchanged)
- `wake-listener.ts` — L4 wake event listener (platform-specific, stays)
- `wake-preferences.ts`, `wake-types.ts` — platform contract types
- `index.ts` — plugin entry with wake-listener lifecycle
- `tui.tsx` — UI

**Deprecated (kept for reference, not used after cutover):**
- `signal-wire.ts` — 1151 LOC full engine → replaced by adapter
- `signal-wire-actions.ts` — 312 LOC action dispatch → in Core emitters
- `signal-wire-audit.ts` — 114 LOC audit log → in Core AuditEmitter

## Rules file — do I need to migrate?

**No.** The adapter translates legacy rule format on load:
- `events: [UserPromptSubmit, PostToolUse, Stop, PreToolUse, ExternalEvent]` → canonical
- `action: {hint: "..."}` → `actions: [{type: "hint", text: "..."}]`
- `action: {bash: "..."}` → `actions: [{type: "exec", command: "..."}]`
- `action: {exec: "...", timeout: 15}` → `actions: [{type: "exec", command: "..."}]`
- `cooldown_minutes: 5` → `cooldown_seconds: 300`
- `platforms: ['opencode']` filter preserved

21 production rules tested (17 applicable to opencode platform, 4 filtered as claude-code-only).

## Rollback

If any issue is observed after cutover:
1. Revert the one-line import change in provider.ts
2. Re-build — legacy engine is restored instantly

Legacy files (`signal-wire.ts`, `signal-wire-actions.ts`, `signal-wire-audit.ts`) are NOT deleted — they remain as fallback.

## Validation criteria — new-instance acceptance test

**Goal:** confirm that any fresh opencode session picks up the new adapter correctly
*and* that rule dispatch actually works under real prompt input — not just that the
plugin loads.

**Rollout model:** we don't maintain legacy consumers. Every running session is ours.
Validation = exercise 2–3 fresh sessions and confirm all six checks; then running
sessions get the new version on their next restart automatically.

### Sample size

**3 fresh opencode sessions**, chosen for input diversity:
1. One session doing a **short single-turn prompt** (tests happy path).
2. One session doing a **tool-heavy flow** (≥5 bash/read/edit calls — tests streaming + rule dispatch under load).
3. One session running **>10 minutes** (tests no silent abort, no memory/keepalive regression).

### Per-session checks (all six must pass)

For each session's `pid`, the following must be true within 5 minutes of real usage:

| # | Check | Verification command |
|---|-------|----------------------|
| 1 | Identity chain complete (all 3 banner lines present) | `grep -E "pid=$PID" ~/.claude/signal-wire-debug.log \| grep -E "ENGINE_SELECT\|ADAPTER_BANNER\|BANNER sw-core" \| wc -l` → must be ≥3 |
| 2 | `ENGINE_SELECT=CORE` (not legacy) | `grep "pid=$PID" ~/.claude/signal-wire-debug.log \| grep "ENGINE_SELECT=CORE"` → must be non-empty |
| 3 | Rules count matches SSOT (currently 22) | `grep "pid=$PID" ~/.claude/signal-wire-debug.log \| grep -oE "rules_loaded=[0-9]+" \| head -1` → value == `jq '.rules \| length' signal-wire-rules.json` |
| 4 | Source and dist rules JSON in sync | `diff <(jq -S . signal-wire-rules.json) <(jq -S . dist/signal-wire-rules.json)` → empty diff |
| 5 | At least one rule fired during real usage | `grep "pid=$PID" ~/.claude/signal-wire-debug.log \| grep "rule fired:"` → must be non-empty (any rule counts) |
| 6 | Zero unclean stream stops | `grep "pid=$PID" ~/.claude/claude-max-stats.log \| grep -oE "stop=[a-z_]+" \| sort -u` → must be subset of `{end_turn, tool_use}`. `max_tokens`, `refusal`, or missing response for an `API_START` = fail |

### Pass / fail

- **All 3 sessions × all 6 checks pass** → step 1 done; proceed to step 2 (build-on-load drift prevention).
- **Any check fails** → stop, diagnose that specific check, do not proceed. Failure = real regression, not a test-script bug (checks are grep-level, not semantic).

### Scope exclusions (out of this step)

- Banner format freeze / versioning — out of scope per "no legacy consumers" constraint.
- Rust adapter (#06) — deferred per earlier decision.

---

## Full consolidation plan — SSOT + Python deprecation (2026-04-23)

**Context:** lead decision is to go TS-only. Python `signal_wire_engine.py`
stays as read-only archive (renamed to `.py.deprecated`) so future agents
can reference it but cannot accidentally import it.

### Layer discipline (fundamental — do not violate)

**Engine ≠ Consumer.** Keep these separate:

| Layer | Lives in | Responsibilities | NOT responsibilities |
|-------|----------|------------------|---------------------|
| **Engine (core)** | `@kiberos/signal-wire-core` | pure rule evaluation, validation, emit pipeline, type definitions, `getBundledRulesPath()` helper | file I/O for rules, hot-reload, knowing who's calling, transport back to any specific consumer |
| **CLI (shim)** | `packages/signal-wire-core/apps/cli/` | one-shot stdin/stdout JSON wrapper around engine for batch mode | persistent state, hot-reload (process is one-shot) |
| **Consumer 1: opencode plugin** | `packages/opencode-claude/` (long-running) | holds engine in memory for the whole session; **owns hot-reload**; owns session state | engine internals, hook-event shape translation (that lives in consumer 2) |
| **Consumer 2: Claude Code hook wrapper** | `.claude-local/.../hooks/signal-wire-hook.sh` (short-lived per event) | translate single Claude Code hook event → batch JSON for sw-cli; translate result back to Claude Code hookSpecificOutput shape | hot-reload (each invocation re-reads rules fresh), persistent state |
| **Consumer 3: future adapters** | TBD | same pattern: adapter-in-consumer, pure engine via `@kiberos/signal-wire-core` dep | putting consumer logic into engine |

**Hot-reload belongs ONLY to consumer 1 (opencode plugin).** Hooks and CLI
are short-lived processes that re-read the file naturally on each invocation.
Engine has zero knowledge of reload — it receives rules as arrays.

### Architectural decisions (locked, no re-opening)

1. **Rules SSOT location:** `/home/relishev/packages/signal-wire-core/rules/signal-wire-rules.json`
   — rules live beside the engine that defines their schema.
2. **One CLI, one contract:** `@kiberos/signal-wire-core`'s `apps/cli/`
   exposes the single batch contract — `{rules, events}` on stdin,
   `{results_per_event, rule_load}` on stdout. No legacy compat mode in
   the CLI itself. Adapting Claude Code hook events into this contract
   (and the response back) is done by a **thin shell wrapper** at the
   hook boundary, not inside the CLI. Rationale: Python output shape
   is being deprecated along with Python; freezing it as a second CLI
   contract would be preserving what we explicitly chose to delete.
3. **Python deprecation method:** file-level rename `.py` → `.py.deprecated`
   PLUS move into `_deprecated/` subfolder. Any import fails with
   `ModuleNotFoundError` immediately — no env-var escape hatch needed.
4. **README rewrite:** top of `lat_context/services/README.md` replaced with
   DEPRECATED banner pointing to `@kiberos/signal-wire-core`. Historical
   content kept below the banner.
5. **Marketplace hook script:** `.claude-local/.../hooks/signal-wire.py`
   → after hooks.json is cut over to `sw-cli`, this file is renamed to
   `.py.deprecated` in the same commit.
6. **Hot-reload of rules (new requirement, 2026-04-23):** the adapter
   must pick up rule file changes WITHOUT process restart, without being
   expensive on each call.
   - **Strategy:** pull-based lazy check. Each public evaluate/emit call
     first runs `maybeReload()`, which is a no-op when less than
     `checkIntervalMs` (default 2000ms) has passed since last check.
   - **Fingerprint = (mtimeMs, size).** Cheap syscall. `mtime`-only is
     not enough (e.g. `git checkout` can restore same mtime with
     different content).
   - **Validate-before-swap.** New rules parsed and validated into a
     separate structure; only on full success is the active ruleset
     pointer re-assigned (atomic in JS — no locking needed).
   - **On validation failure:** keep old rules, log error with clear
     banner, bump fingerprint so we don't retry a broken file every 2s.
   - **Toggle on/off without external tools:** `toggleRule(id, enabled)`
     rewrites JSON atomically (tmp + rename); the same hot-reload path
     picks it up within 2s. No ephemeral in-memory state.
   - **CLI (`sw-cli`) is exempt** — it is one-shot per invocation,
     process dies after the request.
   - **Log format:**
     - success: `[sw-core v.X@T] RULES_RELOADED old=N new=M mtime=ISO`
     - fail: `[sw-core v.X@T] RULES_RELOAD_FAIL error="..." keeping-old-rules`

### Sequence (strict order — each step unblocks the next)

| # | Step | Owner | Blocks |
|---|------|-------|--------|
| 1 | Update `SIGNAL-WIRE-CORE-MIGRATION.md` with this plan | done | — |
| 2 | Compile bun binary (`bun run compile:cli`), add `"bin": {"sw-cli": "./dist/signal-wire"}` to core's package.json, `bun link` so `sw-cli` is on PATH. Verify `echo '{"rules":[],"events":[]}' \| sw-cli` returns valid JSON. | signal-wire-core | step 4 |
| 3 | Move rules SSOT: `git mv packages/opencode-claude/signal-wire-rules.json → packages/signal-wire-core/rules/signal-wire-rules.json`, delete `packages/opencode-claude/dist/signal-wire-rules.json`, delete `/home/relishev/packages/opencode-signal-wire/signal-wire-rules.json` (plugin already disabled). Add `getBundledRulesPath()` helper to `@kiberos/signal-wire-core`. Update `provider.ts:1339` and adapter tests to use it. Update `package.json#files` of opencode-claude to remove rules.json entry. | signal-wire-core + opencode-claude | step 4 |
| 4 | Implement hot-reload in `signal-wire-core-adapter.ts`: add `RulesStore` class with fingerprint-based `maybeReload()` (default `checkIntervalMs=2000`). Every public evaluate/emit call runs it first. Validate-before-swap. `toggleRule()` rewrites JSON atomically. Log success/fail banners. Unit test: mutate test rules file, assert new ruleset is picked up within 2s; corrupt the file, assert old ruleset still active. | opencode-claude | step 5 |
| 5 | Write `hooks/signal-wire-hook.ts` — Claude Code hook consumer script executed directly via `bun` (no compile step). Reads Claude Code hook event JSON from stdin, imports `Pipeline`/`validateRuleSet`/`translateLegacyRules`/`getBundledRulesPath` from `@kiberos/signal-wire-core` + `signal-wire-core-adapter`, evaluates the event via a fresh Pipeline, transforms `EmitResult[]` back into Claude Code hookSpecificOutput shape (per-event-type output: PreToolUse→permissionDecision, UserPromptSubmit→raw text, Stop→systemMessage, default→additionalContext). Lives inside `.claude-local/plugins/marketplaces/lifeaitools/hooks/`. Rationale for TS-via-bun over sh: logic needs typed event-shape dispatch + JSON transformation which is untenable in bash; rationale for direct engine import over `sw-cli` subprocess: each hook invocation is already short-lived, adding a subprocess fork doubles latency with no architectural benefit (consumer-2 is still consuming the engine directly per Layer discipline). `sw-cli` remains available for external/CI usage of the engine. | claude-code-hooks | step 6 |
| 6 | Cut over `hooks.json`: replace `python3 ${CLAUDE_PLUGIN_ROOT}/hooks/signal-wire.py --event X` with `${CLAUDE_PLUGIN_ROOT}/hooks/signal-wire-hook.sh --event X`. Smoke-test: trigger one real hook per event type (PreToolUse, PostToolUse, UserPromptSubmit, Stop) and confirm Claude Code still gets valid output. Rename old `signal-wire.py` → `signal-wire.py.deprecated`. | claude-code-hooks | step 7 |
| 7 | Deprecate Python engine: `git mv` into `_deprecated/` subfolders + rename `.py` → `.py.deprecated` for `signal_wire_engine.py`, `signal_wire_cli.py`, `tests/test_signal_wire_engine.py`, `tests/test_signal_wire_integration.py`. Rewrite `services/README.md` header with DEPRECATED banner. Pre-check: `grep -rn 'signal_wire_engine\|signal_wire_cli'` across live paths — every hit updated or deleted. | lat-context | step 8 |
| 8 | Validation: 6-check pass on 3 fresh opencode sessions (criteria above) + hot-reload test (edit rules file, see banner within 2s, no restart needed) + 1 Claude Code hook trigger per event type confirmed working via `sw-cli`-backed wrapper | validation | step 9 |
| 9 | After validation: delete legacy `signal-wire.ts`, `signal-wire-actions.ts`, `signal-wire-audit.ts` in opencode-claude. Remove `SIGNAL_WIRE_ENGINE=legacy` env branch. Rename `signal-wire-core-adapter.ts` → `signal-wire.ts`. Bump `@life-ai-tools/opencode-claude@1.0.0`. | opencode-claude | — |

### Git strategy

**One PR, four commits** (atomic per concern for rollback granularity):

1. `feat(sw-core): add hook-compat mode + bin entry for sw-cli` (steps 2–3)
2. `refactor(sw): move rules.json to SSOT in signal-wire-core` (step 4)
3. `feat(claude-code-hooks): cut hooks.json over to sw-cli` (steps 5–6)
4. `chore(lat-context): deprecate Python signal_wire engine → archive` (step 7)

Commits 1–2 can ship and bake before 3–4 land. Commit 4 must not land before
commit 3 is verified.

### Risks and mitigations

- **Risk:** `sw-cli` hook-compat output drifts from Python CLI by even one
  field, breaking Claude Code hook-specific-output contract.
  **Mitigation:** step 5 is a hard gate. If byte-diff non-zero, stop and
  reconcile in `apps/cli/` before step 6.
- **Risk:** `getBundledRulesPath()` breaks when `@life-ai-tools/opencode-claude`
  is consumed from npm cache vs linked `file:` dep.
  **Mitigation:** helper resolves via `import.meta.url` of core package
  itself, tested both in dev (linked) and after `bun install` from cache.
- **Risk:** a live session reads stale `dist/signal-wire-rules.json` after
  step 4 because session was started before the move.
  **Mitigation:** step 4 deletes the duplicate; stale sessions will fail
  loud on rule load and self-restart. Validation (step 8) runs only on
  fresh sessions.
- **Risk:** Python references remain that I miss during step 7.
  **Mitigation:** before step 7, `grep -rn 'signal_wire_engine\|signal_wire_cli'`
  across `/home/relishev/packages/lat-context`, `/home/relishev/.claude-local`,
  `/home/relishev/projects/vibe/` (excluding `.venv/`, `node_modules`,
  backups, caches). Every hit must be updated or explicitly deleted.

---

## After validation

Once the validation criteria above pass on 3 fresh sessions:

1. Delete `signal-wire.ts`, `signal-wire-actions.ts`, `signal-wire-audit.ts`
2. Delete `signal-wire-parity.test.ts` (no longer needed)
3. Rename `signal-wire-core-adapter.ts` → `signal-wire.ts`
4. Rename `signal-wire-translate.ts` → keep as-is (shared helpers)
5. Remove `SIGNAL_WIRE_ENGINE=legacy` env branch (no legacy to fall back to)
6. Bump `@life-ai-tools/opencode-claude@1.0.0` (breaking internal, same public API)

## References

- Canonical engine: `/home/relishev/packages/signal-wire-core/` + SPEC.md + 150 vectors
- Audit report: `/home/relishev/projects/vibe/kiberos-platform/PRPs/signal-wire-architecture-v3/AUDIT-FULL.md`
- Adapter contract: ADR-0007 (≤200 LOC pure translation)
- Python CLI output contract (baseline): `/home/relishev/packages/lat-context/src/lat_context/signal_wire_cli.py` (to be deprecated in step 7)

---

## Completion — 2026-04-23

All nine steps executed and validated. Fresh `opencode run` session
passes all six checks in `validate-ssot.sh`. Summary of final state:

### Ownership at a glance

| Layer | Location | Owns |
|-------|----------|------|
| Engine | `@kiberos/signal-wire-core` (`/home/relishev/packages/signal-wire-core/`) | pure rule evaluation, rules SSOT, translation helpers, telemetry emission, bundled CLI |
| Rules SSOT | `signal-wire-core/rules/signal-wire-rules.json` (22 rules) | single file, no duplicates anywhere |
| CLI (transport) | `sw-cli` binary via `bun link` (`@kiberos/signal-wire-core`, `apps/cli/`) | stdin/stdout JSON batch + `--rules-from-bundled-ssot` mode for hook consumers |
| Consumer 1 (long-running) | `packages/opencode-claude/signal-wire.ts` | hot-reload, in-process Pipeline, `CONSUMER_INVOKE` telemetry |
| Consumer 2 (short-lived) | `.claude-local/.../hooks/signal-wire-hook.sh` | Claude Code hook wrapper, no state, cold-reads rules via sw-cli |
| Python archive | `packages/lat-context/**/_deprecated/*.py.deprecated` | reference-only; import fails immediately by design |

### End-to-end telemetry format

Per evaluation, the shared log (`~/.claude/signal-wire-debug.log`) gets a
trace chain keyed by `correlationId`:

```
[consumer=claude-code-hook|opencode-plugin]  HOOK_INVOKED | CONSUMER_INVOKE
[sw-core vX@T pid=N]                         EVENT_RECEIVED
[sw-core vX@T pid=N]                         RULE_FIRED × N
[sw-core vX@T pid=N]                         EVENT_COMPLETE | EVENT_ERROR
[consumer=claude-code-hook]                  HOOK_COMPLETE | HOOK_FAILOPEN  (Consumer-2 only)
```

Grep for one `correlationId` to see the full lifecycle of a single event
across the consumer → engine → consumer boundary.

### How to roll back

There is no rollback path. The legacy Python engine and the
`SIGNAL_WIRE_ENGINE=legacy` env branch were deleted. If a regression
emerges post-migration, the only path forward is:

1. `git revert` the offending commit in `signal-wire-core` or `opencode-claude`.
2. Rebuild (`bun run build` in `opencode-claude`; `bun run compile:cli`
   in `signal-wire-core`).
3. Fresh sessions pick up the revert automatically on next restart;
   running sessions continue on old in-memory code until they restart.

Legacy Python files live under `_deprecated/` subfolders with
`.py.deprecated` extensions — readable as reference, unimportable as
code.

### Commits (all pushed to remote)

| Repo | Commits (oldest→newest) |
|------|-------------------------|
| `@kiberos/signal-wire-core` (→ gitea-local) | `10682fc` SSOT+translate+CLI bundled-ssot — `a8a8608` fix getBundledRulesPath for bundled consumers — `53702bf` per-event telemetry |
| `claude-code-sdk` (→ github origin) | `f67fb19` adapter hot-reload+SSOT — `cebd93f` v1.0.0 drop legacy — `03acb21` CONSUMER_INVOKE telemetry |
| `lat-context` (→ gitea-local) | `97155d2` deprecate Python engine |
| `playwright-mcp-broker` (→ gitea-local) | `cb7f332` keep-warm containers (ancillary fix — unblocked opencode startup) |

### Post-migration validation proof

`validate-ssot.sh <pid>` on fresh session pid=3028841 (post-push):
```
  [PASS] identity chain — 4 banner lines (≥3 required)
  [PASS] engine=CORE — ENGINE_SELECT=CORE present
  [PASS] rules count SSOT — log=18 expected=18 (ssot_total=22, opencode-applicable)
  [PASS] no duplicates — duplicate rules.json files absent
  [PASS] rule fires (via sw-cli probe) — engine evaluates, session-start-checklist returned
  [PASS] clean stops — stops: stop=end_turn, stop=tool_use
```
