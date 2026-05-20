/**
 * cache-config — SSOT for Anthropic prompt-cache breakpoint configuration.
 *
 * This module is the **SINGLE SOURCE OF TRUTH** for `cache_control` object
 * literals used anywhere in this package. After PRP rev 1.4.0:
 *
 *   - **ZERO** inline `{ type: 'ephemeral', ttl: '1h' }` literals are allowed
 *     in any other file in this package. All consumers MUST import
 *     `CACHE_CONTROL_1H` from here (CR-11).
 *
 *   - `BREAKPOINT_INVENTORY` documents Anthropic's hard 4-breakpoint cap and
 *     records every site in the wire payload where this package (or its
 *     dependencies / opencode core) stamps a `cache_control` marker (DB-13,
 *     CN-08). Adding a 5th breakpoint anywhere — even transiently — requires
 *     **removing one from this list FIRST**. The inventory is the contract,
 *     the code is the consequence.
 *
 *   - `CACHE_CONTROL_TTL` is env-overridable (`CACHE_CONTROL_TTL=5m` etc.) so
 *     developers can iterate on cache invalidation behaviour without code
 *     changes — useful for fast invalidation testing during development
 *     (DB-09). Production deployments leave it unset and inherit the
 *     `'1h'` default.
 *
 * Extended in Claude-Code-Discipline SDK PRP rev 1.1.0 (Phase 1, Task 1.8):
 *
 *   - `CACHE_CONTROL_GLOBAL_1H` — adds `scope: "global"` for the global
 *     instruction block (slot 1 of `BREAKPOINT_INVENTORY`). Consumed by
 *     `system-blocks.ts` in Phase 2 when `cache_scope_global_enabled` flag
 *     is on (REQ-01, CR-03 — beta-gated).
 *
 *   - `chooseTTL()` — pure function mirroring native CC `o85()` semantics
 *     from cli.js 2.1.112. Selects `"5m"` vs `"1h"` based on `querySource`
 *     allowlist + overage state + env overrides. Wired through provider.ts
 *     in Phase 2 task 2.4; Phase 1 lands the signature + default impl
 *     (REQ-02, CR-04 — must stay pure, CN-08 — no raw `ttl:"1h"` literals
 *     allowed outside this SSOT module).
 *
 *   - `BREAKPOINT_INVENTORY[0].position` naming refactor: "global CLAUDE.md
 *     block" → "global instruction block" per DB-06 (slot 1 content can be
 *     CLAUDE.md OR AGENTS.md OR plugin-injected; abstraction must not leak
 *     filename).
 *
 * Pure-constants module + ONE IO-touching helper (`isUsingOverage`):
 *
 *   - Constants (CACHE_CONTROL_*, BREAKPOINT_INVENTORY, DEFAULT_TTL_1H_ALLOWLIST):
 *     NO IO, NO side effects, NO imports from other source files in this package.
 *   - `chooseTTL()`: pure function (CR-04) — same inputs → same output.
 *   - `isUsingOverage()`: tail-only-read helper that consults
 *     `~/.claude-local/claude-max-stats.jsonl` to detect rate-limit overage.
 *     Cached 60s. Conservative on failure (returns false). Adopted into this
 *     module (rather than a separate `overage-detector.ts`) because TTL
 *     selection is the SOLE consumer of overage state — co-locating the
 *     helper next to `chooseTTL` keeps the dependency tree shallow and
 *     makes the policy-vs-detection seam obvious. Phase 2 task 2.4 wires
 *     `chooseTTL(querySource, isUsingOverage())` through provider.ts.
 *
 * Lives at the bottom of the dependency graph: only `node:fs` + `node:os`
 * + `node:path` for the IO helper; ZERO imports from other source files
 * in this package.
 *
 * @see PRP opencode-cache-prefix-stability rev 1.4.0
 * @see PRP claude-code-discipline-sdk rev 1.1.0
 * @see REQ-01, REQ-02, REQ-16, CR-04, CR-11, CN-08, DB-06, DB-09, DB-13
 */

import { openSync, readSync, closeSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logEvent } from "./log-event.js";

