/**
 * quota-paths — SSOT for the quota-pipeline file contract.
 *
 * The quota pipeline is 3 decoupled stages that run in DIFFERENT processes:
 *
 *   emitter (in-proxy)  →  claude-max-stats.jsonl  →  processor (own service)
 *                                                       ↓
 *   injector (hook)     ←  quota-status.json       ←──┘
 *
 * Because the stages live in separate processes (so processor/injector logic
 * can be hot-restarted WITHOUT cooling the proxy's warmed KA sessions), they
 * cannot share runtime state — only these on-disk paths. This module is the
 * single place those paths + the wire-schema version are defined, imported by
 * both stats-emitter.ts (writer) and quota-watcher.ts (reader). Change a path
 * here and both stages move together; no drift.
 */

import { homedir } from 'os'
import { join } from 'path'

export const CLAUDE_LOCAL = join(homedir(), '.claude-local')

/** Stage 1→2 contract: append-only stats stream (emitter writes, processor tails). */
export const STATS_JSONL = join(CLAUDE_LOCAL, 'claude-max-stats.jsonl')

/** Stage 2→3 contract: computed quota snapshot (processor writes atomically, injector reads). */
export const QUOTA_STATUS_JSON = join(CLAUDE_LOCAL, 'quota-status.json')

/** Injector's corruption fallback: last known-good snapshot, retained across bad reads. */
export const QUOTA_STATUS_LAST_GOOD = join(CLAUDE_LOCAL, 'quota-status.last-good.json')

/** Processor's token-change audit log (re-login / refresh events). */
export const TOKEN_EVENTS_JSONL = join(CLAUDE_LOCAL, 'token-events.jsonl')

/**
 * Wire-schema version of a stats line. Bumped only on a BREAKING change to the
 * stats line shape. Emitter stamps every line `v: STATS_SCHEMA_VERSION`; the
 * processor rejects (skips + logs) any line whose `v` it does not understand,
 * so a future emitter format never silently corrupts a running processor.
 */
export const STATS_SCHEMA_VERSION = 1
