/**
 * system-blocks — single owner of the Anthropic `system[]` block layout.
 *
 * Pure function module. No IO except the cached runtime-flags reader (which
 * is mtime-cached and effectively free on hot path). No logging, no fetch,
 * no side effects. Deterministic from inputs once the flag is read.
 *
 * **Why this module exists:** before PRP rev 1.4.0 the provider built the
 * `system[]` array inline at `provider.ts:638-651`. That layout collapsed all
 * stable content (global rules + project rules + opencode body) into one
 * monolithic block, which meant a `cwd` change (project switch) invalidated
 * the entire prefix — even the global CLAUDE.md half that hadn't changed.
 * This module splits the assembly into a dedicated, testable unit and
 * introduces the **split layout** that puts global rules in their own
 * cache-stamped block so they survive cwd changes.
 *
 * ## Layout contract (kill-switch ON, default)
 *
 * Returns up to 3 blocks per PRD §Technical Notes "Layout target — system
 * block" (REQ-01..05):
 *
 *   1. **Global block** (only if `globalRules` present):
 *      `{ type:'text', text: globalRules, cache_control: <see below> }`
 *      — first block, with breakpoint slot 1 of `BREAKPOINT_INVENTORY`.
 *
 *      Slot 1 `cache_control` is composed from TWO independent runtime
 *      decisions, both driven by SSOT helpers in `cache-config.ts`:
 *
 *      (a) **TTL choice (REQ-02, native CC `o85()` semantics):**
 *          `ttl` ← `chooseTTL(input.querySource ?? "repl_main_thread",
 *          isUsingOverage())`. Resolves to `"1h"` for long-lived sessions
 *          on the allowlist (REPL main thread, SDK, auto-mode) when NOT
 *          in rate-limit overage; resolves to `"5m"` otherwise. Env
 *          overrides `FORCE_PROMPT_CACHING_5M` and `ENABLE_PROMPT_CACHING_1H`
 *          are respected by `chooseTTL` internally. CN-08 — no raw
 *          `ttl:"1h"` / `ttl:"5m"` literals stamped here; only `chooseTTL`
 *          return values flow into the marker.
 *
 *      (b) **Scope choice (REQ-01):** `cache_scope_global_enabled` flag
 *          governs presence of the `scope: "global"` field:
 *            - flag **true** → `{ type:"ephemeral", ttl, scope:"global" }`
 *              (cross-workspace cache sharing; beta-gated per CR-03 —
 *              `buildBetas()` upstream pushes `prompt-caching-scope-2026-01-05`
 *              when the flag is on, see Phase 2.A).
 *            - flag **false** (default) → `{ type:"ephemeral", ttl }`
 *              (no scope field; org-default per-workspace caching).
 *
 *      **Byte-equivalence preserved (CR-03):** the `.text` content of Block 1
 *      is byte-identical regardless of flag value, querySource, or overage
 *      state — `cache_control` (including its `ttl` and `scope` fields) is
 *      request-shaping metadata, NOT prompt content the model reads. The
 *      LLM's input sequence is unchanged across any of these axes.
 *
 *   2. **Middle block** (only if there is non-global content):
 *      `{ type:'text', text: projectRules + '\n\n' + opencodeSystem }`
 *      — NO `cache_control` here; opencode core stamps slot 2 downstream.
 *
 *   3. **Volatile tail** (only if `volatileMemory` present):
 *      `{ type:'text', text: volatileMemory }` — NO `cache_control`.
 *
 * ## Layout contract (kill-switch OFF, OLD pre-PRP)
 *
 * Returns up to 2 blocks **byte-identical** to what `provider.ts:638-651`
 * produced before this PRP (CR-03, CR-14):
 *
 *   1. **Combined block:**
 *      `{ type:'text', text: globalRules + '\n\n' + projectRules + '\n\n' + opencodeSystem }`
 *      — NO `cache_control`; opencode core stamps it.
 *   2. **Volatile tail** (only if `volatileMemory`): same as split layout.
 *
 * ## Byte-equivalence guarantee (CR-03)
 *
 * The load-bearing test target: when Anthropic concatenates the split
 * blocks (which it does internally via text-block joining), the resulting
 * byte sequence the LLM sees MUST equal the OLD single-block text for the
 * same inputs. The `cache_control` marker is request metadata, not content,
 * so it does not affect what the model reads. The `\n\n` separators used
 * between split-block boundaries are intentionally the same separators the
 * OLD single-block code used between segments (`filter(Boolean).join('\n\n')`
 * at provider.ts:639-644).
 *
 * ## Why a separate module (CR-13, DB-12)
 *
 * - Provider.ts is already ~1.7K lines; this logic deserves its own home.
 * - Pure-function shape makes it trivially unit-testable without spinning
 *   up the provider.
 * - The kill-switch fallback (OLD layout) MUST live next to the new layout
 *   so they share input plumbing and stay byte-equivalent by construction.
 *
 * @see PRP opencode-cache-prefix-stability rev 1.4.0
 * @see REQ-01, REQ-02, REQ-03, REQ-04, REQ-05, REQ-19
 * @see CR-03, CR-11, CR-13, CR-14
 * @see DB-12, DB-15
 */

