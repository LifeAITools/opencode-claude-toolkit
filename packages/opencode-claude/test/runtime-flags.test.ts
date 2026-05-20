import { describe, it, expect } from "bun:test";

describe("provider runtime-flags reader", () => {
  it("returns flags with correct types regardless of file presence", async () => {
    const m = await import("../src/runtime-flags.ts");
    const flags = m.readFlags();
    // Whether file exists or not, the default semantics should hold:
    expect(typeof flags.cache_prefix_split_enabled).toBe("boolean");
    expect(typeof flags.prefix_health_alert_drop_threshold).toBe("number");
    expect(typeof flags.prefix_health_alert_drop_consecutive).toBe("number");
    expect(typeof flags.prefix_health_alert_stability_window).toBe("number");
  });

  it("isCachePrefixSplitEnabled returns boolean", async () => {
    const m = await import("../src/runtime-flags.ts");
    expect(typeof m.isCachePrefixSplitEnabled()).toBe("boolean");
  });

  // Phase 2 kill-switch (REQ-01 / CR-01): cache_scope_global_enabled
  describe("cache_scope_global_enabled (Phase 2 kill-switch)", () => {
    it("RuntimeFlags includes cache_scope_global_enabled as boolean", async () => {
      const m = await import("../src/runtime-flags.ts");
      const flags = m.readFlags();
      expect(typeof flags.cache_scope_global_enabled).toBe("boolean");
    });

    it("isCacheScopeGlobalEnabled returns boolean", async () => {
      const m = await import("../src/runtime-flags.ts");
      expect(typeof m.isCacheScopeGlobalEnabled()).toBe("boolean");
    });

    it("validateFlags accepts cache_scope_global_enabled: true", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(
        validateFlags({ cache_scope_global_enabled: true }),
      ).toBeNull();
    });

    it("validateFlags accepts cache_scope_global_enabled: false", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(
        validateFlags({ cache_scope_global_enabled: false }),
      ).toBeNull();
    });

    it("validateFlags rejects wrong type for cache_scope_global_enabled", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      const err = validateFlags({ cache_scope_global_enabled: "yes" });
      expect(err).not.toBeNull();
      expect(err).toContain("cache_scope_global_enabled");
      expect(err).toContain("boolean");
    });
  });

  // Phase 3 kill-switch (REQ-05 / REQ-06 / CR-01): telemetry_v2_enabled
  describe("telemetry_v2_enabled (Phase 3 kill-switch)", () => {
    it("RuntimeFlags includes telemetry_v2_enabled as boolean", async () => {
      const m = await import("../src/runtime-flags.ts");
      const flags = m.readFlags();
      expect(typeof flags.telemetry_v2_enabled).toBe("boolean");
    });

    it("isTelemetryV2Enabled returns boolean", async () => {
      const m = await import("../src/runtime-flags.ts");
      expect(typeof m.isTelemetryV2Enabled()).toBe("boolean");
    });

    it("validateFlags accepts telemetry_v2_enabled: true|false", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(validateFlags({ telemetry_v2_enabled: true })).toBeNull();
      expect(validateFlags({ telemetry_v2_enabled: false })).toBeNull();
    });

    it("validateFlags rejects wrong type for telemetry_v2_enabled", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      const err = validateFlags({ telemetry_v2_enabled: "yes" });
      expect(err).not.toBeNull();
      expect(err).toContain("telemetry_v2_enabled");
      expect(err).toContain("boolean");
    });

    it("default ON: with no override on disk, reader returns true", async () => {
      // The real on-disk file (~/.claude/runtime-flags.json) has telemetry_v2_enabled: true
      // per Phase 3 task 3.5. We verify the reader picks it up.
      // Also: if disk file were missing, DEFAULTS.telemetry_v2_enabled === true.
      // Either way, default semantics = true.
      const m = await import("../src/runtime-flags.ts");
      expect(m.isTelemetryV2Enabled()).toBe(true);
    });
  });

  // CRITICAL: cross-reader consistency proof for CR-15 / DB-18 alt-path.
  // We import the plugin's reader by absolute path. This is acceptable for
  // tests (it is NOT a runtime cross-monorepo dependency).
  it("CRITICAL CR-15: provider and plugin read same value for cache_prefix_split_enabled", async () => {
    const provM = await import("../src/runtime-flags.ts");
    const plugM = await import(
      "/home/relishev/packages/opencode-context-ledger/src/runtime-flags.ts"
    );
    expect(provM.isCachePrefixSplitEnabled()).toBe(
      plugM.isCachePrefixSplitEnabled(),
    );
  });

  it("CR-15: provider and plugin agree on threshold/consecutive/window", async () => {
    const provM = await import("../src/runtime-flags.ts");
    const plugM = await import(
      "/home/relishev/packages/opencode-context-ledger/src/runtime-flags.ts"
    );
    const pf = provM.readFlags();
    const lf = plugM.readFlags();
    expect(pf.prefix_health_alert_drop_threshold).toBe(
      lf.prefix_health_alert_drop_threshold,
    );
    expect(pf.prefix_health_alert_drop_consecutive).toBe(
      lf.prefix_health_alert_drop_consecutive,
    );
    expect(pf.prefix_health_alert_stability_window).toBe(
      lf.prefix_health_alert_stability_window,
    );
  });

  // REQ-13: schema validation rejects unknown keys but allows underscore
  // doc/note passthrough. Tests target `validateFlags()` directly to keep
  // them deterministic regardless of what's currently in the real
  // ~/.claude/runtime-flags.json on the dev box.
  describe("validateFlags (REQ-13 schema)", () => {
    it("accepts a valid flag object", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(
        validateFlags({
          cache_prefix_split_enabled: true,
          ledger_dry_run: false,
        }),
      ).toBeNull();
    });

    it("accepts underscore-prefixed doc/note fields (strategy b passthrough)", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(
        validateFlags({
          _doc: "Live feature flags ...",
          _ledger_self_reflect_dry_run_note: "Default true (safe). When ...",
          ledger_self_reflect_dry_run: true,
        }),
      ).toBeNull();
    });

    it("rejects unknown flag keys with a clear message", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      const err = validateFlags({ cache_scope_globall_enabled: true });
      expect(err).not.toBeNull();
      expect(err).toContain("Unrecognized runtime flag");
      expect(err).toContain("cache_scope_globall_enabled");
    });

    it("rejects wrong types for known flags", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      const err = validateFlags({ cache_prefix_split_enabled: "yes" });
      expect(err).not.toBeNull();
      expect(err).toContain("cache_prefix_split_enabled");
      expect(err).toContain("boolean");
    });

    it("rejects non-object roots (array, null, string)", async () => {
      const { validateFlags } = await import("../src/runtime-flags.ts");
      expect(validateFlags([])).toContain("must be a JSON object");
      expect(validateFlags(null)).toContain("must be a JSON object");
      expect(validateFlags("hello")).toContain("must be a JSON object");
    });

    it("schema covers all flags currently in ~/.claude/runtime-flags.json", async () => {
      // Sanity check: real on-disk file must validate cleanly against our
      // schema. If this fails, either the file gained a new flag not yet
      // added to FLAG_TYPES, or a typo crept in.
      const { validateFlags } = await import("../src/runtime-flags.ts");
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const flagsPath = path.join(os.homedir(), ".claude", "runtime-flags.json");
      if (!fs.existsSync(flagsPath)) return; // no file = skip (CI may lack it)
      const parsed = JSON.parse(fs.readFileSync(flagsPath, "utf8"));
      expect(validateFlags(parsed)).toBeNull();
    });
  });
});
