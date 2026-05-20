// Runtime feature flags read live from disk.
//
// Edit ~/.claude/runtime-flags.json to toggle features without restarting opencode.
// File is mtime-cached — re-parsed only when changed. Cheap to call on every hook fire.
//
// Defaults (file missing): ledger_dry_run=true, dump_bodies_full=true
// — so out-of-the-box you get safe observation mode.
//
// Env vars (LEDGER_DRY_RUN=0 etc) override the file ONLY if explicitly "0" or "1".
// Otherwise the file (or its absence → defaults) wins.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RuntimeFlags {
  ledger_dry_run: boolean;
  dump_bodies_full: boolean;
}

const FLAGS_PATH = join(homedir(), ".claude", "runtime-flags.json");

const DEFAULTS: RuntimeFlags = {
  ledger_dry_run: true,
  dump_bodies_full: true,
};

let _mtimeMs = 0;
let _cache: RuntimeFlags = { ...DEFAULTS };
let _hasRead = false;

function envOverride(key: string): boolean | undefined {
  const v = process.env[key];
  if (v === "1") return true;
  if (v === "0") return false;
  return undefined;
}

export function readFlags(): RuntimeFlags {
  // Step 1: parse file (mtime-cached)
  try {
    const st = statSync(FLAGS_PATH);
    if (st.mtimeMs !== _mtimeMs || !_hasRead) {
      _mtimeMs = st.mtimeMs;
      _hasRead = true;
      const parsed = JSON.parse(readFileSync(FLAGS_PATH, "utf8"));
      _cache = {
        ledger_dry_run: parsed.ledger_dry_run ?? DEFAULTS.ledger_dry_run,
        dump_bodies_full: parsed.dump_bodies_full ?? DEFAULTS.dump_bodies_full,
      };
    }
  } catch {
    // file missing or unparseable → use defaults (don't overwrite cache silently)
    if (!_hasRead) {
      _cache = { ...DEFAULTS };
    }
  }

  // Step 2: env overrides (LEDGER_DRY_RUN=0/1, CLAUDE_DUMP_BODIES_FULL=0/1)
  const envDry = envOverride("LEDGER_DRY_RUN");
  const envDump = envOverride("CLAUDE_DUMP_BODIES_FULL");
  return {
    ledger_dry_run: envDry !== undefined ? envDry : _cache.ledger_dry_run,
    dump_bodies_full: envDump !== undefined ? envDump : _cache.dump_bodies_full,
  };
}

/** Convenience accessors */
export function isDryRun(): boolean {
  return readFlags().ledger_dry_run;
}

export function isBodyDumpEnabled(): boolean {
  return readFlags().dump_bodies_full;
}