import { chooseTTL, isUsingOverage, getEffectiveTtl } from "./cache-config.js";
import {
  isCachePrefixSplitEnabled,
  isCacheScopeGlobalEnabled,
} from "./runtime-flags.js";

/**
 * Default `querySource` when the caller (provider.ts) cannot resolve one
 * from the live request context. Mirrors native CC's REPL main-thread
 * identifier, which falls in `DEFAULT_TTL_1H_ALLOWLIST` → resolves to the
 * 1h tier. Conservative-positive default: when in doubt, prefer the
 * long-lived cache (cheaper amortized cost) over the 5m fallback.
 */
const DEFAULT_QUERY_SOURCE = "repl_main_thread";

/**
 * Inputs to {@link buildSystemBlocks}. The provider's `convertPrompt`
 * is responsible for resolving these from opencode's prompt array +
 * the `buildContextInjectionParts()` helper.
 */
export interface SystemBlocksInput {
  /** Already-built system content from opencode core (string OR array of `{type:"text",text}`). */
  opencodeSystem: unknown;
  /** Global rules text (from `~/.claude/CLAUDE.md`), or null if missing. */
  globalRules: string | null;
  /** Concatenated project rules text (one or more `<claude-rules>...</claude-rules>` blocks), or null. */
  projectRules: string | null;
  /** MEMORY.md text wrapped in `<project-memory>` tags, or null. */
  volatileMemory: string | null;
  /**
   * Session source identifier for TTL allowlist matching (REQ-02, native CC
   * `o85()` semantics). Routed through {@link chooseTTL} to select between
   * the 5m and 1h ephemeral cache tiers. Defaults to `"repl_main_thread"`
   * (1h tier) when omitted — this matches the conservative-positive default
   * used by callers that lack live request context. Providers SHOULD thread
   * a real querySource from session metadata when available.
   */
  querySource?: string;
}

/**
 * A single entry in the Anthropic `system[]` array.
 *
 * `cache_control`, when present, MUST have its `ttl` value sourced from
 * {@link chooseTTL} — no raw `"1h"` / `"5m"` literals stamped at this site
 * (CN-08). The optional `scope` field is only emitted when the
 * `cache_scope_global_enabled` runtime flag is on (REQ-01, CR-03).
 *
 * The cache_control object is constructed FRESH per call (not a frozen
 * SSOT reference) because `ttl` is now dynamic — derived from
 * `chooseTTL(querySource, isUsingOverage())`. The TTL string itself still
 * comes from the SSOT (chooseTTL's return values are "1h" | "5m"), but the
 * containing object is per-emission. This is intentional: a single
 * `buildSystemBlocks()` call must emit ONE consistent ttl across its
 * blocks, but consecutive calls may see different ttls (e.g. as the user
 * crosses an overage boundary mid-session).
 */
export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral"; ttl: "1h" | "5m"; scope?: "global" };
};

/**
 * Normalize the `opencodeSystem` input into a plain string suitable for
 * concatenation. Defensive: if opencode handed us an array of blocks
 * (which the provider's downstream code re-handles separately), we
 * JSON.stringify it so we still produce SOME deterministic text rather
 * than crashing or silently dropping content.
 */