/**
 * TTL string passed to Anthropic's `cache_control.ttl` field.
 *
 * Defaults to `'1h'` (Anthropic's 1-hour ephemeral cache tier). Override
 * via the `CACHE_CONTROL_TTL` env var for development iteration — e.g.
 * `CACHE_CONTROL_TTL=5m` for fast invalidation testing. Production leaves
 * this unset.
 */
export const CACHE_CONTROL_TTL: string = process.env.CACHE_CONTROL_TTL || "1h";

/**
 * The ONE allowed `cache_control` marker for inline use in this package.
 *
 * Frozen at module load so accidental mutation throws in strict mode.
 * Every consumer that stamps a cache breakpoint on a content block MUST
 * reference this constant — no inline literals (CR-11).
 *
 * Currently consumed by the new global CLAUDE.md system block (Task 3.1,
 * slot 1 of `BREAKPOINT_INVENTORY`).
 */
export const CACHE_CONTROL_1H = Object.freeze({
  type: "ephemeral" as const,
  ttl: CACHE_CONTROL_TTL,
});

/**
 * `cache_control` marker with `scope: "global"` for cross-workspace cache
 * sharing on the global instruction block (slot 1 of BREAKPOINT_INVENTORY).
 *
 * Requires the `prompt-caching-scope-2026-01-05` beta in request headers
 * (CR-03) — without the beta the server may reject or silently ignore the
 * field. Phase 2 (task 2.3) switches `system-blocks.ts` to emit this constant
 * instead of `CACHE_CONTROL_1H` for the global block when
 * `cache_scope_global_enabled` runtime flag is on.
 *
 * Per CN-06: the byte-content of the cached block MUST stay identical across
 * processes when `scope: "global"` is used — no per-PID / per-session
 * substrings allowed in the block body.
 *
 * @see REQ-01, CR-03, CN-06
 */
export const CACHE_CONTROL_GLOBAL_1H = Object.freeze({
  type: "ephemeral" as const,
  ttl: CACHE_CONTROL_TTL,
  scope: "global" as const,
});

/**
 * Default querySource patterns that select the 1h cache TTL.
 *
 * Mirrors native CC `o85()` allowlist from cli.js 2.1.112. Pattern semantics:
 *   - trailing `*` → prefix match (e.g. `"repl_main_thread*"` matches
 *     `"repl_main_thread_xyz"`)
 *   - no `*` → exact match
 *
 * Frozen + readonly so consumers cannot mutate the package-wide default.
 * Phase 2 task 2.5 will add an env-overridable variant
 * (`parseAllowlistEnv()`); for Phase 1 only the static default ships.
 *
 * @see REQ-02, CR-04
 */
const DEFAULT_TTL_1H_ALLOWLIST: readonly string[] = Object.freeze([
  "repl_main_thread*",
  "sdk",
  "auto_mode",
]);

/**
 * Pure helper — checks whether `querySource` matches any pattern in
 * `allowlist`. Trailing-`*` patterns are treated as prefix matches; all
 * other patterns require exact string equality.
 *
 * No IO, no globals, no side effects. Same inputs always produce same
 * output (CR-04).
 */
function matchAllowlist(querySource: string, allowlist: readonly string[]): boolean {
  return allowlist.some((p) =>
    p.endsWith("*") ? querySource.startsWith(p.slice(0, -1)) : querySource === p,
  );
}

