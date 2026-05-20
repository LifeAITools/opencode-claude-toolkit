---
created: 2026-05-17
purpose: "Audit document — proposed cut points for sdk.ts / provider.ts god-objects, plus per-phase LOC budgets for this PRP's existing-file edits. Splitting itself is OUT OF SCOPE for this PRP and deferred to a future dedicated PRP."
keywords: [sdk-split, provider-split, god-object, refactor-debt, LOC-budget, CR-12, CR-13, SCALE-01, CLEAN-01]
status: active
prerequisites:
  - path: /home/relishev/PRPs/claude-code-discipline-sdk.md
    revision: 1.1.0
  - path: /home/relishev/PRPs/claude-code-discipline-sdk/02.5-architect-review.md
    revision: 1.0.0
  - path: /home/relishev/PRPs/claude-code-discipline-sdk/03-plan.md
    revision: 1.0.0
see_also:
  - file: packages/opencode-claude/src/cache-config.ts
    note: "Reference SSOT pattern that future split modules will mirror"
  - file: packages/opencode-claude/src/system-blocks.ts
    note: "Successful precedent for extracting a focused concern out of provider.ts"
---

# SDK Split Candidates — Audit Document

> **STATUS:** This document is **AUDIT ONLY**. No splitting happens in the Claude-Code-Discipline SDK PRP (rev 1.1.0). The split itself is a separate future PRP. This file exists to satisfy CR-12 + architect-review SCALE-01 + CLEAN-01: name the debt being accumulated, agree LOC budgets per phase, and lock in the abstract cut points so whoever picks up the split later inherits a thought-out plan rather than a 2K-line wall.

---

## 1. Current state (measured 2026-05-17, post-Subtask-1.A)

