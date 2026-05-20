---
created: 2026-05-17
purpose: "Document empirical and theoretical mechanics of Claude Max subscription quota consumption (`util5h`) by token kind"
keywords: [quota, util5h, five_hour, cache_write, cache_read, ephemeral_5m, ephemeral_1h, subscription, claude-max-stats]
status: active
prerequisites:
  - /home/relishev/PRPs/claude-code-discipline-sdk.md
  - /home/relishev/projects/vibe/claude-code-sdk/scripts/quota-report.ts
see_also:
  - section: "##Background — Anthropic Cache Mechanics"
    file: /home/relishev/PRPs/claude-code-discipline-sdk.md
    note: "PRP-level discussion of subscription-quota mechanics"
  - section: "##Phase 3 — Reverse-engineer subscription cost"
    file: /home/relishev/PRPs/claude-code-discipline-sdk.md
    note: "REQ-05, REQ-06, AC-01.2, AC-01.3"
---

# Subscription Quota Mechanics

## 1. Overview

This document captures **how Claude Max subscription quota (`rateLimit.util5h`, the 5-hour rolling window)
is consumed by different token kinds** — and how that mapping differs from the public `$`-pricing
multipliers documented for the API.

**Scope:**
- Subscription quota mechanics (`util5h` and `util7d`), as observed in
  `~/.claude-local/claude-max-stats.jsonl`.
- 5m vs 1h TTL cache_write quota cost.
- NOT in scope: API `$`-billing (covered in Anthropic public docs).

**Why this matters:**
Native Claude Code distinguishes 5m vs 1h cache TTLs internally (via the `o85()` allowlist heuristic at
cli.js offset `~11.8M`). Our SDK does too — but until Phase 3 of the
`claude-code-discipline-sdk` PRP shipped per-TTL telemetry capture (`cacheWrite5m` /
`cacheWrite1h` subfields in stats), we could only **aggregate** cache_write tokens, not split them.
This document is the operator's reference for interpreting the per-TTL split and tuning the TTL
allowlist (`DEFAULT_TTL_1H_ALLOWLIST`) to minimize quota burn.

## 2. Public facts (Anthropic docs)

Anthropic publishes the following `$`-pricing **multipliers** for prompt caching
(relative to the base input-token price):

| Token kind | Public `$`-multiplier vs base input |
|---|---|
| `cache_read_input_tokens` | **0.1×** (cached input is 10× cheaper) |
| `cache_creation` with default 5-minute TTL (`ephemeral_5m_input_tokens`) | **1.25×** |
| `cache_creation` with 1-hour TTL (`ephemeral_1h_input_tokens`) | **2.0×** |
| `input_tokens` (uncached) | **1.0×** (baseline) |
| `output_tokens` | varies by model (typically ~5× base input) |

Source: <https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing> (Anthropic public docs, sampled 2026-05-16).

**Theoretical prediction for quota:** if `util5h` consumption tracked `$`-pricing 1:1, then
the 1h cache_write quota cost should be **2.0 / 1.25 = 1.60×** the 5m cache_write quota cost
per token. Whether the subscription's `util5h` actually mirrors `$`-billing is **open**
(see §4).

## 3. Empirical findings from `claude-max-stats.jsonl`

Based on the `claude-max-stats.jsonl` snapshot **as of 2026-05-16** (N=8,675 entries within
`claim === "five_hour"` windows, summing tokens between Δ`util5h` jumps of ≥0.01):

| Token kind | Tokens per +1% `util5h` | Effective quota weight (vs `cR` baseline = 1.0×) | Note |
|---|---|---|---|
| `cacheRead` (cache_read) | ~10.1M | **1.0×** | the cheap one |
| `cacheWrite` (aggregate, 5m + 1h combined) | ~91K | **~111×** more expensive than cR per quota-unit | observed |
| `in` (uncached input) | very low (≪1K typical) | very heavy | observed |
| `out` (output) | ~22K | heavy | observed |

**Key finding #1 — cache_write is ~111× more quota-expensive than cache_read per `util5h`%.**
This is dramatically larger than the public `$`-pricing implies (1.25× / 0.1× = 12.5×). The subscription
appears to weight cache writes much more aggressively than the public `$`-pricing model — about a 9× gap.