/**
 * Choose `cache_control.ttl` for an emission based on `querySource` and
 * the current overage state.
 *
 * Mirrors native CC `o85()` from cli.js 2.1.112 — when the user is in
 * overage (rate-limited) the server prefers the cheaper 5m tier; otherwise
 * a curated allowlist of "long-lived" query sources (REPL main thread, SDK
 * direct callers, auto-mode runners) gets the long-lived tier; everything
 * else (one-shot scripts, ad-hoc helpers) gets the 5m tier.
 *
 * Env overrides (developer escape hatches, NOT production policy):
 *
 *   - `FORCE_PROMPT_CACHING_5M=<any-truthy>` → always `"5m"`. Takes
 *     precedence over everything (used for fast-invalidation testing).
 *   - `ENABLE_PROMPT_CACHING_1H=<any-truthy>` → always `"1h"`. Takes
 *     precedence over allowlist + overage (used when reproducing a
 *     1h-cache bug regardless of caller identity).
 *
 * The env-override precedence matches native CC: 5m force wins over 1h
 * force (safer-by-default if both set by mistake).
 *
 * **Pure function** per CR-04: no IO, no globals, no side effects. Same
 * `(querySource, isOverage, effectiveTtl)` + same env state → same output.
 *
 * **Phase 2.5 — effectiveTtl parameter (TTL profile sync with keepalive.json):**
 * The long-lived tier returned for allowlist matches used to be hardcoded
 * `"1h"`. Operators who want to test a 5m TTL profile (per PRP F4) must
 * keep `~/.claude-local/keepalive.json:cacheTtlSec` and provider-side TTL
 * in sync — otherwise provider writes 1h cache while proxy keep-alive
 * fires every 30 min, leaving cache cold every turn. The `effectiveTtl`
 * arg lets the caller pass an IO-derived value (typically via
 * {@link getEffectiveTtl}) WITHOUT polluting this function's purity.
 * Default `"1h"` keeps backward compatibility — callers that don't pass
 * the arg get the legacy behaviour.
 *
 * **IO discipline:** keeping `chooseTTL` pure (CR-04) means the caller
 * decides whether to pay the IO cost of reading keepalive.json. Typical
 * call site: `chooseTTL(qs, isUsingOverage(), getEffectiveTtl())`.
 *
 * **Overage source of truth:** callers obtain `isOverage` by invoking
 * {@link isUsingOverage} (the IO-touching helper in this module) at the
 * call site. This decoupling is intentional — `chooseTTL` stays pure for
 * test-determinism, while the JSONL-reading detector is exercisable in
 * isolation with mock files.
 *
 * Phase 1 lands this with the static `DEFAULT_TTL_1H_ALLOWLIST`. Phase 2
 * task 2.4 wires this through `provider.ts` so every `cache_control`
 * emission on non-global slots routes through this function (CN-08 — no
 * raw `ttl: "1h"` literals allowed to bypass it). Phase 2.5 adds the
 * `effectiveTtl` parameter to coordinate with proxy's keepalive.json SSOT.
 *
 * @param querySource caller identity string (e.g. `"repl_main_thread_abc"`,
 *                    `"one-shot-helper"`, `"sdk"`)
 * @param isOverage whether the user is currently in rate-limit overage.
 *                  Typical call site: `chooseTTL(qs, isUsingOverage())`.
 * @param effectiveTtl the TTL to return for allowlist matches (Phase 2.5).
 *                     Default `"1h"`. Caller passes IO-derived value via
 *                     {@link getEffectiveTtl} to honor keepalive.json SSOT.
 * @returns the TTL string to use for this emission
 * @see REQ-02, CR-04, CN-08, AC-04.1
 */
export function chooseTTL(
  querySource: string,
  isOverage: boolean,
  effectiveTtl: "5m" | "1h" = "1h",
): "5m" | "1h" {
  if (process.env.FORCE_PROMPT_CACHING_5M) return "5m";
  if (process.env.ENABLE_PROMPT_CACHING_1H) return "1h";
  if (isOverage) return "5m";
  return matchAllowlist(querySource, DEFAULT_TTL_1H_ALLOWLIST) ? effectiveTtl : "5m";
}

// ─── Overage detection (IO-touching helper) ──────────────────────────────

/**
 * Override path for testing `isUsingOverage()` without touching the real
 * `~/.claude-local/claude-max-stats.jsonl`. Tests set this env var to a
 * fixture file path; production leaves it unset. Read at call time so
 * tests can flip it per case.
 */
const OVERAGE_STATS_PATH_ENV = "CLAUDE_MAX_STATS_PATH_OVERRIDE";

const DEFAULT_STATS_PATH = join(homedir(), ".claude-local", "claude-max-stats.jsonl");

/** Module-level 60s cache so we don't reread the JSONL on every emission. */
let cachedOverage: { value: boolean; expiresAt: number } | null = null;

/**
 * Module-level set of non-"allowed" rateLimit.status values already
 * announced via `LEDGER_OVERAGE_OBSERVED` console.warn. Prevents log spam
 * when the same overage state persists across many calls — but we still
 * announce the FIRST observation of each distinct status so the operator
 * sees a discoverability signal.
 */
