import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { buildSystemBlocks } from "../src/system-blocks.ts";
import { _resetOverageCache } from "../src/cache-config.ts";

// Phase 2.D — cache_control objects are now constructed per-call (not frozen
// SSOT refs) because `ttl` is dynamic via chooseTTL. Tests assert SHAPE via
// toEqual, plus shape of the `ttl` value (always "1h" or "5m" — sourced from
// chooseTTL, never a literal at the call site, satisfying CN-08).
const EXPECTED_1H_MARKER = { type: "ephemeral", ttl: "1h" };
const EXPECTED_1H_GLOBAL_MARKER = { type: "ephemeral", ttl: "1h", scope: "global" };
const EXPECTED_5M_MARKER = { type: "ephemeral", ttl: "5m" };

const FLAGS_PATH = join(homedir(), ".claude", "runtime-flags.json");
const FLAGS_DIR = join(homedir(), ".claude");

function readFlagsFileRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(FLAGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Strictly-increasing mtime counter — necessary because the runtime-flags
// reader is mtime-cached and rapid flag flips can otherwise land on the
// same wall-clock millisecond (especially on coarse-resolution filesystems),
// causing the reader to serve a stale cached value.
let _mtimeCounter = Math.floor(Date.now() / 1000);

function writeFlagsAndBumpMtime(flags: Record<string, unknown>) {
  if (!existsSync(FLAGS_DIR)) mkdirSync(FLAGS_DIR, { recursive: true });
  writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2));
  // Force a strictly-increasing mtime so the mtime-cached reader is
  // GUARANTEED to invalidate on next read regardless of FS clock resolution.
  _mtimeCounter += 1;
  try {
    const fs = require("node:fs");
    const t = new Date(_mtimeCounter * 1000);
    fs.utimesSync(FLAGS_PATH, t, t);
  } catch {
    // ignore — writeFileSync already bumped mtime; tests just may flake on
    // exotic FS without utimes support.
  }
}

function setFlag(value: boolean) {
  const flags = readFlagsFileRaw();
  flags.cache_prefix_split_enabled = value;
  writeFlagsAndBumpMtime(flags);
}

function setScopeGlobalFlag(value: boolean) {
  const flags = readFlagsFileRaw();
  flags.cache_scope_global_enabled = value;
  writeFlagsAndBumpMtime(flags);
}

function setBothFlags(splitEnabled: boolean, scopeGlobalEnabled: boolean) {
  const flags = readFlagsFileRaw();
  flags.cache_prefix_split_enabled = splitEnabled;
  flags.cache_scope_global_enabled = scopeGlobalEnabled;
  writeFlagsAndBumpMtime(flags);
}

// Snapshot the original flag value at load time so we can restore it after
// the suite, even on failure. This protects other processes reading the
// shared `~/.claude/runtime-flags.json` from being left in a flipped state.
const ORIGINAL_FLAG_VALUE: boolean = (() => {
  const raw = readFlagsFileRaw();
  const v = raw.cache_prefix_split_enabled;
  // Defaults to `true` per runtime-flags.ts DEFAULTS — mirror that here so
  // restore matches the in-memory default if the key was missing originally.
  return typeof v === "boolean" ? v : true;
})();
const ORIGINAL_KEY_EXISTED: boolean = Object.prototype.hasOwnProperty.call(
  readFlagsFileRaw(),
  "cache_prefix_split_enabled",
);

// Snapshot scope-global flag too (defaults false per runtime-flags.ts DEFAULTS).
const ORIGINAL_SCOPE_GLOBAL_VALUE: boolean = (() => {
  const raw = readFlagsFileRaw();
  const v = raw.cache_scope_global_enabled;
  return typeof v === "boolean" ? v : false;
})();

afterAll(() => {
  // Restore the original on-disk state. If the key didn't exist originally,
  // we still write it explicitly with its default value (true) so behavior
  // is unchanged in practice; we don't try to delete the key because the
  // file is shared with the plugin reader and we want predictability.
  const flags = readFlagsFileRaw();
  flags.cache_prefix_split_enabled = ORIGINAL_FLAG_VALUE;
  flags.cache_scope_global_enabled = ORIGINAL_SCOPE_GLOBAL_VALUE;
  writeFileSync(FLAGS_PATH, JSON.stringify(flags, null, 2));
  void ORIGINAL_KEY_EXISTED; // documented intent only
});

