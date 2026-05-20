/**
 * runtime-flags — provider-side reader for `~/.claude/runtime-flags.json`.
 *
 * **DB-18 alt-path (duplicate-with-discipline):** This file is an intentional
 * duplicate of the reader pattern at
 * `/home/relishev/packages/opencode-context-ledger/src/runtime-flags.ts`,
 * scoped to the subset of flags this package actually consumes.
 *
 * **SSOT preserved at FLAG VALUE level (CR-15), NOT at reader CODE level.**
 * Both readers point at the SAME on-disk file (`~/.claude/runtime-flags.json`,
 * per DB-15) and apply identical default semantics. The reader CODE is
 * intentionally duplicated to avoid a cross-monorepo runtime dependency:
 *   - plugin lives in `/home/relishev/packages/opencode-context-ledger`
 *   - provider lives in `/home/relishev/projects/vibe/claude-code-sdk/packages/opencode-claude`
 *
 * **Cross-reader consistency contract:** the two readers MUST produce
 * identical output for the same flag file. This is enforced by the
 * cross-reader test in `test/runtime-flags.test.ts` (the load-bearing
 * proof that the alt-path is safe).
 *
 * **Follow-up ticket `5239dfa1`** is filed to extract a shared package
 * once cross-monorepo packaging is feasible. Until then: any change to
 * the JSON schema MUST be applied to both readers in the same commit.
 *
 * Pure-IO module: only `fs` + `os` + `path`. No imports from other source
 * files in this package.
 *
 * @see PRP opencode-cache-prefix-stability rev 1.4.0
 * @see REQ-19, REQ-21, CR-15, DB-15, DB-18
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { logEvent } from "./log-event.js";

/**
 * Subset of runtime flags relevant to the provider. Keys NOT exposed here
 * (`ledger_dry_run`, `dump_bodies_full`, `enable_tool_summary_hint`) are
 * plugin-only concerns; intentionally omitted to keep the provider's
 * surface area tight.
 */
export interface RuntimeFlags {
  cache_prefix_split_enabled: boolean;
  prefix_health_alert_drop_threshold: number;
  prefix_health_alert_drop_consecutive: number;
  prefix_health_alert_stability_window: number;
  /**
   * Phase 2 kill-switch (claude-code-discipline-sdk PRP rev 1.1.0).
   * When true, the global instruction block (slot 1 of BREAKPOINT_INVENTORY)
   * gets `cache_control.scope: "global"` for cross-workspace cache sharing
   * via the `prompt-caching-scope-2026-01-05` beta.
   * Default false until 24h dry observation passes (REQ-01, CR-01).
   */
  cache_scope_global_enabled: boolean;
  /**
   * Phase 3 kill-switch (claude-code-discipline-sdk PRP rev 1.1.0).
   * When true:
   *   - plugin emits `LEDGER_CACHE_BREAK` events per turn with the 13-cause
   *     classification (matches native CC `tengu_prompt_cache_break`);
   *   - claude-max-proxy captures `ephemeral_5m_input_tokens` /
   *     `ephemeral_1h_input_tokens` / `cache_deleted_input_tokens` from
   *     `/v1/messages` response usage blocks into
   *     `claude-max-stats.jsonl` (subfields `cacheWrite5m`, `cacheWrite1h`,
   *     `cacheDeleted`).
   * Default true — observability is non-disruptive; flip false only if
   * observed performance impact (REQ-05, REQ-06, CR-01).
   */
  telemetry_v2_enabled: boolean;
}

const FLAGS_PATH = join(homedir(), ".claude", "runtime-flags.json");

/**
 * Defaults MUST match the plugin reader's defaults for the shared keys
 * (CR-15). If you change a default here, change it in
 * `opencode-context-ledger/src/runtime-flags.ts` in the same commit.
 */
const DEFAULTS: RuntimeFlags = {
  cache_prefix_split_enabled: true, // REQ-19 default ON
  prefix_health_alert_drop_threshold: 10000,
  prefix_health_alert_drop_consecutive: 3,
  prefix_health_alert_stability_window: 50,
  cache_scope_global_enabled: false, // Phase 2 kill-switch — default OFF (CR-01)
  telemetry_v2_enabled: true, // Phase 3 — default ON (observability is non-disruptive, CR-01)
};

/**
 * Schema (REQ-13). Known flags + expected JSON types. Includes BOTH the
 * provider-consumed keys AND the plugin-consumed keys, because the same
 * on-disk file is shared by both readers (CR-15 / DB-15). Unknown keys
 * are rejected; keys starting with `_` (e.g. `_doc`, `_<flag>_note`) are
 * passed through to preserve the inline-documentation convention.
 *
 * **Strategy (b) — selective underscore passthrough.** Picked over
 * enumerating each `_<flag>_note` as an optional schema field because:
 * - keeps the typed schema clean (only real flags listed)
 * - any new note added in the JSON Just Works without a schema bump
 * - still rejects accidental typos in real flag names
 *
 * **DO NOT** add Phase 2-6 flags here yet — only flags that exist in the
 * file today. Future flags must be added with their corresponding plugin
 * reader change in the same commit (CR-15 cross-reader consistency).
 */
const FLAG_TYPES = {
  // provider-consumed (typed via RuntimeFlags interface)
  cache_prefix_split_enabled: "boolean",
  prefix_health_alert_drop_threshold: "number",
  prefix_health_alert_drop_consecutive: "number",
  prefix_health_alert_stability_window: "number",
  cache_scope_global_enabled: "boolean", // Phase 2 PRP claude-code-discipline-sdk (REQ-01)
  telemetry_v2_enabled: "boolean", // Phase 3 PRP claude-code-discipline-sdk (REQ-05, REQ-06)
  // plugin-consumed (allowed in shared file; provider does not surface)
  ledger_dry_run: "boolean",
  dump_bodies_full: "boolean",
  enable_tool_summary_hint: "boolean",
  ledger_self_reflect_dry_run: "boolean",
} as const;