const observedNonAllowedStatuses = new Set<string>();

/**
 * Bytes to read from the tail of the stats file. The JSONL file can grow
 * to 60MB+; reading only the last 4KB keeps this helper IO-cheap.
 * One stats record is ~150 bytes, so 4KB safely contains ≥20 trailing
 * entries — far more than the 1 we need.
 */
const TAIL_BYTES = 4096;

const OVERAGE_CACHE_MS = 60_000; // 60 seconds (per task spec)

/** Internal — clears the module-level cache. Exported for test reset. */
export function _resetOverageCache(): void {
  cachedOverage = null;
  observedNonAllowedStatuses.clear();
}

/**
 * Detect whether the user is currently in rate-limit overage by reading
 * the LAST entry of `~/.claude-local/claude-max-stats.jsonl` (the live
 * telemetry feed maintained by the keepalive / claim-tracker pipeline).
 *
 * **Conservative non-overage default** — any unrecoverable failure (file
 * missing, malformed JSON, no `rateLimit.status` field) returns `false`.
 * Rationale: a false-negative just keeps the 1h TTL path active, which is
 * what we want when we can't observe overage state; a false-positive
 * would needlessly downgrade everyone to 5m TTL on telemetry hiccups.
 *
 * **Overage trigger:** `rateLimit.status` exists AND is anything OTHER
 * than the string `"allowed"`. Observed value as of 2026-05-17: only
 * `"allowed"` appears in production traffic. Per OQ-03 we hypothesize
 * `"overage"` and/or `"limited"` are the non-allowed values; we DO NOT
 * enumerate them — any non-`"allowed"` string flips the helper to `true`.
 * The first observation of each distinct non-allowed status is announced
 * via `console.warn` with the marker `LEDGER_OVERAGE_OBSERVED` so the
 * operator can grep stderr to discover the actual schema.
 *
 * **Tail-only read (REQ-02 IO discipline):** uses `openSync` + `readSync`
 * on the last 4KB of the file — does NOT load the full file. A 60MB
 * stats file would otherwise force a multi-second sync read on every
 * provider emission.
 *
 * **60-second cache:** result memoised; subsequent calls inside the
 * window skip the file read. Cache is per-process — across process
 * restarts the helper re-reads on first call.
 *
 * **Not a bare-catch (CN-09):** the try/catch is observability infra:
 * on failure we emit `LEDGER_OVERAGE_READ_FAIL` to stderr with the
 * underlying error message. The fallback (return false) is the
 * conservative behaviour defined above, not silent swallowing.
 *
 * @returns `true` if rateLimit.status exists and is non-"allowed";
 *          `false` otherwise (including all failure modes).
 * @see REQ-02, CN-09, OQ-03 (claude-code-discipline-sdk PRP rev 1.1.0)
 */
