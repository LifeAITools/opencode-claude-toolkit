# Investigation — KA keep-warm + rewrite-guard cache invariant for resumable agents

> p-investigate findings (facts + file:line refs, NOT a plan). Feeds `/p-plan` → mini-PRP.
> Date: 2026-06-13. Repo: `/home/relishev/projects/vibe/claude-code-sdk` (source HEAD `b2d22e2`).
> Deployed proxy binary built from `843196f` (manifest `~/.local/share/claude-max-proxy/.deploy-manifest.json`).

## Question / Scope

Make the proxy uphold this invariant: **never drop a live-owner agent's prompt cache by our own choice while within TTL and Anthropic has not evicted it; aggressively revive on transient faults; keep resumable agents (persistent owner) warm — distinct from ephemeral Task agents; and never falsely block a spawn/resume that genuinely warm-reads a shared prefix.**

## Target invariant (desired end-state)

1. Owner/process alive + within TTL + no Anthropic eviction ⇒ KA NEVER voluntarily clears the cache.
2. Transient faults (401 waves, network blips) ⇒ aggressively revive within TTL, never give up while owner alive.
3. Stop only when: owner pid dead, OR Anthropic genuinely evicted (an unexpected `cache_creation` on a KA fire / eviction-breaker).
4. Resumable agents (persistent owner / orchestrator pid) kept warm; ephemeral Task sub-agents (own pid exits) dropped.
5. A spawn/resume whose leading prefix is provably warm (same org + same model + byte-identical prefix) is NOT blocked as a huge cold write.

---

## Findings

### A. KA drop/disarm paths — `src/keepalive-engine.ts`

`tick()` gate order:
- `if (this.retryTimer) return` (~L1092) — retry in flight, skip.
- `if (Date.now() < this.rearmHoldUntil) return` (L1096) — **during a fault back-off hold, ticks do NOT fire** (cache not refreshed for the hold duration).
- `if (this.registry.size === 0 && !this.trySelfHeal()) return` (L1099).
- **Layer 0a `owner_dead`** (L1104-1111): `if (!this.isOwnerAlive())` → `clearRegistry()` + `stop()` + `onDisarmed('owner_dead')`. ✅ correct per invariant (owner dead → stop).
- **Layer 0b `cache_expired_during_sleep`** (L1122-1138): `cacheAge = now − this.cacheWrittenAt; if (cacheAge > this.cacheTtlMs)` → `clearRegistry()` + `onDisarmed('cache_expired_during_sleep')`. Designed for laptop suspend/wake. 🔴 **GAP 1: does NOT consult owner-liveness and does NOT distinguish "host slept" from "our own fires were suppressed (rearmHold/back-off)".** Fires whenever cacheAge>TTL regardless of cause.
- **Layer 0c `eviction_breaker_tripped`** (L1151-1159): a sibling engine detected a GENUINE server-side cold-write eviction → `clearRegistry()` + `stop()`. ✅ correct = the user's "Anthropic dropped the cache itself" case.

`scheduleRearm()` (L1967-2019) — **called ONLY from the retry-exhaust path with a still-warm cache** (recovery cadence, not steady state):
- TTL-aware: ladder 30s→10m (L1982-1988, clamped to not leapfrog endgame), endgame ≤5m → 30s (L1978-1980), final ≤1m → 5s (L1975-1977), hard stop at `cacheDiesAt − rearmSafeEdgeMs` (L1970).
- `rearm_outlives_ttl` → `clearRegistry()` (L1996-2000) — the ONLY give-up branch: only when even a squeezed final attempt cannot start before the safe edge. Rationale (L1965): *"better a lost cache than a gambled rewrite."* 🔴 **GAP 2: for a LIVE owner this gives up instead of preferring an immediate controlled re-warm; and the back-off can let fires lapse past TTL.**
- `resetRearmState()` (L2022-2027) — clears fault state on fire success / real request.

External: `disarm(reason)` (L1011) `external_disarm`; `reload(reason)` (L1035) `external_reload` — admin/org-switch, user-initiated (OK).

Enumerated disarm/clear reasons (grep): `owner_dead`, `cache_expired_during_sleep`, `eviction_breaker_tripped`, `rearm_outlives_ttl`, `external_disarm`, `external_reload`, plus snapshot-store reasons `cache-already-dead`, `cache-dies-before-ka`, `no-snapshot`, `too-old`, `turn-boundary`.

Liveness primitive: `ILivenessChecker` via POSIX `kill(pid,0)` — `src/proxy-adapters.ts:199,254,262` (`DefaultLivenessChecker`); session dropped when `pid===1 || !isAlive(pid)`. `SESSION_DEAD reason='pid_gone'` emitted `src/proxy-client.ts:481`.