/**
 * Validate parsed JSON against {@link FLAG_TYPES}. Returns `null` on
 * success or an error message string on failure. Exported for unit
 * testing; production code calls it indirectly via {@link readFlags}.
 *
 * @internal
 */
export function validateFlags(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "runtime-flags.json: root must be a JSON object";
  }
  const types = FLAG_TYPES as Record<string, string>;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith("_")) continue; // doc/note passthrough (strategy b)
    const expected = types[key];
    if (!expected) {
      return `Unrecognized runtime flag: '${key}' (not in known schema)`;
    }
    if (typeof value !== expected) {
      return `Runtime flag '${key}' must be ${expected}, got ${typeof value}`;
    }
  }
  return null;
}

let _mtimeMs = 0;
let _cache: RuntimeFlags = { ...DEFAULTS };
let _hasRead = false;

/**
 * Read runtime flags from `~/.claude/runtime-flags.json`, mtime-cached.
 *
 * - File missing or unparseable: returns DEFAULTS (last-good cache if any).
 * - File present but schema-invalid (unknown key or wrong type): logs
 *   `LEDGER_RUNTIME_FLAGS_INVALID` to stderr and falls back to last-good
 *   cache or DEFAULTS. Does NOT crash plugin (REQ-13).
 * - Missing known keys in the JSON fall back to DEFAULTS per-key.
 * - No env-var overrides for these keys (mirrors plugin's intentional
 *   minimalism — only the original 3 plugin keys have env overrides).
 */
export function readFlags(): RuntimeFlags {
  try {
    const st = statSync(FLAGS_PATH);
    if (st.mtimeMs !== _mtimeMs || !_hasRead) {
      const parsed = JSON.parse(readFileSync(FLAGS_PATH, "utf8"));
      const schemaErr = validateFlags(parsed);
      if (schemaErr) {
        logEvent("LEDGER_RUNTIME_FLAGS_INVALID", {
          error: schemaErr,
          fallback: _hasRead ? "last-good cache" : "defaults",
        });
        _mtimeMs = st.mtimeMs; // skip re-validation until file mtime changes
        if (!_hasRead) _cache = { ...DEFAULTS };
        return { ..._cache };
      }
      _mtimeMs = st.mtimeMs;
      _hasRead = true;
      _cache = {
        cache_prefix_split_enabled:
          parsed.cache_prefix_split_enabled ??
          DEFAULTS.cache_prefix_split_enabled,
        prefix_health_alert_drop_threshold:
          parsed.prefix_health_alert_drop_threshold ??
          DEFAULTS.prefix_health_alert_drop_threshold,
        prefix_health_alert_drop_consecutive:
          parsed.prefix_health_alert_drop_consecutive ??
          DEFAULTS.prefix_health_alert_drop_consecutive,
        prefix_health_alert_stability_window:
          parsed.prefix_health_alert_stability_window ??
          DEFAULTS.prefix_health_alert_stability_window,
        cache_scope_global_enabled:
          parsed.cache_scope_global_enabled ??
          DEFAULTS.cache_scope_global_enabled,
        telemetry_v2_enabled:
          parsed.telemetry_v2_enabled ??
          DEFAULTS.telemetry_v2_enabled,
      };
    }
  } catch {
    // file missing or unparseable → keep last-good cache, or use DEFAULTS
    // if we've never read successfully.
    if (!_hasRead) {
      _cache = { ...DEFAULTS };
    }
  }
  return { ..._cache };
}

/** Convenience accessor — used by `system-blocks.ts` (Task 3.1). */
export function isCachePrefixSplitEnabled(): boolean {
  return readFlags().cache_prefix_split_enabled;
}

/**
 * Convenience accessor — Phase 2 kill-switch for `scope: "global"` on the
 * global instruction block (slot 1 of BREAKPOINT_INVENTORY).
 *
 * Consumed by `system-blocks.ts` (Phase 2 task 2.3). When true, the
 * provider emits `CACHE_CONTROL_GLOBAL_1H` (carrying `scope: "global"`)
 * instead of `CACHE_CONTROL_1H` for slot 1 — enabling cross-workspace
 * cache sharing via the `prompt-caching-scope-2026-01-05` beta.
 *
 * Default false until 24h dry observation gate passes (CR-01, REQ-01).
 *
 * @see PRP claude-code-discipline-sdk rev 1.1.0
 */
export function isCacheScopeGlobalEnabled(): boolean {
  return readFlags().cache_scope_global_enabled;
}

/**
 * Convenience accessor — Phase 3 kill-switch for v2 telemetry
 * (`LEDGER_CACHE_BREAK` events + `claude-max-stats.jsonl` subfield capture).
 *
 * Consumed by:
 *   - plugin's per-turn hook that wires `auditCacheBreak()` into the
 *     transform pipeline (Subtask 3.B);
 *   - `claude-max-proxy` response parser that splits
 *     `cache_creation.ephemeral_{5m,1h}_input_tokens` into stats entries.
 *
 * Default true — observability is non-disruptive (REQ-05, REQ-06, CR-01).
 *
 * @see PRP claude-code-discipline-sdk rev 1.1.0
 */
export function isTelemetryV2Enabled(): boolean {
  return readFlags().telemetry_v2_enabled;
}