| File | LOC | Role | In-scope for this PRP? |
|------|-----|------|------------------------|
| `src/sdk.ts` | **2,145** | `ClaudeCodeSDK` class — OAuth, headers, request body, betas, fingerprint, streaming, retries, credential stores | YES — Phases 1, 2, 4 add call-site updates only (CR-13) |
| `packages/opencode-claude/provider.ts` | **1,675** | Vercel AI SDK v3 LanguageModelV3 adapter — prompt convert, image guards, body budget, tool remap, response/usage convert | YES — Phase 2 adds `chooseTTL` call sites (CR-13) |
| `packages/opencode-signal-wire/wake-listener.ts` | **2,105** | Signal-Wire wake-router listener (out of this PRP's scope) | NO — scope note per CR-12 + SCALE-01 only; listed here so the split PRP author sees the full inventory |
| `src/keepalive-engine.ts` | **1,087** | Keepalive engine (out of this PRP's scope) | NO — same as above; listed for completeness |

**Total god-object LOC across this package + sibling SDK = ~7,012.**

PRP scope touches the top two only. The bottom two are recorded here as part of the architectural inventory so the future split PRP starts from a complete picture rather than rediscovering them.

---

## 2. Proposed cut points for `src/sdk.ts`

`sdk.ts` is structurally a **request-pipeline file masquerading as a class**. Most private methods (`buildHeaders`, `buildRequestBody`, `buildBetas`, `computeFingerprint`) are stateless transforms of `GenerateOptions` → wire-format pieces, with the surrounding class only holding OAuth/credential state. That asymmetry is the cleanest seam.

| Proposed module | Extracted concerns | Approx LOC | Cut difficulty | Why this cut |
|---|---|---|---|---|
| `request-builder.ts` | `buildHeaders` (lines ~769-784), `buildRequestBody` (~785-952), most of `buildBetas` (~953-1030) | ~280 | Medium — pure functions but currently use `this.options` for `userAgent`/`extraBody`; would take an explicit config arg | Highest payoff. All three are pure given options + class config. Becomes test-in-isolation surface for Phase 2 `chooseTTL` integration. |
| `response-parser.ts` | SSE event parsing + `parseContextManagement` block extraction (currently inlined inside `generate()` / `stream()` around ~400-700) | ~250 | High — currently entangled with retry + token-rotation control flow; needs a "parse only, no IO" surface separated from the network layer | Phase 3 (`LEDGER_CACHE_BREAK`) + Phase 4 (`Compaction` round-trip) both need to inspect parsed response shapes. A clean parser module avoids both phases having to scrape the streaming loop. |
| `attribution.ts` | Billing/identity header construction (`x-app`, `User-Agent`, `X-Claude-Code-Session-Id`, `anthropic-dangerous-direct-browser-access`) — currently inlined in `buildHeaders` | ~60 | Low — already imported as constants in Subtask 1.A | Smallest, clearest cut. Header values rarely change but the *combination policy* (which header for which auth mode) is non-trivial and deserves its own test. |
| `betas.ts` | Beta-list constants (lines 63-74) + `buildBetas` selection logic (~953-1030) | ~200 | Low-Medium — beta constants are already pure; selection logic has 7 conditional branches keyed off model + options + flags | Decouples "what betas does this Anthropic API version know about" from "what does this SDK send right now". Future PRPs that add a beta touch only `betas.ts`, not the request pipeline. |

**Cumulative if all four cuts taken:** ~790 LOC moved out → `sdk.ts` ends at ~1,355 LOC (still large but no longer god-object territory). What remains: the `ClaudeCodeSDK` class + `FileCredentialStore` / `MemoryCredentialStore` (the legitimate stateful surface).

**Cut sequence recommended by the future split PRP:** `attribution.ts` first (lowest risk, smallest LOC, validates the extraction pattern) → `betas.ts` → `request-builder.ts` → `response-parser.ts` last (highest entanglement with retry control flow).

---

## 3. Proposed cut points for `packages/opencode-claude/provider.ts`

`provider.ts` is structurally a **bidirectional adapter**: opencode/AI-SDK shape ↔ Anthropic wire shape. Three coherent sub-concerns are tangled inside `createLanguageModel()` (lines 1133-1422) plus the top-level helpers.

The system-block layer was already extracted in a prior PRP (`packages/opencode-claude/src/system-blocks.ts`) — that extraction is the **template** for the cuts below.

| Proposed module | Extracted concerns | Approx LOC | Cut difficulty | Why this cut |
|---|---|---|---|---|
| `request-adapter.ts` | `convertPrompt` (~582-892), `convertTools` (~1014-1086), `convertToolChoice` (~1087-1096), `normalizeToolSchema` (~906-925), `TOOL_NAME_REMAP` table + repair helpers (~927-1000) | ~470 | Medium — already function-shaped but share a few module-level constants (the remap tables) which are clean to move along | Largest single payoff. The "translate opencode → Anthropic" half is structurally independent from the "translate Anthropic → opencode" half. |
| `response-adapter.ts` | `convertUsage` (~1097-1118), `convertFinishReason` (~1119-1132), and the streaming-result iterator (~1300-1422 inside `createLanguageModel`) | ~250 | High — streaming iterator currently closes over closure state from `createLanguageModel` for stats logging; would need an explicit telemetry interface | Pairs with `request-adapter.ts`. Phase 3 telemetry work needs to inspect usage; a stable response-adapter surface makes that hook explicit. |
| `cache-control-stamper.ts` | `cache_control` placement logic on the **messages** layer specifically — currently inlined inside `convertPrompt` and the streaming path | ~120 | Low-Medium — most cache_control on messages is opencode-core's responsibility (slot 4 in `BREAKPOINT_INVENTORY`), but provider.ts touches it for image-bearing tool_results | `system-blocks.ts` already owns the system-block layer (slot 1). The complementary module would own slots 3 + 4 on the messages layer. Together they'd cover every cache_control emission this package controls. |

**Cumulative if all three cuts taken:** ~840 LOC moved out → `provider.ts` ends at ~835 LOC (image guards + body-size budget + the slim `createLanguageModel` constructor wiring remain — appropriately small for the "this is how we satisfy LanguageModelV3" surface).

**Cut sequence recommended by the future split PRP:** `cache-control-stamper.ts` first (smallest, matches the existing `system-blocks.ts` precedent) → `request-adapter.ts` → `response-adapter.ts`.

---

## 4. Why splitting is deferred to a separate future PRP

Three independent reasons, any one of which would justify the deferral on its own:

1. **Splitting is higher-risk than this PRP's cache-discipline rollout.** Moving 1,000+ LOC of god-object code touches every test in the suite *and* every consumer of internal `private` methods. The cache-discipline PRP is gated by 6 single-named runtime flags with explicit observation windows; the split PRP needs its own observation strategy (probably a multi-week "old + new in parallel + assert byte-identical wire output" period). Trying to do both in one PRP doubles the regression surface for no behavior win.
2. **This PRP's per-phase LOC delta to god-objects is already explicit and bounded.** Section 5 below lists each phase's allowed budget. Whoever splits later inherits a *smaller* god-object than they would have if the split had been blocked on shipping behavior-first. (`sdk.ts` grows by ≤ ~100 LOC across all 6 phases per the budget; with one one-shot exemption in Phase 1 for the URL/header SSOT migration, which is actually *deleting* literal duplication.)
3. **The split should follow Phase 6 completion so the behavioral foundation is locked in.** If we split mid-PRP, Phase 4 (`Compaction` round-trip) and Phase 6 (`cache_edits`) land their call sites against modules that don't exist yet — forcing speculative interface design without empirical pressure from the real call sites. After Phase 6 completes, the empirical call-site pattern *is* the natural extraction surface. The split becomes a mechanical move-with-rename rather than a design exercise.

---

## 5. Acceptance — per-phase LOC budgets for existing god-objects

> **Rule:** any agent or operator modifying `src/sdk.ts` or `packages/opencode-claude/provider.ts` during Phases 2-6 of this PRP MUST stay within the per-phase LOC delta below OR explicitly request a budget extension in the execution log with rationale. This is the contract that prevents this PRP from making the god-object problem worse while it ships its behavioral changes.
>
> Source: PRP rev 1.1.0 plan §"Existing-file edit budget" (CR-13) + per-phase budgets recapped from each Phase section.

| Phase | Allowed delta to `sdk.ts` | Allowed delta to `provider.ts` | Notes |
|---|---|---|---|
| **Phase 1** (this PRP — Foundation Audit + SSOT) | Net **negative or near-zero** | Net **near-zero** | One-shot URL/header literal replacement may exceed +50 LOC in raw inserts but is offset by literal removals. **Naming refactor only — no new logic in god-objects.** |
| **Phase 2** (cache scope=global + chooseTTL) | ≤ **+50 LOC** | ≤ **+50 LOC** | `chooseTTL` lives in `cache-config.ts` SSOT — god-objects get call-site adapters only, never the function body. |
| **Phase 3** (telemetry parity) | ≤ **+20 LOC** | ≤ **+20 LOC** | New diff logic lives in NEW `cache-break-diff.ts` (CR-13). God-objects only receive an event-emit call site. |
| **Phase 4** (server-side `compact-2026-01-12`) | ≤ **+30 LOC** | ≤ **+10 LOC** | Round-trip logic lives in NEW `compaction-handler.ts` (CR-13). Beta-list addition (~5 LOC) + request/response wire-up (~25 LOC) accounts for the budget. |
| **Phase 5** (instruction hierarchy + AutoMem) | **0 LOC** | ≤ **+15 LOC** | All hierarchy/AutoMem code in NEW modules (`instruction-hierarchy.ts`, `automem-watcher.ts`). Provider.ts gets only the `dynamicMemory` slot wire-up. |
| **Phase 6** (cache_edits gating) | **0 LOC** | **0 LOC** | All Phase 6 code lives in `claude-max-proxy` package (gated to native-CC traffic only — CN-01 + CN-02). Neither `sdk.ts` nor `provider.ts` is touched. |

**Total cumulative budget across Phases 2-6:** `sdk.ts` ≤ +100 LOC; `provider.ts` ≤ +95 LOC. End-state god-object sizes if every phase consumes its full budget: `sdk.ts` ≈ 2,245 LOC, `provider.ts` ≈ 1,770 LOC — still in god-object territory but **measurably worse by no more than ~5%**. The future split PRP picks up from this measured ceiling.

**Budget extension protocol:** if a phase needs more LOC than its budget, the agent/operator opens an execution-log entry titled `Budget Extension Request — Phase N` documenting (a) what code is being added, (b) why it cannot live in a new module per CR-13, (c) what the next-phase budgets look like after this extension. Extension is granted by the operator in writing in the execution log, not by the agent unilaterally.

---

## 6. References

- **PRP:** `/home/relishev/PRPs/claude-code-discipline-sdk.md` rev 1.1.0
  - `CR-12` — "Phase 1 produces packages/opencode-claude/docs/sdk-split-candidates.md BEFORE any phase modifies sdk.ts/provider.ts"
  - `CR-13` — "Logic added by Phases 2-6 lands in NEW files, NOT appended to existing 1K+ line files"
- **Architect review:** `/home/relishev/PRPs/claude-code-discipline-sdk/02.5-architect-review.md` rev 1.0.0
  - `SCALE-01` — god-object size scan finding (sdk.ts 2,145 + provider.ts 1,675 + 2 sibling files at 1K+)
  - `CLEAN-01` — "existing god-objects must not grow further; new behavior in new modules"
- **Plan:** `/home/relishev/PRPs/claude-code-discipline-sdk/03-plan.md` Phase 1 §Task 1.7, all Phase 2-6 §LOC budget statements
- **Reference precedent (successful prior extraction):** `packages/opencode-claude/src/system-blocks.ts` — system-block assembly extracted from `provider.ts` in the prior `opencode-cache-prefix-stability` PRP rev 1.4.0. Same pattern, same SSOT discipline, recommended template for the future split PRP.
