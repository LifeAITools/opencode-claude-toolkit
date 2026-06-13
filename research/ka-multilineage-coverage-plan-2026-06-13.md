# Plan — Multi-lineage + agent-family warm coverage (KA)

> Rebuilt around the CONFIRMED root cause (not the earlier voluntary-drop thesis).
> Source: `research/ka-cache-invariant-investigation-2026-06-13.md`. Repo `claude-code-sdk`, branch `feat/ka-keepwarm-cache-invariant`. All TDD, **no deploy**.

## Confirmed root cause (definitive — after 2 corrections)

- Session `48254e2e` used **5 distinct lineageKeys** today (model fable-5/opus + tool/version churn). Block lineage `2008a618e269:e0b80bbac296` last used **14:13**, resumed **16:20** → cold (>2h idle > 60m TTL) → `avoidable:ttl-expiry` 421k → blocked.
- **Correction 1 — NOT a voluntary drop:** debug log shows only 1 `owner_dead` today, zero `cache_expired`/`rearm_outlives_ttl`/`eviction`. KA did not "give up" a live cache. (Kills the earlier GAP1/GAP2 voluntary-drop thesis.)
- **Correction 2 — NOT a flat single-lineage bug:** empirically `registrySize` reaches **7** for other sessions today (counts: size1=32706, size2=3332, size3=182, **size7=1390**). The multi-lineage registry ALREADY works (Map keyed by lineageKey, per-lineage `eligible`/cap firing).
- **Coherent root cause:** the resumed lineage was almost certainly a **delegated `role:'sub'` lineage, which KA deliberately does NOT keep warm** — `keepalive-engine.ts:892` gate `role !== 'sub'` + comment L885-888 ("an idle sub-agent is finished, not parked"). So it was never KA-registered → never warmed → cold on **re-delegation/resume**. Fits ALL evidence: registrySize=1 (only the main lineage warm), zero disarm (the sub was never registered → nothing to disarm), block on resume. This is exactly the user's scenario: *keep accompanying/delegated agents warm while the main is alive, in case it re-delegates.*
- **Remaining forensic unknown (confirm in step 1):** the exact `role` tag of `2008a618e269` at registration is not logged in `PROXY_KA_TICK`; step 1 instruments/asserts it. The fix does not depend on the exact tag — the policy change (keep pinned/delegated workers warm under a live anchor) covers both "sub" and "aged-out recent lineage".

## Existing infrastructure (build ON it, don't rebuild)

- Registry is a `Map<lineageKey, RegistryEntry>` (`src/keepalive-engine.ts:541`) — CAN hold multiple lineages.
- Per-tick fire selection already multi-lineage: `eligible` = cache_control lineages past `fireThresholdMs`, sorted main→heaviest→stalest (L1316-1326), capped by `maxFiresPerTick` (`cap`, L1333-1334).
- **`role: 'main' | 'sub' | 'unknown'`** already plumbed (default `'main'` at L2295). **Registration gate L892: `role !== 'sub'`** — sub-agent lineages are deliberately NOT KA-registered (comment L885-888: "an idle sub-agent is finished, not parked"). ← the assumption to change.
- Owner liveness: `ILivenessChecker` (kill -0), `isOwnerAlive()`, `SESSION_DEAD pid_gone` (`proxy-client.ts:481`). Per-session pins `sessionPins` (`proxy-client.ts:413`, org-only today).
- Eviction breaker + `owner_dead` + `cache_expired_during_sleep` stops stay UNCHANGED (correct).

## Target model (user requirement)

Qualitatively distinguish a **main/orchestrator** agent (the long-lived liveness ANCHOR) from **accompanying/delegated** agents (workers it spawns/resumes). Keep ALL of the family's recently-active lineages warm **while the main/anchor process is alive** — so a re-delegation/resume to any of them is a warm READ, not a cold WRITE. Release the family when the anchor dies. Reads are ~free for the Max window (verified util5h≈0 under heavy KA) → cost is low; bound it anyway.

## Scope / Out of scope / Confidence