function normalizeOpencodeSystem(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  // Array or object form — stringify defensively. The provider's split-mode
  // caller should pass a string here in practice (it serializes the
  // opencode-supplied content before invoking buildSystemBlocks).
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * Assemble the `system[]` array opencode sends to Anthropic.
 *
 * Reads the `cache_prefix_split_enabled` runtime flag (REQ-19) on every
 * call so operators can flip behavior at runtime without restarting
 * opencode (the underlying reader is mtime-cached, so the cost is one
 * `statSync` per call).
 *
 * - Flag ON (default): split layout — up to 3 blocks, global gets the
 *   cache_control breakpoint, opencode core stamps the middle, memory
 *   tail is naked.
 * - Flag OFF: OLD single-block layout — global + project + opencode all
 *   joined into one block (byte-identical to pre-PRP behavior), with
 *   memory still on its own trailing block when present.
 *
 * Pure: same inputs + same flag value → same output. No retries, no
 * exceptions on empty inputs (returns `[]`).
 *
 * **Telemetry placement (CR-11 observability):** this function is
 * intentionally pure — it does NOT emit `LEDGER_SYSTEM_BLOCK_LAYOUT` events.
 * Upstream callers (provider.ts that invokes `buildSystemBlocks`) are the
 * correct place to emit per-turn layout telemetry, because the provider
 * already has the turn-boundary context this pure assembler lacks. Keeping
 * the function side-effect-free preserves its trivially-testable shape and
 * matches its existing contract.
 */
export function buildSystemBlocks(input: SystemBlocksInput): SystemBlock[] {
  const splitEnabled = isCachePrefixSplitEnabled();
  const opencodeText = normalizeOpencodeSystem(input.opencodeSystem);
  // Compute TTL once per call so all cache_control markers emitted by this
  // invocation share the same value (consistency across the request).
  // `chooseTTL` is pure (CR-04); `isUsingOverage()` is the SSOT IO-touching
  // reader with a 60s in-process cache — acceptable per REQ-02 IO discipline
  // and documented as the canonical wire-through site (CN-08).
  // Phase 2.5: `effectiveTtl` is derived from ~/.claude-local/keepalive.json
  // so provider's wire TTL stays in sync with proxy's keep-alive cadence
  // (operator can flip both via single config edit).
  const ttl = chooseTTL(
    input.querySource ?? DEFAULT_QUERY_SOURCE,
    isUsingOverage(),
    getEffectiveTtl(),
  );

  if (splitEnabled) {
    // ── Split layout (REQ-01..05) ──────────────────────────────────────
    const blocks: SystemBlock[] = [];

    // Block 1: global rules with the dedicated cache breakpoint.
    // `cache_control` composition (REQ-01 + REQ-02, CR-03):
    //   - `ttl` always sourced from `chooseTTL` (CN-08 — no raw literals).
    //   - `scope: "global"` only added when `cache_scope_global_enabled`
    //     flag is on; otherwise the field is absent. The .text content
    //     is byte-identical across every axis (flag/querySource/overage).
    if (input.globalRules) {
      blocks.push({
        type: "text",
        text: input.globalRules,
        cache_control: isCacheScopeGlobalEnabled()
          ? { type: "ephemeral" as const, ttl, scope: "global" as const }
          : { type: "ephemeral" as const, ttl },
      });
    }

    // Block 2: project rules + opencode body, joined with `\n\n` to
    // preserve Anthropic's text-block concatenation semantics. No
    // cache_control here — opencode core stamps slot 2 downstream.
    const middleParts: string[] = [];
    if (input.projectRules) middleParts.push(input.projectRules);
    if (opencodeText) middleParts.push(opencodeText);
    if (middleParts.length > 0) {
      blocks.push({
        type: "text",
        text: middleParts.join("\n\n"),
      });
    }

    // Block 3: volatile MEMORY.md tail — no cache_control.
    if (input.volatileMemory) {
      blocks.push({
        type: "text",
        text: input.volatileMemory,
      });
    }

    return blocks;
  }

  // ── OLD layout (kill-switch OFF, CR-03 byte-equivalent fallback) ─────
  // Single combined block of global + project + opencode, joined with
  // `\n\n` exactly as `provider.ts:638-651` produced before this PRP.
  // Volatile memory still rides on its own trailing block when present.
  //
  // No cache_control is stamped here — opencode core stamps slot 2 on the
  // combined block downstream. The `chooseTTL` wire-through (REQ-02) is
  // therefore a no-op in this fallback path; the `ttl` variable computed
  // above is intentionally unused on this branch. This preserves CR-03
  // byte-equivalence with the pre-PRP wire shape.
  const blocks: SystemBlock[] = [];

  const combinedParts: string[] = [];
  if (input.globalRules) combinedParts.push(input.globalRules);
  if (input.projectRules) combinedParts.push(input.projectRules);
  if (opencodeText) combinedParts.push(opencodeText);
  if (combinedParts.length > 0) {
    blocks.push({
      type: "text",
      text: combinedParts.join("\n\n"),
    });
  }

  if (input.volatileMemory) {
    blocks.push({
      type: "text",
      text: input.volatileMemory,
    });
  }

  return blocks;
}