**Key finding #2 — uncached input tokens are surprisingly heavy.**
Even though `in` counts are small per turn, they consume disproportionate quota. This is consistent
with `1.0× $`-pricing being scaled UP by the same subscription multiplier we suspect for cache writes.

**Key finding #3 (open):** The aggregate `cacheWrite` figure mixes 5m and 1h writes in unknown proportions.
Without per-TTL split, we cannot empirically measure the 5m-vs-1h ratio (see §4).

## 4. Open question — Phase 3 measurement target

**Question:** what is the empirical quota cost ratio of 1h cache_write vs 5m cache_write?
The theoretical prediction (from `$`-pricing) is **~1.6×**.

**Why open:** until Phase 3 Subtask 3.B (claude-max-proxy parses
`usage.cache_creation.ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens` into stats),
the aggregate `cacheWrite` field cannot be split. The optional `cacheWrite5m` / `cacheWrite1h`
subfields will be populated **only when the upstream API response includes them** — which
public docs confirm happens **when 1h TTL is in use**. Subscription-authenticated responses
may or may not include these subfields reliably; that is itself an empirical question.

**How to measure once 3.B ships:**

1. Operator sets `CACHE_CONTROL_TTL=5m` env var on opencode for ≥1 hour of representative traffic
   → stats accumulate cacheWrite5m, cacheWrite1h≈0.
2. Operator unsets env var (defaults to 1h-allowlist) for another ≥1 hour
   → stats accumulate cacheWrite1h, cacheWrite5m≈0.
3. Run:
   ```bash
   bun run scripts/quota-report.ts --since YYYY-MM-DD
   ```
4. Read the `5m vs 1h Cache-Write Quota Cost Comparison` section.

**Acceptance criteria** (per PRP M-Q3.3):
- ratio in **[1.1×, 2.1×]** → matches theoretical 1.6× within ±30% → confirms `$`-pricing maps to
  quota linearly. Phase 3 success.
- ratio outside that range → **documented empirical surprise** — update this document with the
  actual observed ratio and any hypotheses for why subscription differs from `$`-billing. Does
  not block Phase 4 progression.

## 5. How to read a `claude-max-stats.jsonl` entry

Each line is one JSON object. Current shape (with Phase 3.B optional additions):

```jsonc
{
  "ts": "2026-05-17T07:08:20.073Z",     // ISO timestamp
  "pid": 749881,                         // opencode process pid (debugging)
  "ses": "?",                            // session id (or "?" if not propagated)
  "type": "stream",                      // or "json", indicating response mode
  "model": "claude-opus-4-7",            // upstream model id
  "dur": 13941,                          // end-to-end latency, ms
  "stop": "tool_use",                    // stop_reason from API
  "usage": {
    "in": 1,                             // input_tokens (uncached)
    "out": 1014,                         // output_tokens
    "cacheRead": 83598,                  // cache_read_input_tokens
    "cacheWrite": 2680,                  // cache_creation_input_tokens (TOTAL, 5m+1h combined)
    // ─── Phase 3.B optional subfields (CR-15 OPTIONAL fields, only emitted when present) ───
    "cacheWrite5m": 0,                   // usage.cache_creation.ephemeral_5m_input_tokens
    "cacheWrite1h": 2680,                // usage.cache_creation.ephemeral_1h_input_tokens
    "cacheDeleted": 0                    // usage.cache_creation.cache_deleted_input_tokens
  },
  "rateLimit": {
    "status": "allowed",                 // "allowed" | "limited" | "throttled"
    "claim": "five_hour",                // "five_hour" | "seven_day" — which quota window
    "resetAt": 1779012000,               // unix seconds when this claim resets
    "util5h": 0.13,                      // FRACTION 0..1 of 5h quota consumed (13%)
    "util7d": 0.48                       // FRACTION 0..1 of 7d quota consumed (48%)
  }
}
```

**Field invariants (post-3.B):**
- When `cacheWrite5m` and `cacheWrite1h` are both present:
  `cacheWrite5m + cacheWrite1h === cacheWrite` (within rounding).
- When only `cacheWrite` is present (pre-3.B entries OR responses without subfields):
  treat all of it as TTL-unknown; the 5m/1h split is unrecoverable for those rows.
- `util5h` is **monotonically non-decreasing within a single 5h window**. When it drops
  (e.g., `0.97 → 0.02`), the window has rolled over — `quota-report.ts` handles this by
  discarding the in-progress accumulator at the reset point.