export function isUsingOverage(): boolean {
  const now = Date.now();
  if (cachedOverage && cachedOverage.expiresAt > now) {
    return cachedOverage.value;
  }

  const statsPath = process.env[OVERAGE_STATS_PATH_ENV] || DEFAULT_STATS_PATH;
  let result = false;

  try {
    const st = statSync(statsPath);
    if (st.size === 0) {
      cachedOverage = { value: false, expiresAt: now + OVERAGE_CACHE_MS };
      return false;
    }

    // Tail-only read: open + read last TAIL_BYTES + close.
    const fd = openSync(statsPath, "r");
    try {
      const readLen = Math.min(TAIL_BYTES, st.size);
      const buf = Buffer.alloc(readLen);
      const offset = st.size - readLen;
      readSync(fd, buf, 0, readLen, offset);
      const tail = buf.toString("utf8");

      // Last non-empty line:
      const lines = tail.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length === 0) {
        result = false;
      } else {
        const lastLine = lines[lines.length - 1];
        // If we sliced into the middle of a line (file > TAIL_BYTES), the
        // FIRST line of the tail is likely partial — but the LAST line is
        // always whole because the writer appends with trailing newline.
        // Parse only the last; if it fails, fall through to false.
        const entry = JSON.parse(lastLine);
        const status: unknown = entry?.rateLimit?.status;
        if (typeof status === "string" && status !== "allowed") {
          result = true;
          // First-observation log per distinct status (avoids spam).
          if (!observedNonAllowedStatuses.has(status)) {
            observedNonAllowedStatuses.add(status);
            logEvent("LEDGER_OVERAGE_OBSERVED", { rate_limit_status: status });
          }
        } else {
          result = false;
        }
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    // Observability — NOT a bare-catch (CN-09). We emit a structured event
    // so the operator can grep events.jsonl for stats-file IO issues. The
    // fallback is the conservative non-overage default documented above.
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("LEDGER_OVERAGE_READ_FAIL", { error: msg });
    result = false;
  }

  cachedOverage = { value: result, expiresAt: now + OVERAGE_CACHE_MS };
  return result;
}

// ─── Phase 2.5 — keepalive.json TTL profile reader ───────────────────────

/**
 * Override path for testing `getEffectiveTtl()` without touching the real
 * `~/.claude-local/keepalive.json`. Tests set this env var to a fixture
 * file path; production leaves it unset. Read at call time so tests can
 * flip it per case.
 *
 * Mirrors the `CLAUDE_KEEPALIVE_CONFIG_PATH` env used by the main SDK's
 * `keepalive-config.ts` — but scoped to this package so test fixtures
 * don't bleed into the SDK's own resolver cache. Cross-package linkage
 * happens at runtime via `loadKeepaliveConfig()` from the SDK; here we
 * just read the raw JSON ourselves to keep the dependency tree shallow
 * (same pattern as `isUsingOverage` reading claude-max-stats.jsonl
 * directly rather than going through a wrapper).
 */
const KEEPALIVE_PATH_ENV = "CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE";

/**
 * Default location of keepalive.json. Operator may also have it at
 * `~/.claude/keepalive.json` (hardlink in current production setup) — both
 * resolve to the same inode. We pick `.claude-local` as the canonical
 * read path because that's what the PRP / docs reference as SSOT.
 */
const DEFAULT_KEEPALIVE_PATH = join(homedir(), ".claude-local", "keepalive.json");

/** Module-level 60s cache so we don't reread keepalive.json on every emission. */
let cachedEffectiveTtl: { value: "5m" | "1h"; expiresAt: number } | null = null;

const EFFECTIVE_TTL_CACHE_MS = 60_000;

/** Internal — clears the module-level cache. Exported for test reset. */
export function _resetEffectiveTtlCache(): void {
  cachedEffectiveTtl = null;
}

/**
 * Derive the cache TTL profile that operator has configured in
 * `~/.claude-local/keepalive.json`.
 *
 * **Why this exists (Phase 2.5):** the proxy reads keepalive.json for its
 * keep-alive cadence (`intervalSec`) AND its expected cache TTL
 * (`cacheTtlSec`). Without this helper, the provider side hardcoded `"1h"`
 * regardless of what operator put in the file — meaning a 5m test profile
 * would write 1h cache_control on the wire (mismatch invalidates the
 * empirical comparison). Now both sides read the same SSOT.
 *
 * **Behaviour:**
 *   - Env overrides (`FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H`)
 *     take precedence — they already gate `chooseTTL` itself, but we
 *     short-circuit here too so the cached value reflects the same
 *     decision the operator sees in stderr/jq.
 *   - Reads `~/.claude-local/keepalive.json` (or path from
 *     `CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE`).
 *   - `cacheTtlSec <= 600` (≤10min) → `"5m"`.
 *   - `cacheTtlSec >= 1800` (≥30min) → `"1h"`.
 *   - Middle zone (601..1799) → `"1h"` (conservative — better to
 *     over-commit cache lifetime than expire early).
 *   - File missing → `"1h"` (legacy default; current production runs 1h).
 *   - Parse error → `"1h"` + emit `LEDGER_KEEPALIVE_CONFIG_INVALID` via
 *     `logEvent` (file logger, not stderr — per CN-09 + the Phase 2.D
 *     UX fix we shipped).
 *
 * **60-second cache:** result memoised. Operator who edits keepalive.json
 * must wait ≤60s for the change to propagate to the provider side. Proxy
 * needs a restart anyway, so this isn't a real latency concern.
 *
 * **Not pure** — touches FS + module state. `chooseTTL` stays pure by
 * accepting the value as an arg; this is the IO seam that produces it.
 *
 * @returns `"5m"` or `"1h"` reflecting the configured profile.
 * @see PRP F4, CR-01, CN-09, CR-04
 */
export function getEffectiveTtl(): "5m" | "1h" {
  // Env overrides — match `chooseTTL`'s precedence so the cached effective
  // value never disagrees with what the pure function will pick. Cheap to
  // re-check on each call (env is process-local).
  if (process.env.FORCE_PROMPT_CACHING_5M) return "5m";
  if (process.env.ENABLE_PROMPT_CACHING_1H) return "1h";

  const now = Date.now();
  if (cachedEffectiveTtl && cachedEffectiveTtl.expiresAt > now) {
    return cachedEffectiveTtl.value;
  }

  const cfgPath = process.env[KEEPALIVE_PATH_ENV] || DEFAULT_KEEPALIVE_PATH;
  let result: "5m" | "1h" = "1h";

  try {
    const st = statSync(cfgPath);
    if (st.size === 0) {
      // Empty file is treated as legacy default — not an error.
      cachedEffectiveTtl = { value: "1h", expiresAt: now + EFFECTIVE_TTL_CACHE_MS };
      return "1h";
    }
    // Whole-file read is acceptable here: keepalive.json is tiny (≤2KB
    // in production). Unlike claude-max-stats.jsonl which grows to MBs,
    // a tail-only read for a 385-byte file would be pointless.
    const fd = openSync(cfgPath, "r");
    try {
      const buf = Buffer.alloc(st.size);
      readSync(fd, buf, 0, st.size, 0);
      const text = buf.toString("utf8");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const sec = parsed?.cacheTtlSec;
      if (typeof sec === "number" && Number.isFinite(sec)) {
        if (sec <= 600) {
          result = "5m";
        } else {
          // sec >= 601 → "1h" (covers both ≥1800 and the conservative
          // middle zone 601..1799).
          result = "1h";
        }
      }
      // Missing/non-numeric cacheTtlSec → result stays "1h" (legacy default).
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish "file missing" (silent fallback) from "parse / IO error"
    // (worth telemetry — operator may have malformed JSON they want to
    // know about). ENOENT path is the legacy default — don't spam.
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      logEvent("LEDGER_KEEPALIVE_CONFIG_INVALID", {
        path: cfgPath,
        error: msg,
      });
    }
    result = "1h";
  }

  cachedEffectiveTtl = { value: result, expiresAt: now + EFFECTIVE_TTL_CACHE_MS };
  return result;
}

/**
 * Documented inventory of the 4 `cache_control` breakpoints present in the
 * wire payload after this PRP ships. Anthropic enforces a hard cap of 4
 * breakpoints per request; we are at 4/4 (CN-08, DB-13).
 *
 * Slots 2-4 are stamped outside this package (opencode core, claude-code-sdk
 * helper) and are listed here purely as documentation so the total is
 * visible at a glance. Slot 1 is the only one this package owns.
 *
 * Slot 1 position naming uses the abstract term "global instruction block"
 * per DB-06: content can be CLAUDE.md OR AGENTS.md OR plugin-injected —
 * the abstraction must not leak a specific filename.
 */
export const BREAKPOINT_INVENTORY = Object.freeze([
  {
    slot: 1,
    position:
      "end of global instruction block (User-level rules: CLAUDE.md or AGENTS.md or plugin-injected)",
    file: "src/system-blocks.ts",
    source: "opencode-cache-prefix-stability PRP rev 1.4.0",
  },
  {
    slot: 2,
    position: "end of (project + opencode body) system block",
    file: "opencode core",
    source: "pre-existing — opencode core stamps",
  },
  {
    slot: 3,
    position: "end of last tool definition",
    file: "addCacheMarkers in claude-code-sdk",
    source: "pre-existing",
  },
  {
    slot: 4,
    position: "last tool_result in messages",
    file: "opencode core",
    source: "pre-existing — moves every turn",
  },
] as const);
