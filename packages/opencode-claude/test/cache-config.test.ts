import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CACHE_CONTROL_TTL,
  CACHE_CONTROL_1H,
  CACHE_CONTROL_GLOBAL_1H,
  BREAKPOINT_INVENTORY,
  chooseTTL,
  isUsingOverage,
  getEffectiveTtl,
  _resetOverageCache,
  _resetEffectiveTtlCache,
} from "../src/cache-config.ts";

describe("cache-config SSOT module", () => {
  it("CACHE_CONTROL_1H is frozen", () => {
    expect(Object.isFrozen(CACHE_CONTROL_1H)).toBe(true);
  });

  it("CACHE_CONTROL_1H has ephemeral type", () => {
    expect(CACHE_CONTROL_1H.type).toBe("ephemeral");
  });

  it("CACHE_CONTROL_1H ttl defaults to 1h", () => {
    // Default holds when CACHE_CONTROL_TTL env is not set at module load.
    // bun test inherits the process env; if the runner sets the override,
    // this test reflects that — guard explicitly so the suite stays honest.
    if (!process.env.CACHE_CONTROL_TTL) {
      expect(CACHE_CONTROL_1H.ttl).toBe("1h");
    } else {
      expect(CACHE_CONTROL_1H.ttl).toBe(process.env.CACHE_CONTROL_TTL);
    }
  });

  it("BREAKPOINT_INVENTORY has exactly 4 slots", () => {
    expect(BREAKPOINT_INVENTORY.length).toBe(4);
  });

  it("BREAKPOINT_INVENTORY is frozen", () => {
    expect(Object.isFrozen(BREAKPOINT_INVENTORY)).toBe(true);
  });

  it("BREAKPOINT_INVENTORY slot 1 uses abstract 'global instruction block' naming (DB-06)", () => {
    // Per DB-06 the position term must NOT leak the specific filename
    // (CLAUDE.md vs AGENTS.md vs plugin-injected).
    const slot1 = BREAKPOINT_INVENTORY[0];
    expect(slot1.slot).toBe(1);
    expect(slot1.position).toContain("global instruction block");
    // Sanity: the old leaky phrasing must be gone.
    expect(slot1.position).not.toContain("global CLAUDE.md system block");
  });

  it("CACHE_CONTROL_TTL is a string", () => {
    expect(typeof CACHE_CONTROL_TTL).toBe("string");
  });
});

describe("CACHE_CONTROL_GLOBAL_1H (Phase 2 prep)", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(CACHE_CONTROL_GLOBAL_1H)).toBe(true);
  });

  it("has ephemeral type", () => {
    expect(CACHE_CONTROL_GLOBAL_1H.type).toBe("ephemeral");
  });

  it("carries scope: 'global'", () => {
    expect(CACHE_CONTROL_GLOBAL_1H.scope).toBe("global");
  });

  it("inherits CACHE_CONTROL_TTL for the ttl field", () => {
    expect(CACHE_CONTROL_GLOBAL_1H.ttl).toBe(CACHE_CONTROL_TTL);
  });
});

// ─── chooseTTL — pure function test surface (REQ-02, CR-04) ──────────────
//
// Env overrides are read at call time (not at module load) so each test
// can set/clear them in beforeEach/afterEach without re-importing. Pure
// function discipline (CR-04) means same inputs → same output: every test
// here is a single deterministic assertion.