**Audit verdict:** invariant mostly upheld (owner_dead ✅, eviction_breaker ✅, external ✅). Two real gaps where a LIVE-owner cache is dropped by our own fault: GAP 1 (`cache_expired_during_sleep` ignores owner-liveness + cause) and GAP 2 (back-off/`rearm_outlives_ttl` can let a live-owner cache lapse instead of tight within-TTL firing).

### B. Rewrite-guard spawn/resume blocks — `src/proxy-client.ts`, `src/lineage.ts`

- `assessCacheMiss()` (L1774-1939): `ph = prefixHashes(body)`; `isFirstRequest = !prev`; warm-sibling detection is **same-session only** (`siblingPrefix = ${sessionId}:${sysHash}:`, L1856-1865); `kaHoldsWarmLineage(sessionId, lineageKey)` (def L1759) consulted at L1886 → first-request + KA-warm-snapshot ⇒ return `{assessment:null}` (allow); `predictedTokens = Math.round(bodyBytes/4)` (L1902) — **whole-body estimate**.
- Block decision (L1058-1138): `blockAvoidable` (L1069-1071) = `!expected && !(orgChanged && (orgHeld||reloadAsked||rotateConsumed)) && predictedTokens >= guard.minRewriteTokens`; `blockColdStart` (L1076-1078) = `rewriteClass==='expected:cold-start' && predictedTokens >= guard.minColdStartTokens` (founder directive 2026-06-12: a HUGE first write is an unconfirmed spend, block + consent even though "expected"). Consent = in-message marker `inspectLastUserMessage` OR `consumeConsent(grantPath, sessionId)` (single-use); 400 `cache_rewrite_guard` otherwise.
- `classifyRewrite()` (`src/lineage.ts:346-392`): `isKaFire`→`anomalous:stale-ka-snapshot`; `orgChanged`→`anomalous:org-switch`; `isFirstRequest && warmSiblingExists`→`expected:tools-changed`; `isFirstRequest`→`expected:cold-start`; `toolsChanged`→`expected:tools-changed`; `idle>ttl`→ `spansProxyRestart && !kaRevivalDropped ? expected:proxy-restart : avoidable:ttl-expiry`.
- **`avoidable:lineage-shift` is GONE from current source** — first-request now classifies as `expected:*` (never blocked by the classifier). The blocking of a large first spawn is now purely `blockColdStart` (huge `expected:cold-start`). The `avoidable:lineage-shift` dumps observed are from 2026-06-09 (pre-`843196f`).
- `prefixHashes()` (`src/lineage.ts:115-130`): hashes **ONLY `system` + `tools`** (`system` md5, `tools` md5, `toolNames` md5, `toolCount`). 🔴 **NO message-prefix fingerprint exists.** ⇒ the proxy cannot prove message-prefix overlap; a safe warm-read distinction REQUIRES adding a message-prefix fingerprint (the big spawn/resume context lives in messages, not system).

### C. Anthropic cache scoping + cost (km/docs, verified)

- **Org isolation**: caches isolated between organizations (km `48268d2a`). Within an org, shareable.
- **Prefix auto-matching**: API auto-reads ANY matching prefix; `cache_control` markers only control where NEW entries are WRITTEN (km `43250a40`). ⇒ a new agent warm-reads a sibling's matching prefix automatically — no proxy action needed for the READ; proxy must only NOT block + estimate cost correctly.
- **Per-model**: cache is model-specific (model switch = miss). ⇒ warm-read only helps SAME model.
- **Hierarchy**: cache prefixes built `tools` → `system` → `messages` (km `c4946303`); breakpoints up to 4; Claude Code uses BP at last message ⇒ nearly the whole body is cacheable prefix.
- **Pricing**: read 0.1×, write 1.25× (5m)/2× (1h); refreshed free on each use (km `49f172c6`, `927a2f7b`).
- **util5h/util7d are Anthropic's OWN numbers**, relayed from `anthropic-ratelimit-*` headers — `packages/claude-max-proxy/src/quota-watcher.ts:533` (`util5h = line.rateLimit?.util5h ?? null`). Proxy does NOT compute util from token counts.
- **KA fires = pure reads** (heartbeat `zeroCacheWrites == firesLastHour`). **Empirically KA-read cost to the Max window is ~negligible**: util5h held 0.03–0.07 under ~1100–1160 ticks/hr + 20–28 fires/hr each reading ~370k tokens; util5h=0 observed at 11:34 with `liveKa=11`. ⇒ the back-off ladder's cost-saving rationale is weak for live owners (reads barely move the window); the expensive event is the avoided cold WRITE.