**Scope:** multi-lineage retention per session (bounded); keep delegated/worker lineages warm under a live anchor; family anchor (main pid) governing the warm-set; bounded cost (LRU cap + TTL-eviction + per-tick fire cap).
**Out of scope:** deploy (gated: divergence + active sibling session + `deploy-from-source.sh`); changing `models.ts` gates; the warm-read message-fingerprint (separate complementary track, kept optional).
**Confidence: 6/10** — infra exists and role distinction is half-built, but registry-retention mechanics (why size stays 1) still need a coding-time confirm; critical path; tests are the only validation (no live-verify).

## Steps (TDD, smallest correct, backward-compatible — never change `lineageKey`)

1. **Reproduce + fix single-lineage retention** `src/keepalive-engine.ts` + test — M.
   RED: register N≥2 distinct `role:'main'` lineages on one engine → assert registry retains all N (currently prunes/replaces to 1). GREEN: retain recent K lineages (bounded LRU by `lastWarmedAt`, default K e.g. 3), TTL-evict a lineage only when its own cache is provably dead (idle>TTL) AND not pinned. Confirm WHY size stayed 1 first (retention/replace path) — fix the root, not a symptom.
2. **Keep delegated/sub lineages warm under a live anchor** `src/keepalive-engine.ts` (L892 gate) + `src/proxy-client.ts` (role tagging) + test — M. Dep: 1.
   Change "idle sub = finished" → a sub/worker lineage flagged `pinned` (resumable) is KA-registered + kept warm while its anchor pid is alive; a truly-ephemeral Task sub (unpinned) keeps current behavior (not parked). RED: a pinned worker lineage idles past one interval → asserts it's still warmed (not dropped); an unpinned ephemeral sub → asserts dropped as today.
3. **Family anchor + pin registration** `src/proxy-client.ts` (+ control surface) + `src/keepalive-engine.ts` + test — L. Dep: 1,2.
   Register `(anchorPid, [sessionId/lineage], role)` via the existing MCP control surface / a request header from the orchestrator. Warm-set = main's lineages + pinned workers' lineages; kept while `isAlive(anchorPid)`; released on anchor death (extend `SESSION_DEAD` / `owner_dead` to family). RED: anchor alive → family kept warm across idle; anchor dies (kill -0 false) → whole family released.
4. **Bound + observability** `src/keepalive-engine.ts` + `src/keepalive-config.ts` + test — S. Dep: 1-3. 🔄
   Config knobs: `maxWarmLineagesPerSession` (K), `maxWarmSessionsPerAnchor`, reuse `maxFiresPerTick`. Emit `KA_FAMILY_*` debug + heartbeat counts; log every bound-driven drop (no silent truncation).

(Complementary, separate optional track — NOT gating this plan)
5. Warm-read coverage: message-prefix fingerprint in `src/lineage.ts:prefixHashes` (additive field, NOT touching `lineageKey`) → `blockColdStart` skips when a same-org+same-model warm sibling provably covers the prefix.

## Critical Files
`src/keepalive-engine.ts` (registry retention L860-916, fire-selection L1278-1340, drop paths L1090-1160, scheduleRearm), `src/proxy-client.ts` (role tagging, sessionPins L413, owner liveness), `src/keepalive-config.ts` (new bounds), tests under `test/keepalive-*.test.ts`.

## Risks & Mitigations
- **Quota blowup from warming a big family** → reads ~free (verified) + bounds (K per session, M per anchor, `maxFiresPerTick`) + TTL-eviction of genuinely-dead lineages + anchor-death release.
- **Keeping a truly-finished ephemeral sub warm (waste)** → only `pinned` workers kept; unpinned ephemeral subs keep current drop behavior (the existing L892 default).
- **Anchor never dies → warm forever** → kill -0 liveness is authoritative; add a max-idle ceiling per pinned worker as backstop.
- **Break `lineageKey` / existing KA semantics** → retention/role changes are additive; `lineageKey` formula untouched; full `test/keepalive-*` + `test/rewrite-guard.test.ts` must stay green.
- **No live-verify (no deploy)** → red→green test per invariant: retain-N, pinned-sub-kept, unpinned-sub-dropped, anchor-alive-keeps-family, anchor-dead-releases, bound-drops-logged.

## Next step
Execute step 1 TDD on branch `feat/ka-keepwarm-cache-invariant` (confirm the size-stays-1 root in a test, then fix retention). No deploy.