describe("buildSystemBlocks — kill-switch ON (default split layout)", () => {
  beforeEach(() => setBothFlags(true, false));

  it("returns 3 blocks when all 3 inputs present", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0].text).toBe("GLOBAL");
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    expect(blocks[1].text).toContain("PROJECT");
    expect(blocks[1].text).toContain("OPENCODE_BODY");
    expect(blocks[1].cache_control).toBeUndefined();
    expect(blocks[2].text).toBe("MEMORY");
    expect(blocks[2].cache_control).toBeUndefined();
  });

  it("middle block joins project + opencode with \\n\\n separator", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks[1].text).toBe("PROJECT\n\nOPENCODE_BODY");
  });

  it("no global rules → 2 blocks, no cache_control on first", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: null,
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[0].text).toContain("PROJECT");
    expect(blocks[0].text).toContain("OPENCODE_BODY");
    expect(blocks[1].text).toBe("MEMORY");
  });

  it("no project rules → 3 blocks: global + opencode-only middle + memory", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: null,
      volatileMemory: "MEMORY",
    });
    expect(blocks.length).toBe(3);
    expect(blocks[0].text).toBe("GLOBAL");
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    expect(blocks[1].text).toBe("OPENCODE_BODY");
    expect(blocks[2].text).toBe("MEMORY");
  });

  it("no memory → 2 blocks (global with cache_control + middle)", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("GLOBAL");
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    expect(blocks[1].text).toContain("PROJECT");
    expect(blocks[1].text).toContain("OPENCODE_BODY");
  });

  it("only global rules → 1 block with cache_control", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "",
      globalRules: "GLOBAL",
      projectRules: null,
      volatileMemory: null,
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0].text).toBe("GLOBAL");
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
  });

  it("all-null inputs → 0 blocks", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "",
      globalRules: null,
      projectRules: null,
      volatileMemory: null,
    });
    expect(blocks.length).toBe(0);
  });

  it("array-form opencodeSystem is JSON-stringified defensively", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: [{ type: "text", text: "OPENCODE_BODY" }],
      globalRules: null,
      projectRules: null,
      volatileMemory: null,
    });
    expect(blocks.length).toBe(1);
    // JSON.stringify result includes the structure markers — that's the
    // defensive contract; real callers normalize to string upstream.
    expect(blocks[0].text).toContain("OPENCODE_BODY");
  });

  it("CN-08: cache_control has frozen shape {type:'ephemeral',ttl:'1h'} (no scope field by default)", () => {
    // Phase 2.D: marker objects are no longer SSOT-frozen references —
    // they are constructed per-call because `ttl` is dynamic via chooseTTL.
    // The CN-08 contract is preserved differently: the `ttl` field MUST
    // come from chooseTTL (1h | 5m), never a raw inline literal. Shape
    // equality here proves the marker structure is canonical.
    const blocks = buildSystemBlocks({
      opencodeSystem: "X",
      globalRules: "G",
      projectRules: null,
      volatileMemory: null,
    });
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    // ttl is one of the chooseTTL return values, not a free-form string
    expect(["1h", "5m"]).toContain(blocks[0].cache_control?.ttl);
  });
});

describe("buildSystemBlocks — kill-switch OFF (OLD layout)", () => {
  beforeEach(() => setBothFlags(false, false));

  it("CR-03: returns single combined block + memory tail matching OLD pre-PRP layout", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0].cache_control).toBeUndefined(); // opencode core stamps it
    // Join order MUST be global → project → opencode (matches provider.ts:639-644)
    expect(blocks[0].text).toBe("GLOBAL\n\nPROJECT\n\nOPENCODE_BODY");
    expect(blocks[1].text).toBe("MEMORY");
    expect(blocks[1].cache_control).toBeUndefined();
  });

  it("OLD: no memory → single combined block only", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0].text).toBe("GLOBAL\n\nPROJECT\n\nOPENCODE_BODY");
    expect(blocks[0].cache_control).toBeUndefined();
  });

  it("OLD: no global rules → project + opencode in single block", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: null,
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    });
    expect(blocks.length).toBe(2);
    expect(blocks[0].text).toBe("PROJECT\n\nOPENCODE_BODY");
    expect(blocks[1].text).toBe("MEMORY");
  });

  it("OLD: never emits cache_control on any block (opencode core stamps)", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "X",
      globalRules: "G",
      projectRules: "P",
      volatileMemory: "M",
    });
    for (const b of blocks) {
      expect(b.cache_control).toBeUndefined();
    }
  });
});