## 6. Quick playbook for operators

**Goal: minimize `util5h` burn.**

1. Run `bun run scripts/quota-report.ts` to see current burn-rate breakdown.
2. Look at the `cache_write (aggregate)` row in the "Tokens per +1% util5h" table.
   - If it's >100× cR baseline: cache_write dominates; tune the 1h-allowlist DOWN
     (fewer marker emissions per turn → fewer cache_write events).
3. Look at last 10 jumps: spot which jumps had the largest `cW_sum`. Those are the turns
   where cache_write was massive.
4. After Phase 3.B ships AND traffic flows under both TTLs, compare 5m vs 1h ratio
   in the `5m vs 1h Cache-Write Quota Cost Comparison` section.
   - If 1h ≥ 2× quota cost of 5m: consider narrowing `DEFAULT_TTL_1H_ALLOWLIST`
     (cli.js `o85()` precedent: only stable system blocks qualify for 1h).
   - If 1h ≤ 5m: surprise — document; do NOT change allowlist.

## 7. References

- **REQ-05** — SDK shall capture `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`
  from API responses into `claude-max-stats.jsonl` (Phase 3.B).
- **REQ-06** — A reporting script shall produce tokens-per-1%-util5h broken out by token kind
  (Phase 3.6: `scripts/quota-report.ts`).
- **AC-01.2** — `claude-max-stats.jsonl` aggregator reports 5-hour quota burn rate and token
  cost per 1% util5h, broken out by `cR` / `cW(5m)` / `cW(1h)` / `out`. **Reproducible from
  existing log file.**
- **AC-01.3** — Operator can answer "what TTL setting burns my quota slower for my use
  pattern?" empirically by reading one report.
- **PRP §Background — Anthropic Cache Mechanics** (claude-code-discipline-sdk.md ~line 100).
- **PRP §Subscription-quota mechanics** (claude-code-discipline-sdk.md ~line 115).
- **M-Q3.3** — empirical 1h/5m ratio within ±30% of theoretical 1.6× → success.
- **Anthropic public docs** — `<https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching>` (sampled 2026-05-16).

---

## TTL Profile Switching (Phase 2.5)

`~/.claude-local/keepalive.json` is the SSOT for cache TTL behavior. Both
provider (via `chooseTTL`) and proxy (keep-alive fires) read from it.

### Switching to 5m profile (for empirical testing)
1. Stop claude-max-proxy
2. Edit `~/.claude-local/keepalive.json`:
   ```json
   {
     "enabled": true,
     "cacheTtlSec": 300,
     "safetyMarginSec": 30,
     "intervalSec": 120,
     "retryDelaysSec": [1, 2, 3, 5, 10, 30]
   }
   ```
3. Restart claude-max-proxy (picks up new config at engine construction)
4. Restart opencode session (picks up new config on next chooseTTL call via 60s cache)
5. Verify sync: grep events.jsonl for `LEDGER_SYSTEM_BLOCK_LAYOUT` → both `ttl` and `keepalive_ttl_ms` should agree (`ttl=5m` ↔ `keepalive_ttl_ms=300000`).

### Switching back to 1h profile (production default)
Same procedure with:
```json
{"cacheTtlSec":3600,"safetyMarginSec":60,"intervalSec":1800,"retryDelaysSec":[2,3,5,10,15,20,30,60,120,300]}
```

### Mismatch detection
If you see `LEDGER_TTL_PROFILE_MISMATCH` events in events.jsonl, provider and
proxy disagree about TTL. This typically means:
- One side was restarted, other wasn't, OR
- keepalive.json was edited but config-cache hasn't expired yet (wait 60s)

The event payload includes `chosen_ttl_ms` (what provider wrote on the wire)
and `keepalive_ttl_ms` (what keepalive.json + SDK resolver said). Both numbers
let you diagnose which side is stale.

### What invalidates 5m vs 1h comparison data
If provider writes 1h cache_control but proxy fires every 30 min (intervalSec=1800),
cache may live the full 1h. But if provider writes 5m and proxy fires every 30 min,
cache expires before proxy's first fire → cold cache every turn. Always sync both.

---

_This document is **living** — update §3 empirical findings and §4 open-question status as
Phase 3 telemetry runs longer and Subtask 3.B captures per-TTL subfields in production._