describe("chooseTTL — pure function (REQ-02, CR-04, CN-08)", () => {
  // Snapshot the env vars we touch so the suite leaves the runner's env
  // untouched regardless of test order.
  let originalForce5m: string | undefined;
  let original1h: string | undefined;

  beforeEach(() => {
    originalForce5m = process.env.FORCE_PROMPT_CACHING_5M;
    original1h = process.env.ENABLE_PROMPT_CACHING_1H;
    delete process.env.FORCE_PROMPT_CACHING_5M;
    delete process.env.ENABLE_PROMPT_CACHING_1H;
  });

  afterEach(() => {
    if (originalForce5m === undefined) {
      delete process.env.FORCE_PROMPT_CACHING_5M;
    } else {
      process.env.FORCE_PROMPT_CACHING_5M = originalForce5m;
    }
    if (original1h === undefined) {
      delete process.env.ENABLE_PROMPT_CACHING_1H;
    } else {
      process.env.ENABLE_PROMPT_CACHING_1H = original1h;
    }
  });

  describe("allowlist behaviour (no env overrides, no overage)", () => {
    it("repl_main_thread_xyz (prefix match) → 1h", () => {
      expect(chooseTTL("repl_main_thread_xyz", false)).toBe("1h");
    });

    it("repl_main_thread (exact stem prefix) → 1h", () => {
      // The pattern is "repl_main_thread*" → startsWith("repl_main_thread")
      expect(chooseTTL("repl_main_thread", false)).toBe("1h");
    });

    it("sdk (exact match) → 1h", () => {
      expect(chooseTTL("sdk", false)).toBe("1h");
    });

    it("auto_mode (exact match) → 1h", () => {
      expect(chooseTTL("auto_mode", false)).toBe("1h");
    });

    it("one-shot-helper (non-allowlist) → 5m", () => {
      expect(chooseTTL("one-shot-helper", false)).toBe("5m");
    });

    it("empty string → 5m (no allowlist match)", () => {
      expect(chooseTTL("", false)).toBe("5m");
    });

    it("sdk-variant (non-exact, no wildcard) → 5m", () => {
      // "sdk" is exact-match only — "sdk-variant" must NOT match.
      expect(chooseTTL("sdk-variant", false)).toBe("5m");
    });
  });

  describe("overage behaviour (no env overrides)", () => {
    it("allowlist match + overage → 5m (overage forces cheap tier)", () => {
      expect(chooseTTL("repl_main_thread_xyz", true)).toBe("5m");
    });

    it("non-allowlist + overage → 5m", () => {
      expect(chooseTTL("one-shot-helper", true)).toBe("5m");
    });

    it("sdk + overage → 5m", () => {
      expect(chooseTTL("sdk", true)).toBe("5m");
    });
  });

  describe("env override: FORCE_PROMPT_CACHING_5M", () => {
    it("FORCE_PROMPT_CACHING_5M=1 + allowlist match + no overage → 5m", () => {
      process.env.FORCE_PROMPT_CACHING_5M = "1";
      expect(chooseTTL("repl_main_thread_xyz", false)).toBe("5m");
    });

    it("FORCE_PROMPT_CACHING_5M=1 + non-allowlist → 5m", () => {
      process.env.FORCE_PROMPT_CACHING_5M = "1";
      expect(chooseTTL("one-shot-helper", false)).toBe("5m");
    });

    it("FORCE_PROMPT_CACHING_5M=1 + overage → 5m", () => {
      process.env.FORCE_PROMPT_CACHING_5M = "1";
      expect(chooseTTL("sdk", true)).toBe("5m");
    });

    it("FORCE_PROMPT_CACHING_5M wins over ENABLE_PROMPT_CACHING_1H when both set (safer default)", () => {
      process.env.FORCE_PROMPT_CACHING_5M = "1";
      process.env.ENABLE_PROMPT_CACHING_1H = "1";
      expect(chooseTTL("repl_main_thread_xyz", false)).toBe("5m");
    });
  });

  describe("env override: ENABLE_PROMPT_CACHING_1H", () => {
    it("ENABLE_PROMPT_CACHING_1H=1 + allowlist match → 1h", () => {
      process.env.ENABLE_PROMPT_CACHING_1H = "1";
      expect(chooseTTL("repl_main_thread_xyz", false)).toBe("1h");
    });

    it("ENABLE_PROMPT_CACHING_1H=1 + non-allowlist → 1h (override beats allowlist)", () => {
      process.env.ENABLE_PROMPT_CACHING_1H = "1";
      expect(chooseTTL("one-shot-helper", false)).toBe("1h");
    });

    it("ENABLE_PROMPT_CACHING_1H=1 + overage → 1h (override beats overage)", () => {
      process.env.ENABLE_PROMPT_CACHING_1H = "1";
      expect(chooseTTL("sdk", true)).toBe("1h");
    });
  });

  describe("purity (CR-04)", () => {
    it("returns identical result for identical inputs across repeated calls", () => {
      const r1 = chooseTTL("repl_main_thread_xyz", false);
      const r2 = chooseTTL("repl_main_thread_xyz", false);
      const r3 = chooseTTL("repl_main_thread_xyz", false);
      expect(r1).toBe(r2);
      expect(r2).toBe(r3);
      expect(r1).toBe("1h");
    });

    it("returns 5m | 1h literal type (TypeScript-level guarantee)", () => {
      const result: "5m" | "1h" = chooseTTL("one-shot-helper", false);
      expect(result === "5m" || result === "1h").toBe(true);
    });
  });
});