describe("buildSystemBlocks — CR-03 byte-equivalence between layouts", () => {
  beforeEach(() => setScopeGlobalFlag(false));

  it("CR-03: split-block concatenation byte-equals OLD single-block text", () => {
    const input = {
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    };

    setFlag(true);
    const split = buildSystemBlocks(input);
    setFlag(false);
    const old = buildSystemBlocks(input);

    // The LLM sees the concatenation of text-block .text values (Anthropic
    // joins them with "\n\n" internally for system messages — matching
    // exactly the separator we use between segments inside the OLD block).
    //
    // Excluding the volatile tail (which sits as its own block in BOTH
    // layouts), the leading content the model reads MUST be byte-identical.
    const splitLeading = split
      .filter((b) => b.text !== input.volatileMemory)
      .map((b) => b.text)
      .join("\n\n");
    const oldLeading = old
      .filter((b) => b.text !== input.volatileMemory)
      .map((b) => b.text)
      .join("\n\n");

    expect(splitLeading).toBe(oldLeading);
    // Sanity: both contain segments in the expected order
    expect(splitLeading).toMatch(/GLOBAL[\s\S]*PROJECT[\s\S]*OPENCODE_BODY/);
  });

  it("CR-03: cache_control marker is metadata only — same .text bytes across layouts", () => {
    setFlag(true);
    const split = buildSystemBlocks({
      opencodeSystem: "X",
      globalRules: "G",
      projectRules: "P",
      volatileMemory: "M",
    });
    setFlag(false);
    const old = buildSystemBlocks({
      opencodeSystem: "X",
      globalRules: "G",
      projectRules: "P",
      volatileMemory: "M",
    });

    // Strip cache_control from split and assert .text + .type shape is the
    // ONLY difference that matters at the layout level (block count differs,
    // but joined bytes equal).
    const splitJoined = split.map((b) => b.text).join("\n\n");
    const oldJoined = old.map((b) => b.text).join("\n\n");
    expect(splitJoined).toBe(oldJoined);
  });
});

describe("buildSystemBlocks — Phase 2 cache_scope_global_enabled (REQ-01, CR-03)", () => {
  // Split layout MUST be on for these tests — the scope-global flag only
  // affects the split-layout's Block 1; in OLD layout no cache_control is
  // emitted at all (opencode core stamps it downstream).
  beforeEach(() => setBothFlags(true, false));

  it("flag OFF (default): Block 1 cache_control has shape {ttl:'1h'} with NO scope field", () => {
    setBothFlags(true, false);
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    expect(blocks[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
    });
    // No `scope` field on the marker
    expect((blocks[0].cache_control as Record<string, unknown>).scope).toBeUndefined();
  });

  it("flag ON: Block 1 cache_control has shape {ttl:'1h',scope:'global'}", () => {
    setBothFlags(true, true);
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_GLOBAL_MARKER);
    expect(blocks[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "1h",
      scope: "global",
    });
  });

  it("CR-03: Block 1 .text bytes are IDENTICAL across flag-off vs flag-on", () => {
    const input = {
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL\nWith\nMultiline\nContent",
      projectRules: "PROJECT",
      volatileMemory: "MEMORY",
    };

    setBothFlags(true, false);
    const flagOff = buildSystemBlocks(input);
    setBothFlags(true, true);
    const flagOn = buildSystemBlocks(input);

    // Block counts MUST match — flag only changes metadata, not layout shape.
    expect(flagOn.length).toBe(flagOff.length);
    // Every block's .text MUST be byte-identical.
    for (let i = 0; i < flagOn.length; i++) {
      expect(flagOn[i].text).toBe(flagOff[i].text);
    }
    // Specifically Block 1 (global rules) — the only block whose cache_control
    // changes — has identical text.
    expect(flagOn[0].text).toBe(flagOff[0].text);
    expect(flagOn[0].text).toBe("GLOBAL\nWith\nMultiline\nContent");
    // Cache_control marker DIFFERS structurally — flag-on adds scope:"global".
    expect(flagOn[0].cache_control).not.toEqual(flagOff[0].cache_control);
    expect(flagOn[0].cache_control).toHaveProperty("scope", "global");
    expect((flagOff[0].cache_control as Record<string, unknown>).scope).toBeUndefined();
    // Block 2 and Block 3 cache_control is identical (undefined) — flag only
    // affects slot 1 of BREAKPOINT_INVENTORY.
    expect(flagOn[1].cache_control).toBeUndefined();
    expect(flagOff[1].cache_control).toBeUndefined();
    expect(flagOn[2].cache_control).toBeUndefined();
    expect(flagOff[2].cache_control).toBeUndefined();
  });

  it("flag ON + no globalRules: no Block 1 emitted (scope flag is moot)", () => {
    setBothFlags(true, true);
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: null,
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    // Without globalRules there is no slot-1 block to stamp scope on — the
    // flag has no observable effect.
    expect(blocks.length).toBe(1);
    expect(blocks[0].cache_control).toBeUndefined();
  });

  it("flag ON + kill-switch OFF (OLD layout): scope flag has no effect", () => {
    // OLD layout never emits cache_control from this module (opencode core
    // stamps downstream). The scope-global flag is a no-op in this mode.
    setBothFlags(false, true);
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
    });
    expect(blocks.length).toBe(1);
    expect(blocks[0].cache_control).toBeUndefined();
    // Text content matches OLD-layout single-block join.
    expect(blocks[0].text).toBe("GLOBAL\n\nPROJECT\n\nOPENCODE_BODY");
  });
});