### D. Empirical incident — resume of `48254e2e` (the "421k spawn block")

- Dump `~/.claude-local/rewrite-guard-blocks/2026-06-13T16-20-04-338Z-48254e2e-avoidable_ttl-expiry.json`: `rewriteClass=avoidable:ttl-expiry`, `predictedTokens=421157`, `idleMs=8,603,565` (143 min) > `ttlMs=3,600,000` (60 min), `systemChanged=false`, `orgChanged=false`, `prefixDiff.noBaseline=false` (RESUME, not fresh), `previousPrefix` present, `systemLen prev==cur=3868`. Owner `pid=487317` ALIVE. Request body ~2.1 MB (~420–540k tok).
- Narrative confusion: the orchestrator said "спавн заблокирован" but it was a **RESUME** of a bloated 6-round agent (mobile-media-editor-pwa PRP `on-device-as-lane`; doc `…/research/journey-identity-architecture.md`). 421k = the agent's accumulated transcript, NOT a fresh agent.
- Root: KA stopped firing for 143 min while owner alive → cache aged past TTL → `cache_expired_during_sleep`/`avoidable:ttl-expiry` → blocked. = GAP 1/2 in the flesh.

### E. CC_COMPAT_VERSION — ALREADY shipped (env)

- `config.ts:176` `read('CC_COMPAT_VERSION','2.1.152',fileEnv)`; `openai-translate.ts:965` default `'2.1.152'`, `setCompatVersion` (L968), used in `user-agent: claude-cli/${v}` (L1041) + billing header (L1058); wired `server.ts:338` `if (cfg.ccCompatVersion) setCompatVersion(cfg.ccCompatVersion)`.
- Fixed live via `~/.config/claude-max-proxy/.env` → `CC_COMPAT_VERSION=2.1.177` (deploy-safe; survives binary rebuild). Proxy restarted; verified `2.1.152` gone from log, `openai-10.10.23.2` (= container `payload-plugins-sandbox`, project `plugins`) no longer emits version-change.

### F. Deploy gate / divergence

- Deployed `843196f` (2026-06-12T21:58Z) vs source HEAD `b2d22e2` (moved `3cb4536→b2d22e2` mid-session — another session actively committing this repo). Gap = 2 UCM commits (REV6 palette, REV7 chart): only `packages/claude-max-proxy/src/modules/ucm-manifest.ts` + `package.json`, +40/−4, **no core/guard/KA changes** → low risk.
- Deploy ONLY via `packages/claude-max-proxy/scripts/deploy-from-source.sh` (manifest-verified; builds HEAD ⇒ ships the UCM commits + any new fix). Project `CLAUDE.md`: `models.ts` SSOT for model gates; never hand-edit `~/.local/share/claude-max-proxy`.

---

## Open questions

- Exact trigger that suppressed `48254e2e`'s KA fires for 143 min (fault episode setting a long `rearmHold`, vs ladder back-off, vs a transient `pid===1`/liveness blip) — narrows whether GAP 2 alone explains it or a fault path is also implicated.
- Should a live-owner re-warm after a self-inflicted lapse pay one controlled cold write (preserve resumability) or wait for the next real request? (semantics decision for the plan).
- Pin channel for "resumable, keep warm under orchestrator pid X": reuse the MCP control surface / `sessionPins` (currently org-only, `src/proxy-client.ts:413`) vs a new keepalive-lifetime pin.
- Message-prefix fingerprint shape (per-block cumulative hash chain) + storage in `lineagePrefix`/`prefixHistory` + backward-compat (must NOT change existing `lineageKey`).

## Suggested next step

`/p-plan` (or `/s0-init` → mini-PRP) for `claude-code-sdk`, scoping 4 coupled changes, all source + tests, **no deploy** (deploy gated on divergence reconcile + the other session finishing):
1. Owner-alive + cause gate on every voluntary drop (GAP 1): `cache_expired_during_sleep` / `rearm_outlives_ttl` must not silently drop a live owner; distinguish host-sleep (monotonic-clock jump) and Anthropic-eviction from self-inflicted lapse.
2. Tight within-TTL cadence for live owners (GAP 2): reads are ~free → never let back-off lapse the cache; prefer immediate controlled re-warm over give-up.
3. Resumable keep-warm pin tied to orchestrator pid (distinguish from ephemeral Task agents).
4. Warm-read coverage: add message-prefix fingerprint; in `blockColdStart`, skip the block only when a same-org+same-model warm sibling provably covers the prefix so the real cold-write tail < threshold (closes the false-block without reopening the silent-spend hole).