// ─── isUsingOverage — JSONL tail-read helper (REQ-02, CN-09) ─────────────
//
// Tests use a tmp stats file via the CLAUDE_MAX_STATS_PATH_OVERRIDE env
// var so we never touch the real ~/.claude-local/claude-max-stats.jsonl.
// _resetOverageCache() clears the 60s module-level memoisation between
// cases so each assertion sees fresh disk state.

describe("isUsingOverage — overage detection (REQ-02, CN-09)", () => {
  let tmpDir: string;
  let statsPath: string;
  let originalOverride: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "overage-test-"));
    statsPath = join(tmpDir, "claude-max-stats.jsonl");
    originalOverride = process.env.CLAUDE_MAX_STATS_PATH_OVERRIDE;
    process.env.CLAUDE_MAX_STATS_PATH_OVERRIDE = statsPath;
    _resetOverageCache();
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.CLAUDE_MAX_STATS_PATH_OVERRIDE;
    } else {
      process.env.CLAUDE_MAX_STATS_PATH_OVERRIDE = originalOverride;
    }
    _resetOverageCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("status='allowed' → false (non-overage)", () => {
    const entry = {
      ts: Date.now(),
      rateLimit: { status: "allowed", claim: "five_hour", util5h: 0.04 },
    };
    writeFileSync(statsPath, JSON.stringify(entry) + "\n");
    expect(isUsingOverage()).toBe(false);
  });

  it("status='allowed_warning' → false (allowed* family is approaching-limit, NOT overage)", () => {
    // `allowed_warning` is emitted by the quota tracker near a util threshold —
    // the request is still ALLOWED, just warned. It is NOT rate-limit overage,
    // so it must take the normal (allowlist) TTL path, not the 5m downgrade.
    const entry = {
      ts: Date.now(),
      rateLimit: { status: "allowed_warning", claim: "seven_day", util7d: 0.92 },
    };
    writeFileSync(statsPath, JSON.stringify(entry) + "\n");
    expect(isUsingOverage()).toBe(false);
  });

  it("status='overage' → true (a status outside the allowed* family triggers overage)", () => {
    const entry = {
      ts: Date.now(),
      rateLimit: { status: "overage", claim: "five_hour", util5h: 1.05 },
    };
    writeFileSync(statsPath, JSON.stringify(entry) + "\n");
    expect(isUsingOverage()).toBe(true);
  });

  it("status='limited' → true (outside allowed* family, schema-agnostic)", () => {
    const entry = {
      ts: Date.now(),
      rateLimit: { status: "limited" },
    };
    writeFileSync(statsPath, JSON.stringify(entry) + "\n");
    expect(isUsingOverage()).toBe(true);
  });

  it("missing file → false (conservative default, no crash)", () => {
    // Don't create the file — override points at non-existent path.
    expect(isUsingOverage()).toBe(false);
  });

  it("missing rateLimit field → false (conservative default)", () => {
    const entry = { ts: Date.now(), other: "data" };
    writeFileSync(statsPath, JSON.stringify(entry) + "\n");
    expect(isUsingOverage()).toBe(false);
  });

  it("malformed JSON on last line → false (conservative; no crash)", () => {
    writeFileSync(statsPath, "{not valid json\n");
    expect(isUsingOverage()).toBe(false);
  });

  it("reads ONLY the LAST entry (multi-line file)", () => {
    // First entries: allowed. Last entry: overage. Must return true.
    const allowed = JSON.stringify({ rateLimit: { status: "allowed" } });
    const overage = JSON.stringify({ rateLimit: { status: "overage" } });
    writeFileSync(
      statsPath,
      [allowed, allowed, allowed, overage].join("\n") + "\n",
    );
    expect(isUsingOverage()).toBe(true);
  });

  it("60s cache: second call returns memoised value even if file changes", () => {
    const allowed = JSON.stringify({ rateLimit: { status: "allowed" } });
    writeFileSync(statsPath, allowed + "\n");
    expect(isUsingOverage()).toBe(false);

    // Flip file to overage; without cache reset, the helper should still
    // return false (cached) — proves the 60s cache is wired.
    const overage = JSON.stringify({ rateLimit: { status: "overage" } });
    writeFileSync(statsPath, overage + "\n");
    expect(isUsingOverage()).toBe(false); // cached non-overage

    _resetOverageCache();
    expect(isUsingOverage()).toBe(true); // fresh read sees overage
  });
});

