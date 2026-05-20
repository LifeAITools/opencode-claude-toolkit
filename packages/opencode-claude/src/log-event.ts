/**
 * log-event — minimal JSONL file logger for opencode-claude package.
 *
 * **Purpose:** route LEDGER_* telemetry events from this package into the
 * shared `~/.local/share/opencode/logs/context-ledger/events.jsonl` file
 * WITHOUT polluting stderr (which the opencode TUI renders as scary red
 * text overlapping user content — UX regression from Phase 2.D).
 *
 * **Why a separate logger here:** opencode-claude package cannot import
 * `opencode-context-ledger/src/logging.ts` per DB-18 (alt-path
 * constraint — opencode-context-ledger lives in a separate workspace
 * `/home/relishev/packages/`, not under this repo). Mirrors that
 * package's shape for cross-grep compatibility.
 *
 * **Shape:** matches opencode-context-ledger's `logEvent(step, details)`
 * convention. JSON object per line: `{ts, step, ...details}`. Events.jsonl
 * downstream consumers (`jq`, `quota-report.ts`) already grep by `.step`.
 *
 * **Fail-open:** if file/dir cannot be written (disk full, permission,
 * fs error), the function silently drops the event. Telemetry MUST NOT
 * break the request flow (CR-08 fail-open inheritance from prior PRPs).
 *
 * **Kill-switch:** when env `LEDGER_TELEMETRY_VERBOSE=0` is set, ALL
 * emissions skipped at function entry. Cheap NO-OP. Preserves operator
 * escape hatch documented in Phase 2.D.
 *
 * @see CR-01 (kill-switch), CR-11 (telemetry per phase), CN-09 (no bare-catches)
 * @see /home/relishev/PRPs/claude-code-discipline-sdk.md REQ-04, NFR-07
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LOG_DIR = path.join(os.homedir(), ".local", "share", "opencode", "logs", "context-ledger");
const EVENTS_LOG = path.join(LOG_DIR, "events.jsonl");

let _dirEnsured = false;

function ensureDir(): boolean {
  if (_dirEnsured) return true;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    _dirEnsured = true;
    return true;
  } catch (err) {
    // Cannot create log dir — fall back to no-op silently. Once we fail
    // we keep _dirEnsured=false so each subsequent call also tries (in
    // case disk recovers); but never throw or write to stderr.
    void err;
    return false;
  }
}

/**
 * Append a structured event line to events.jsonl.
 *
 * @param step Event step name (e.g. "LEDGER_SYSTEM_BLOCK_LAYOUT")
 * @param details Object merged into the entry (excluding `ts`/`step` which we set)
 */
export function logEvent(step: string, details: Record<string, unknown> = {}): void {
  // Kill-switch: operator can disable all verbose telemetry via env var.
  // Reading env is cheap; no caching needed (env is process-local
  // immutable for the run).
  if (process.env.LEDGER_TELEMETRY_VERBOSE === "0") return;

  if (!ensureDir()) return;

  const entry = {
    ts: new Date().toISOString(),
    step,
    ...details,
  };

  let line: string;
  try {
    line = JSON.stringify(entry) + "\n";
  } catch (err) {
    // Non-serializable details (e.g. circular ref). Drop event silently
    // — telemetry must not break the request flow.
    void err;
    return;
  }

  try {
    fs.appendFileSync(EVENTS_LOG, line);
  } catch (err) {
    // Disk full, EACCES, ENOENT (dir removed between ensureDir + append)
    // — drop event silently per CR-08 fail-open inheritance.
    void err;
  }
}
