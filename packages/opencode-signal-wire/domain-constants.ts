/**
 * Domain constants for opencode-signal-wire bridge.
 *
 * Single Source of Truth for paths, thresholds, intervals, and env var names.
 * Hot-reloadable values (rule patterns, hint wrappers) live in
 * signal-wire-core/rules/signal-wire-rules.json. THIS file holds compiled-in
 * values consumed by TypeScript modules.
 *
 * Source: PRPs/agent-self-bootstrap/02-prd.md §Domain Constants (DC-01..DC-13).
 * Closes: CN-11 (magic numbers), SSOT-D/E (.opencode path, role names).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

// ─── Wake/discovery paths (DC-03..DC-06, DC-10, DC-11, DC-13) ────────────────

/** Root directory for wake-router runtime state. (DC-10) */
export const WAKE_ROOT = join(homedir(), '.opencode', 'wake')

/** Cached agent identity blobs, one file per deterministic key. (DC-11) */
export const AGENT_IDENTITY_DIR = join(homedir(), '.opencode', 'agent-identity')

/** Per-agent discovery files: ~/.opencode/wake/agents/<member_id>.json. (DC-03) */
export const WAKE_DISCOVERY_DIR = join(WAKE_ROOT, 'agents')

/** Append-only boot lifecycle audit log. (DC-04) */
export const BOOT_AUDIT_PATH = join(WAKE_ROOT, 'boot-audit.jsonl')

/** Append-only spawn audit log. (DC-05) */
export const SPAWN_AUDIT_PATH = join(WAKE_ROOT, 'spawn-audit.jsonl')

/** Optional org-wide system prompt prepended to layer 2 (org). (DC-06) */
export const ORG_PROMPT_PATH = join(WAKE_ROOT, 'org-prompt.md')

/** Optional identity policy override (force-oauth | force-agent | follow-env). (DC-13) */
export const IDENTITY_POLICY_PATH = join(WAKE_ROOT, 'identity-policy.json')

/** Operator-extensible spawn-rule glob path (T6: SpawnDecisionRule loader). */
export const SPAWN_RULES_GLOB = join(WAKE_ROOT, 'spawn-rules', '*.ts')

/** Layer separator in composed prompts (markdown horizontal rule, visible in TUI). (DC-07) */
export const LAYER_SEPARATOR = '\n\n---\n\n'

// ─── Spawn limits (DC-01, DC-02) ─────────────────────────────────────────────

/** Default max spawn depth; per-role override via OrgRole.metadata.spawn_depth_max. (DC-01) */
export const SPAWN_DEPTH_MAX = 3

/** Default max concurrent spawns per parent agent; per-role override via metadata. (DC-02) */
export const CONCURRENT_SPAWNS_MAX = 5

// ─── Lifecycle intervals (DC-08, NFR-04, NFR-11) ─────────────────────────────

/** Reaper sweep interval — janitorial GC of dead discovery files + old audit rotations. (DC-08) */
export const REAPER_INTERVAL_MS = 5 * 60_000

/** Supervisor sweep interval — checks for auto_run roles + stale agents. (DC-08) */
export const SUPERVISOR_INTERVAL_MS = 60_000

/** Wake-router HTTP health probe interval (T7). (NFR-11) */
export const WAKE_ROUTER_HEALTH_PROBE_MS = 30_000

// ─── Audit log rotation (AD-08, NFR-09) ──────────────────────────────────────

/** Threshold at which audit logs rotate to `<file>.rotated-<ISO>`. */
export const AUDIT_ROTATION_BYTES = 10 * 1024 * 1024

/** Rotated audit files retained for N days, then reaper unlinks. (AD-08) */
export const AUDIT_RETENTION_DAYS = 30

// ─── Spawn flow identity (AD-11) ─────────────────────────────────────────────

/** Length of correlation_id (12-char base32 ≈ 60 bits entropy). */
export const CORRELATION_ID_LENGTH = 12

/** Env var carrying correlation_id from parent to child opencode process. */
export const CORRELATION_ID_ENV_VAR = 'SW_SPAWN_CORRELATION_ID'

// ─── Bridge kill-switch (DC-12, AC-40) ───────────────────────────────────────

/** When set to "disabled", bridge interceptor is NOT installed; opencode's built-in task tool runs unchanged. Read ONCE at boot. */
export const SW_AGENT_SPAWN_ENV_VAR = 'SW_AGENT_SPAWN'
export const SW_AGENT_SPAWN_DISABLED_VALUE = 'disabled'
export const SW_AGENT_SPAWN_ENABLED_VALUE = 'enabled'

// ─── Health probe state (T7) ─────────────────────────────────────────────────

/** Number of consecutive health failures before emitting agent hint. (NFR-11) */
export const WAKE_ROUTER_FAIL_THRESHOLD = 2

// ─── Reusable inline magic numbers found in scope (from arch-scan SSOT-001..012) ──

/** quota-watcher.ts:71 — millisecond debounce on quota status reads. */
export const QUOTA_STATUS_DEBOUNCE_MS = 5000

/** quota-watcher.ts:70 — quota fresh-snapshot age window. */
export const QUOTA_STATUS_FRESH_MS = 200

/** signal-wire.ts:116 — RulesStore polling minimum interval (matches engine 2s). */
export const RULES_STORE_POLL_MS = 2000

/** signal-wire.ts:633 — SHA digest length (truncate to 256 chars / hex). */
export const SHA_OUTPUT_TRUNCATE_LEN = 256

/** wake-listener.ts:38 — discovery write retry backoff initial. */
export const DISCOVERY_RETRY_INITIAL_MS = 3000

/** wake-listener.ts:39 — discovery write retry backoff floor. */
export const DISCOVERY_RETRY_FLOOR_MS = 500

/** wake-listener.ts:458 — FNV-1a 32-bit prime (well-known constant; named for readability). */
export const FNV_32_PRIME = 2166136261

/** wake-listener.ts:1133 — agent heartbeat ttl multiplier (count of supervisor sweeps before marking stale). */
export const HEARTBEAT_STALE_SWEEPS = 120

/** agent-action-client.ts:23 — default action client request timeout ms. */
export const ACTION_CLIENT_TIMEOUT_MS = 5000

/** agent-action-client.ts:201 — retry attempt initial backoff ms. */
export const ACTION_CLIENT_RETRY_INITIAL_MS = 1000

/** hook-listener.ts:70 — render budget for packed hints (chars). */
export const RENDER_BUDGET_CHARS = 4000

/** plugin.ts:223 — wake-router /health response timeout ms. */
export const WAKE_ROUTER_PING_TIMEOUT_MS = 200