// ─── getEffectiveTtl — keepalive.json reader (Phase 2.5) ─────────────────
//
// Tests use a tmp keepalive.json via CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE
// so we never touch the real ~/.claude-local/keepalive.json. Cache reset
// between cases.

describe("getEffectiveTtl — keepalive.json profile reader (Phase 2.5)", () => {
  let tmpDir: string;
  let kaPath: string;
  let originalOverride: string | undefined;
  let originalForce5m: string | undefined;
  let original1h: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "keepalive-test-"));
    kaPath = join(tmpDir, "keepalive.json");
    originalOverride = process.env.CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE;
    process.env.CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE = kaPath;
    // Strip env overrides that would short-circuit getEffectiveTtl.
    originalForce5m = process.env.FORCE_PROMPT_CACHING_5M;
    original1h = process.env.ENABLE_PROMPT_CACHING_1H;
    delete process.env.FORCE_PROMPT_CACHING_5M;
    delete process.env.ENABLE_PROMPT_CACHING_1H;
    _resetEffectiveTtlCache();
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE;
    } else {
      process.env.CLAUDE_KEEPALIVE_CONFIG_PATH_OVERRIDE = originalOverride;
    }
    if (originalForce5m === undefined) {
      delete process.env.FORCE_PROMPT_CACHING_5M;
    } else {
      process.env.FORCE_PROMPT_CACHING_5M = originalForce5m;
    }
    if (original1h === undefined) {
      delete process.env.ENABLE_PROMPT_CACHING_1H;
    } else {
      process.env.ENABLE_PROMPT_CACHING_1H = original1h;
    }
    _resetEffectiveTtlCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("cacheTtlSec=300 (5m profile) → '5m'", () => {
    writeFileSync(kaPath, JSON.stringify({ enabled: true, cacheTtlSec: 300 }) + "\n");
    expect(getEffectiveTtl()).toBe("5m");
  });

  it("cacheTtlSec=600 (boundary, ≤10min) → '5m'", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 600 }) + "\n");
    expect(getEffectiveTtl()).toBe("5m");
  });

  it("cacheTtlSec=3600 (1h profile) → '1h'", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 3600 }) + "\n");
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("cacheTtlSec=1800 (30min, ≥1800) → '1h'", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 1800 }) + "\n");
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("cacheTtlSec=1200 (middle zone 601..1799) → '1h' (conservative)", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 1200 }) + "\n");
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("file missing → '1h' (legacy default, no crash)", () => {
    // Don't create the file. Helper must NOT throw and must return "1h".
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("missing cacheTtlSec field → '1h' (legacy default)", () => {
    writeFileSync(kaPath, JSON.stringify({ enabled: true, intervalSec: 120 }) + "\n");
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("malformed JSON → '1h' (fallback; no crash)", () => {
    writeFileSync(kaPath, "{not valid json\n");
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("FORCE_PROMPT_CACHING_5M short-circuits regardless of file", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 3600 }) + "\n");
    process.env.FORCE_PROMPT_CACHING_5M = "1";
    expect(getEffectiveTtl()).toBe("5m");
  });

  it("ENABLE_PROMPT_CACHING_1H short-circuits regardless of file", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 300 }) + "\n");
    process.env.ENABLE_PROMPT_CACHING_1H = "1";
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("60s cache: second call returns memoised value even if file changes", () => {
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 300 }) + "\n");
    expect(getEffectiveTtl()).toBe("5m");

    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 3600 }) + "\n");
    expect(getEffectiveTtl()).toBe("5m"); // cached
    _resetEffectiveTtlCache();
    expect(getEffectiveTtl()).toBe("1h");
  });

  it("chooseTTL respects effectiveTtl arg: allowlist + 5m profile → '5m'", () => {
    // This is the actual integration point: provider passes
    // getEffectiveTtl() into chooseTTL as the third arg.
    writeFileSync(kaPath, JSON.stringify({ cacheTtlSec: 300 }) + "\n");
    const eff = getEffectiveTtl();
    expect(eff).toBe("5m");
    expect(chooseTTL("repl_main_thread", false, eff)).toBe("5m");
  });

  it("chooseTTL default 3rd arg = '1h' preserves backwards-compat", () => {
    // Old call sites (any third-party still passing 2 args) keep their
    // legacy behaviour: allowlist match without explicit effectiveTtl → "1h".
    expect(chooseTTL("repl_main_thread", false)).toBe("1h");
  });
});