describe("buildSystemBlocks — Phase 2.D chooseTTL wire-through (REQ-02, CN-08)", () => {
  // Split layout MUST be on (the OLD layout never emits cache_control at all).
  // scope-global flag is off so we assert pure-TTL shape.
  beforeEach(() => {
    setBothFlags(true, false);
    _resetOverageCache();
    delete process.env.FORCE_PROMPT_CACHING_5M;
    delete process.env.ENABLE_PROMPT_CACHING_1H;
  });

  afterAll(() => {
    delete process.env.FORCE_PROMPT_CACHING_5M;
    delete process.env.ENABLE_PROMPT_CACHING_1H;
    _resetOverageCache();
  });

  it("querySource omitted → defaults to 'repl_main_thread' → ttl='1h' (allowlisted)", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
      // querySource: omitted on purpose — tests the default branch.
    });
    expect(blocks[0].cache_control).toEqual(EXPECTED_1H_MARKER);
    expect(blocks[0].cache_control?.ttl).toBe("1h");
  });

  it("querySource='one-shot-helper' (not in allowlist) → ttl='5m'", () => {
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
      querySource: "one-shot-helper",
    });
    expect(blocks[0].cache_control).toEqual(EXPECTED_5M_MARKER);
    expect(blocks[0].cache_control?.ttl).toBe("5m");
  });

  it("FORCE_PROMPT_CACHING_5M=1 overrides allowlist → ttl='5m' regardless of querySource", () => {
    process.env.FORCE_PROMPT_CACHING_5M = "1";
    try {
      // Use an allowlisted querySource that would normally → 1h
      const blocks = buildSystemBlocks({
        opencodeSystem: "OPENCODE_BODY",
        globalRules: "GLOBAL",
        projectRules: "PROJECT",
        volatileMemory: null,
        querySource: "repl_main_thread",
      });
      expect(blocks[0].cache_control).toEqual(EXPECTED_5M_MARKER);
      expect(blocks[0].cache_control?.ttl).toBe("5m");
    } finally {
      delete process.env.FORCE_PROMPT_CACHING_5M;
    }
  });

  it("CR-03: .text bytes IDENTICAL across querySource values (ttl is metadata only)", () => {
    const baseInput = {
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL_TEXT",
      projectRules: "PROJECT_TEXT",
      volatileMemory: "MEMORY_TEXT",
    };
    const replBlocks = buildSystemBlocks({ ...baseInput, querySource: "repl_main_thread" });
    const oneshotBlocks = buildSystemBlocks({ ...baseInput, querySource: "one-shot-helper" });

    // Same number of blocks, identical .text on each.
    expect(replBlocks.length).toBe(oneshotBlocks.length);
    for (let i = 0; i < replBlocks.length; i++) {
      expect(replBlocks[i].text).toBe(oneshotBlocks[i].text);
    }
    // But ttl values differ on Block 1.
    expect(replBlocks[0].cache_control?.ttl).toBe("1h");
    expect(oneshotBlocks[0].cache_control?.ttl).toBe("5m");
  });

  it("CN-08: scope='global' marker also routes ttl through chooseTTL", () => {
    // Flag-on path: cache_control carries scope:"global". Verify ttl is
    // STILL dynamic — 5m querySource → 5m ttl even with scope:"global".
    setBothFlags(true, true);
    const blocks = buildSystemBlocks({
      opencodeSystem: "OPENCODE_BODY",
      globalRules: "GLOBAL",
      projectRules: "PROJECT",
      volatileMemory: null,
      querySource: "one-shot-helper",
    });
    expect(blocks[0].cache_control).toEqual({
      type: "ephemeral",
      ttl: "5m",
      scope: "global",
    });
  });
});
