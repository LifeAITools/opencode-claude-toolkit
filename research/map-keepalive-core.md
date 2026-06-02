# Keepalive/Session Core Architecture Map

**Last Updated:** 2026-06-02  
**Scope:** Complete structural analysis of session lifecycle, KA engine state management, snapshot storage, and token handling.

---

## 1. SESSION LIFECYCLE

### Session Creation & Storage
- **Files:** `src/proxy-ports.ts:121-141` (Session interface), `src/proxy-client.ts:600` (getOrCreate call)
- **Store:** `ISessionStore<KeepaliveEngine>` — key-value store with getOrCreate factory pattern
- **Session State Holds:**
  - `sessionId`: string (unique identifier)
  - `pid`: number | null (owner process ID for JIT liveness check)
  - `firstSeenAt`: number (ms epoch)
  - `lastRequestAt`: number (ms epoch, updated on every real request)
  - `engine`: KeepaliveEngine (opaque to store, one per session)
  - `model`: string | null (last observed)
  - `lastUsage`: TokenUsage subset (cache-related fields optional)

### Session Death (pid_gone)
- **Location:** `src/proxy-client.ts:424-450` (reaper loop)
- **Trigger:** `store.reapDead()` called every 10s, checks `isOwnerAlive(pid)` via `ILivenessChecker`
- **Outcome:** Session + engine removed from store; event emitted with `kind: 'SESSION_DEAD'` + `reason: 'pid_gone'`
- **Side Effects on Death:**
  - Prefix history dropped (all keys matching `${sessionId}:${lineageKey}`)
  - Lineage-prefix map cleared
  - KA-revival-dropped set pruned
  - `kaSnapshotDirty = true` triggers persistent registry update

### Per-Session KA Engine Location
- **Single Instance:** One `KeepaliveEngine` per session, stored opaquely in `Session.engine`
- **Lifecycle:** Created via `engineFactory()` in `getOrCreate()`, destroyed on reaper `reapDead()` via `store.stopAll()`
- **Ownership:** Engine's state (registry, timers, snapshots) is completely isolated per session
- **No Sharing:** Each engine has its own ticker, abort controller, health probe, quota-pause state

---

## 2. KEEPALIVE ENGINE — INTERNALS & STATE FLOW

### Constructor (src/keepalive-engine.ts:558-625)
**Inputs (KeepaliveEngineOptions):**
- `config`: KeepaliveConfig (optional, sensible defaults)
- `getToken`: () => Promise<string> — fetches fresh access token (caller handles refresh)
- `doFetch`: (body, headers, signal) => AsyncGenerator<StreamEvent> — performs HTTPS request
- `getRateLimitInfo`: () => RateLimitInfo — snapshot from last response
- `isOwnerAlive?`: () => boolean — JIT PID liveness check (optional, defaults to always-true)
- `evictionBreaker?`: EvictionCircuitBreaker (optional, shared across engines in proxy)

**Cache TTL Resolution (Lines 568-579):**
- Constructor accepts `cacheTtlMs` override (proxy pinning native CC to 5m)
- When override provided: `cacheTtlOverridden = true`, TTL locked, SSOT live-reload skipped
- When override absent: read from SSOT (~/.claude/keepalive.json), `cacheTtlOverridden = false`
- Live-reload in `tick()` (lines 1089-1102) refreshes SSOT unless overridden or observed-locked

**Wire-Autoscan Downlock (Lines 732-748):**
- `notifyRealRequestStart()` detects actual `cache_control` TTL markers in request body
- If observed TTL < current `cacheTtlMs`: sets `cacheTtlObservedLocked = true`, engine caps itself to that shorter value
- Monotonic downlock only — can never raise TTL again (conservative: once we see a 5m block, assume it may still be alive)
- Blocks SSOT live-reload from raising TTL back up

### Public API Contract

#### `notifyRealRequestStart(model, body, headers) → string`
**File:** Lines 635-764  
**Purpose:** Prime the pending snapshot slot before sending the real request; abort any in-flight KA for THIS lineage.

**Steps:**
1. Wake from quota pause (lines 639)
2. Compute `lineageKey = lineageKey(body)` (hash of system+tool-names, stable identity)
3. Track per-lineage stats: `firstSeenAt`, `lastSeenAt` (real requests only), `lastWarmedAt`, `maxToolCount`, `resumedAfterIdle`
4. Classify agent role via `classifyRole(body, headers, hints, roleDetector)` — yields 'main' | 'sub' | 'aux' | 'unknown'
5. **TTL Wire-Scan:** Call `detectCacheTtlFromBody(body)` (lines 696-727)
   - Finds minimum TTL across all cache_control markers
   - Fires `onTtlScan` callback if TTL changed
   - Logs to `~/.claude/claude-max-debug.log` for audit
   - If unmarked override/lock: downlock engine's `cacheTtlMs` if scan result is shorter
6. Deep-copy body + headers into pending snapshot for this lineage (lines 682-687)
7. Abort in-flight KA fire **only if** it's for the SAME lineage (lines 755-759)
8. Return lineageKey for caller to pass back to `notifyRealRequestComplete()`

**Critical:** Separate pending snapshot per lineage prevents concurrent sub-agent + main-agent from clobbering slots.

#### `notifyRealRequestComplete(usage, lineageKeyArg?) → void`
**File:** Lines 777-840  
**Purpose:** Register the pending snapshot for KA after successful real request; start or resume timer if registry non-empty.

**Steps:**
1. Update timestamps: `lastActivityAt = now`, `lastRealActivityAt = now`, `cacheWrittenAt = now`
2. Resume network health (lines 784-791): if degraded + probe running, switch to healthy, fire callback
3. Resolve which lineage completed (explicit `lineageKeyArg` or fallback to `_legacyPendingLineage`)
4. Clear org-switch-pending for this lineage (user proceeded, override accepted or old token expired)
5. **Registry Gate: Role + Token Check (lines 809-826)**
   - Only register if `role !== 'sub'` (sub-agents self-warm via own traffic, never parked)
   - Only register if `totalTokens >= minTokens` (lightweight calls like quota-check skip KA)
   - Heaviest-wins within same lineage: if entry exists and new `totalTokens < existing`, skip re-register
   - **CRITICAL:** Registry entry captures the SNAPSHOT AT THIS MOMENT
     - `body`: full Anthropic request (system, messages, tools, cache_control markers)
     - `headers`: full set, INCLUDING `Authorization: Bearer ${token}` from the real request
     - `model`: identified
     - `lineageKey`: stable cache-family identity
     - `role`: classified agent role
     - `hasCacheControl`: Layer 3 gate — if false, KA fire skips this entry
6. Detect cache_control presence in body (line 807)
7. Track per-model cache size (line 830-831) for rewrite-guard estimates
8. Write snapshot debug metadata (line 834)
9. Call `startTimer()` if registry non-empty (line 839)

**Token Handling:** The Authorization header in the snapshot is CAPTURED VERBATIM from the real request at completion time. This is the "live" token at that moment, not a pinned/cached copy.

#### `markOrgSwitchPending(lineageKeyArg) → void`
**File:** Lines 842-847  
**Purpose:** Flag a lineage as waiting for user to decide on org change.

**Semantics:**
- Called when ProxyClient's rewrite guard blocks an org-switch request
- While pending: KA fires replay the snapshot's OWN (old-org) Authorization header (line 2216-2218)
- Cleared on next `notifyRealRequestComplete()` (line 800) when user proceeds
- Cleared on `clearRegistry()` (terminal disarm)

#### `reload(reason) → void`
**File:** Lines 944-962  
**Purpose:** Non-destructive disarm — drop stale snapshots, keep timer running for auto-resume.

**Steps:**
1. Log diagnostics (line 945)
2. Abort in-flight KA + null controller (lines 946-947)
3. Clear retry timer (lines 949)
4. Clear registry (`clearRegistry()` line 953)
5. **SET `selfHealEligible = true`** (line 958) — engine WILL re-prime from `lastSnapshots` on next idle tick
6. Leave tick timer alive — next tick will either self-heal or no-op
7. Fire `onDisarmed` callback with reason

**Key Difference from `disarm()`:** `disarm()` calls `stop()` which nulls the timer; `reload()` intentionally leaves it running so the engine auto-resumes when next real request re-registers a snapshot.

#### `disarm(reason) → void`
**File:** Lines 920-925  
**Purpose:** Hard stop — clear registry, fire callback, stop all timers.

**Used for:** Admin operations (e.g., `claude-max disarm` before org swap) when the caller wants the engine to stop immediately.

#### `checkRewriteGuard(model) → void`
**File:** Lines 868-886  
**Purpose:** Guard against accidental cache_write bursts after long idle.

**Logic:**
1. Measure idle time since `cacheWrittenAt` (last cache touch: real request OR successful KA fire)
2. If `idleMs < rewriteWarnIdleMs` (default 5m): return (normal working)
3. If `idleMs >= rewriteWarnIdleMs` AND estimated cache size >= rewriteWarnTokens: fire `onRewriteWarning` callback
4. If `idleMs >= rewriteBlockIdleMs` AND `rewriteBlockEnabled`: throw `CacheRewriteBlockedError`

**Critical:** Uses `cacheWrittenAt` (touched by KA fires too), NOT `lastRealActivityAt` (only real requests). Accounts for KA keeping cache warm.

#### `stop() → void`
**File:** Lines 889-907  
**Purpose:** Full shutdown — clears all timers, aborts in-flight, clears registry.

---

### Private: tick() — The Keepalive Fire Loop
**File:** Lines 980-1344  
**Frame:** Called every ~30s by `setInterval` (configured as 1/6 of `intervalMs`, clamped [5s, 30s])

**Pre-Fire Disarm Gates (Layers 0a-0c, Lines 1001-1059):**
- **Layer 0a — Owner Alive Check:** If `isOwnerAlive()` → false, disarm + stop. Saves KA into dead owner's cache.
- **Layer 0b — Cache Expired During Sleep:** If `cacheAge > cacheTtlMs`, cache died on TTL despite offline interval. Disarm (don't fire, would cache_create fresh cache user didn't ask for).
- **Layer 0c — Eviction Breaker Tripped:** If shared `evictionBreaker.isTripped(now)`, a sibling engine detected server-side eviction. Disarm (drop stale snapshot, wait for next real request to prove user is back).

**Live Config Reload (Lines 1061-1137):**
- Call `loadKeepaliveConfig()` (mtime-cached, cheap)
- If disabled: disarm, stop, return
- **Cache TTL Live-Reload** (lines 1089-1102):
  - Only apply if `!cacheTtlOverridden && !cacheTtlObservedLocked`
  - Update `cacheTtlMs`, safety margin, interval clamps
  - Log changes to debug log (audit trail)
- Apply new interval (clamped to effective range based on current cache TTL), idle timeout, min tokens

**Idle Timeout (Lines 1139-1146):**
- If real idle > `idleTimeoutMs` (default Infinity): disarm, stop, return

**Self-Heal Attempt (Line 998):**
- If registry empty but `selfHealEligible`: try `trySelfHeal()` to re-prime from `lastSnapshots` for a live idle session

**Registry Selection (Lines 1148-1174, Layer 3):**
- Pick heaviest entry: prefer `role === 'main'` over `unknown`, within role tier use highest `inputTokens`
- **Gate: Only consider entries with `hasCacheControl === true`** (if false, fire refreshes nothing)
- If no valid candidate: log and return

**Per-Lineage Idle (Lines 1176-1182):**
- Use lineage-specific `lastWarmedAt` (touched by REAL REQUESTS and successful KA fires)
- NOT global `lastActivityAt` (masked by sub-agent traffic)
- This is the KA decision idle clock — main agent goes idle while sub-agents keep global active

**Fire Decision (Lines 1187-1202):**
- Seed jitter on first eligible tick (random 0-30s, deterministic 0 honored for tests)
- Fire onTick callback (always, gives provider visibility)
- If `idle < 0.9*intervalMs + jitterMs`: not yet time, return
- Otherwise: FIRE

**Fire Logic (Lines 1204-1299):**

1. **Set in-flight flag** (lines 1205-1206)
2. **Clone body + set max_tokens** (lines 1209-1211):
   - Deep copy so mutations don't bleed to stored snapshot
   - If body has thinking budget: `max_tokens = budget + 1`, else `1` (KA never writes, never generates output)
3. **Fetch fresh token or replay old-org (lines 2216-2218):**
   - If lineage marked `orgSwitchPending` AND snapshot has Authorization header: use old header (keep old org warm)
   - Otherwise: call `getToken()` for fresh token → `Authorization: Bearer ${fresh}`
   - **THIS IS THE CRITICAL DECISION:** KA fire uses either the captured snapshot's auth (if org-switch pending) or a fresh token (if normal flow)
4. **Iterate `doFetch(body, headers, signal)`** (line 2226), drain all SSE events, capture final `message_stop.usage`
5. **Update timers** (lines 2231-2237):
   - `lastActivityAt = now` (spacing fires)
   - `cacheWrittenAt = now` (cache presumed fresh)
   - Update lineage's `lastWarmedAt` (per-lineage idle clock)
6. **Layer 5: Eviction Detection (Lines 2253-2299):**
   - Check `usage.cacheCreationInputTokens` vs `usage.cacheReadInputTokens`
   - If `cw > 10k && cr < cw*0.1`: cold-write signature = evicted cache on Anthropic side
   - Call `isServerSideEviction({cw, cr, msSinceLastRealRequest, intervalMs})` to rule out local causes
   - If genuine server-side: trip `evictionBreaker`, disarm, stop, return
7. **Fire success callback:** `onHeartbeat(usage, duration, idle, ...)`

**Error Handling (Lines 1300-1338):**
- Classify error via `classifyError(err)` → 'network' | 'server_transient' | 'auth' | 'permanent'
- **'network':** Start health probe (TCP only, no tokens), decide revive-mode based on TTL
- **'server_transient':**
  - 429 (quota): call `handleQuotaRateLimit()` — smart pause vs disarm based on resetAt vs cache TTL
  - 5xx/503/529: call `retryChain()` with exponential backoff
- **'auth':** Disarm (token issue, consumer's responsibility to refresh)
- **'permanent':** Disarm (malformed request, etc.)

---

## 3. SNAPSHOT STORE (ka-snapshot-store.ts)

### What a Snapshot Holds
**File:** Lines 55-79  
**PersistedRegistryEntry = PersistedEngineState.registry[*]:**
- `body`: Record<string, unknown> — full Anthropic request (system, messages, tools, cache_control markers)
- `headers`: Record<string, string> — full header set
- `model`: string
- `lineageKey`: string (hash of system ⊕ tool-names)
- `role`: string ('main' | 'sub' | 'aux' | 'unknown')
- `inputTokens`: number (for heaviest-wins selection)
- `hasCacheControl`: boolean (Layer 3 gate)

**PersistedEngineState (the full engine state to revive KA post-restart):**
- `cacheWrittenAt`: number (ms, absolute — last SERVER-CONFIRMED warm-up)
- `cacheTtlMs`: number (effective TTL the engine was using)
- `cacheTtlOverridden`: boolean (admin locked it)
- `cacheTtlObservedLocked`: boolean (wire-autoscan downlocked it)
- `lastObservedTtlMs`: number | null (min TTL from wire autoscan)
- `ttlEverObserved`: boolean (autoscan has run)
- `lastKnownCacheTokensByModel`: Record<string, number> (per-model cache size history)
- `registry`: PersistedRegistryEntry[] (all armed snapshots at persist time)

### Snapshot Keying
**File:** Line 57, and runtime in keepalive-engine.ts
- **Not org-keyed:** NO per-snapshot organization ID stored
- **Not token-keyed:** NO per-snapshot access token stored separately
- **Lineage-keyed:** Registry keyed by `lineageKey` (hash of system ⊕ tool-names)
- **Session-keyed:** Full state persisted under `sessionId` in the KA snapshot file

### How Snapshots Are Persisted & Revived
**Load (Lines 107-133):**
- Called at `ProxyClient` construction
- Reads `~/.claude-local/proxy-ka-snapshots.json` (default, injectable)
- Validates schema version + shape; corrupt/missing file yields empty (graceful degrade)
- For each persisted session: shape-validate, retain only entries with non-empty registry

**Save (Lines 139-150):**
- Called by `persistKaSnapshots()` on interval (if `kaSnapshotDirty`) or on shutdown
- Overwrites file with version stamp + `savedAt` + all sessions
- Best-effort — write failure swallowed (never breaks request path)

**Revival Verdict (Lines 192-223):**
- Pure logic: given persisted engine state + current time + config, decide revive-vs-drop
- **Drop reasons:**
  - `no-snapshot`: registry empty
  - `too-old`: `age > maxAgeMs` (default 1h, bounds file growth)
  - `cache-already-dead`: `now >= cacheDiesAt` (cache expired before we even revived)
  - `cache-dies-before-ka`: cache will die before next fire can land (conservative wait calc)
- **Revive:** If cache will definitely still be alive after revived engine's first tick fires

**Critical Assumption:** `cacheWrittenAt` is ABSOLUTE wall-clock ms (set only after real response's `message_stop` or successful KA fire). Revived engine seeded with `lastActivityAt = cacheWrittenAt`, so next fire eligible at ~`0.9*interval` later. Cache must survive that + fire round-trip.

### Token Handling During Revival
**File:** Lines 68-71 (captured state)  
**In Practice (keepalive-engine.ts:~1082):**
```typescript
const session = this.store.getOrCreate(sid, ps.ownerPid, () => this.createEngine(sid))
// Engine is created with fresh getToken DI callback
// On first fire, calls fresh getToken() → fresh token
```
**Decision:** Snapshots capture the `headers` (including Authorization) from the real request that registered them. But on revival, the engine gets a NEW `getToken` callback. So:
- KA fire after revival: calls `getToken()` → gets **fresh token from current credentials**
- Exception: if `orgSwitchPending` flag set: replay snapshot's old Authorization (keep old org warm until user decides)

**Conclusion:** Snapshots do NOT pin tokens permanently. They capture the token at registration time for audit/debugging, but fires use fresh tokens unless org-switch-pending.

---

## 4. LINEAGE IDENTIFICATION & CLASSIFICATION

### lineageKey(body) — Cache Prefix Family Identity
**File:** Lines 83-92  
**Formula:**
```
lineageKey = md5(systemToString(system), 12) : md5(toolNames(tools).join(' '), 12)
```
- System: filtered to blocks WITH cache_control (volatile per-request blocks excluded)
- Tool-names: sorted, stable regardless of definition order
- Hash: 12-char MD5 hex

**Never throws.** Invalid input → 'unknown' lineage.

**Semantics:** Same lineageKey = same cache prefix family (Anthropic cache identity). Different tool sets, different lineages. Different model, SAME lineage (model is per-request variation, not a lineage driver).

### classifyRole(body, headers, hints, weights) — Agent Role Detection
**File:** Lines 222-278  
**Returns:** `{ role: AgentRole, confidence: 0..1, basis: string }`

**AgentRole:**
- `'sub'`: Claude Code sub-agent (has `x-claude-code-agent-id` header) → never KA'd
- `'main'`: Main agent (no agent-id, real tool set, scores >= threshold) → KA'd
- `'aux'`: Lightweight internal call (no agent-id, ≤1 tool: quota check, title-gen) → never KA'd
- `'unknown'`: Could be main but low confidence (no agent-id, real tool set, scores < threshold) → treated as over-KA-safe candidate (cost asymmetry: under-KA expensive, over-KA cheap)

**Scoring (tunable via SSOT ~/..claude/keepalive.json, hot-reloaded):**
- Baseline: 0.1 (no agent-id present)
- +0.4 if spawn-tool detected (agent/task/spawn/delegate/etc.)
- +0.5 if resumed-after-idle (STRONGEST behavioral signal)
- +0.2 if oldest-in-group
- +0.2 if richest-tools-in-group
- Threshold: 0.5 (default)
- Two positional signals alone (oldest + richest) = 0.4 = `unknown`, needs boost from spawn-tool or resume

### RewriteClass — Cache Rewrite Taxonomy
**File:** Lines 284-292  
**Full Enum:**
```typescript
'expected:cold-start'          // first request of session — unavoidable
'expected:compact'             // user ran /compact — deliberate history rewrite
'expected:tools-changed'       // MCP connect/disconnect — one-off
'expected:proxy-restart'       // prefix died during proxy gap (KA engine didn't exist)
'avoidable:ttl-expiry'        // stable prefix died on TTL — KA should have prevented
'anomalous:stale-ka-snapshot' // KA fire replayed evicted snapshot — proxy bug
'anomalous:org-switch'        // snapshot cached under different org — cross-bills new org
'unknown'
```

### classifyRewrite(ctx) — Rewrite Detection
**File:** Lines 336-372  
**Context fields (RewriteContext):**
- `isFirstRequest?`: boolean
- `toolsChanged?`: boolean
- `idleMs?`: number (ms since last request)
- `ttlMs?`: number (cache lifetime)
- `isKaFire?`: boolean (detected on KA fire, not real request)
- `spansProxyRestart?`: boolean (cache warm-up predates this proxy process start)
- `kaRevivalDropped?`: boolean (KA-snapshot persistence had snapshot but dropped it as stale)
- `orgChanged?`: boolean (prefix org != current org)

**Decision Tree:**
1. If `isKaFire`: `anomalous:stale-ka-snapshot` (KA fire should never hit cold cache)
2. If `orgChanged`: `anomalous:org-switch` (cross-org spend hazard, ranks highest)
3. If `isFirstRequest`: `expected:cold-start`
4. If `toolsChanged`: `expected:tools-changed`
5. If `idleMs > ttlMs` (idle past TTL):
   - If `spansProxyRestart && !kaRevivalDropped`: `expected:proxy-restart` (engine didn't exist across gap)
   - Else: `avoidable:ttl-expiry` (KA should have kept it warm)
6. Default: `unknown`

**Verdict:** `expected:*` (including first cold start) is normal; `avoidable:*` / `anomalous:*` are problems requiring user attention.

---

## 5. ORG & TOKEN PINNING — CURRENT STATE

### Per-Session Token Pinning
**Status:** NO permanent per-session token pinning exists.

**Evidence:**
- Snapshots capture `headers` (including Authorization from real request at registration time)
- But on KA fire, engine calls `getToken()` to fetch **fresh token** (lines 1216-1218 in keepalive-engine.ts)
- Exception: `orgSwitchPending` flag forces replay of snapshot's old Authorization (lines 1216-1218)

**Semantics:**
- Default KA fire: fresh token from current credentials provider (refresh-safe, follows credential rotation)
- Org-switch-pending: old token from snapshot (keep old org's cache warm until user decides or token expires)

### Per-Session Org Pinning
**Status:** PARTIAL org awareness, NO permanent per-session org pinning at KA level.

**Where Org Appears:**
1. **Prefix History (proxy-client.ts:265-280):**
   - Per-session, per-lineage: `prefixHistoryEntry.orgId` (string | null)
   - Tracks which org a lineage's prefix was cached under
   - Used by rewrite guard to detect `anomalous:org-switch`
   - Persisted to `~/.claude-local/proxy-prefix-history.json`

2. **Rewrite Guard (proxy-client.ts, org-identity.ts):**
   - On each real request: fetch current org via `orgIdResolver.getOrgId()` (FileOrgIdResolver reads ~/.claude.json)
   - Compare against prefix history's `orgId`
   - If different: set `rewriteContext.orgChanged = true` → block request if guard enabled
   - Block reason: `anomalous:org-switch` — replaying prefix burns wrong org's quota

3. **KA Snapshot Store (ka-snapshot-store.ts):**
   - `PersistedEngineState` does NOT capture org ID
   - Snapshots are per-session + per-lineage, not per-org
   - Revival logic DOES NOT check org context (caller's responsibility)

### Org-Switch Pending Flag
**File:** keepalive-engine.ts lines 514-522, 845-847  
**What it does:**
- `orgSwitchPending: Set<string>` — set of lineage keys awaiting org-switch decision
- When proxy-client blocks an org-switch rewrite: calls `engine.markOrgSwitchPending(lineageKey)`
- While set: KA fire replays snapshot's OWN (old-org) Authorization header (lines 1216-1218)
- Cleared when: user re-sends request (`notifyRealRequestComplete()` deletes the flag) OR session ends

**Semantics:** Keeps old org's cache warm while user decides whether to proceed with new org. On next real request, if user proceeds, new org's token is used (fresh from getToken).

### Cross-Org Quota Billing Hazard
**Risk:** If KA fire replayed a snapshot registered under Org A while Org B is now active, the full cache_read tokens burn Org B's quota.

**Mitigation (NOT at KA level):**
1. Rewrite guard detects org mismatch BEFORE request → blocks interactive clients
2. During org-switch window: `orgSwitchPending` flag keeps old-org's Authorization alive
3. On next real request: user's token (new org) is used for re-registration

**Conclusion:** KA does NOT automatically handle org switches. Proxy's rewrite guard + org-switch-pending flow prevents accidental cross-org charge.

---

## 6. EVICTION CIRCUIT BREAKER (eviction-breaker.ts)

### Shared Cross-Engine State
**File:** Full file  
**Shared Instance:** One `EvictionCircuitBreaker` per proxy, passed to every engine's constructor.

### Trip Decision: isServerSideEviction()
**File:** Lines 49-74  
**Inputs:**
- `cacheWrite`: cache_creation tokens on KA fire
- `cacheRead`: cache_read tokens on KA fire
- `msSinceLastRealRequest`: time since lineage's last REAL request (KA fires excluded)
- `intervalMs`: engine's KA interval

**Logic:**
1. Cold-write signature: `cw > 10k && cr < cw*0.1` (large creation, near-zero read)
2. No local cause: `msSinceLastRealRequest > intervalMs` (no recent real request that could have slid prefix locally)
3. **Result: trip breaker only if BOTH conditions true**

**Reasoning:** A recent real request (incl. user-authorized rewrite) slides the prefix locally → cold write has a local cause → don't signal the fleet. Only a stable, KA-only-warmed snapshot going cold indicates server-side eviction.

### Trip Record & Hold Duration
**File:** Lines 127-150  
**trip(now, meta):** Record detection with metadata (session, lineage, cw, cr)  
**isTripped(now):** Fleet should hold fires if:
- Trip count within window >= `minTripsToEngage` (default 1)
- AND most recent trip still within `cooldownMs` (default 5 min from trip time)

**Cooldown:** Short enough to let every armed engine hit at least one tick (resolves in 5-30 min depending on KA intervals).

### Breaker's Effect on Each Engine
**File:** keepalive-engine.ts lines 1050-1059  
**Layer 0c check in tick():**
- Before firing, check `evictionBreaker.isTripped(now)`
- If true: disarm (drop snapshot, stop timer)
- On next real request, engine re-arms with fresh snapshot

---

## 7. KEY DECISION POINTS FOR ARCHITECTURE

### Decision 1: KA Token Freshness
**What:** Every KA fire calls `getToken()` EXCEPT when `orgSwitchPending`.  
**Why:** Allows credential rotation without session disarm. Proxy's credential provider handles refresh.  
**Implication:** Snapshots capture the Authorization for audit, but it's not the live token that fires use (unless org-switch-pending).

### Decision 2: Lineage-Keyed Registry
**What:** Registry keyed by lineageKey (hash of system ⊕ tool-names), not by model or org or request hash.  
**Why:** Anthropic's cache identity is the prefix (system+tools), not the request body or model.  
**Implication:** Same main agent + sub-agent on same model but different tool sets = separate KA slots (no clobbering).

### Decision 3: Per-Lineage Idle Clock
**What:** `lastWarmedAt` per lineage, used for fire threshold (not global `lastActivityAt`).  
**Why:** Global clock reset by every real request (any lineage) masks main agent's idle when sub-agents are active.  
**Implication:** Main agent's KA keeps firing on cadence even while sub-agents generate noisy global activity.

### Decision 4: Wire-Autoscan Downlock
**What:** `notifyRealRequestStart()` observes actual cache_control TTL markers; if shorter than `cacheTtlMs`, downcaps engine.  
**Why:** Catches proxy-forwarded native Claude Code traffic (5m ephemeral markers, not auto-upgraded) before it burns tokens firing into dead caches.  
**Implication:** Wire truth always overrides config; protects against 2026-05-17 incident (wire 5m, engine thought 1h → fires every 30m into caches dead for 25m).

### Decision 5: Reload vs Disarm
**What:** `reload()` drops snapshots but keeps timer; `disarm()` stops timer.  
**Why:** Org swap requires dropping stale snapshots but should NOT disable KA for the session.  
**Implication:** Single org-swap doesn't accidentally silence KA for rest of session.

### Decision 6: Eviction Breaker Disarms (Not Holds)
**What:** Breaker-tripped engine disarms immediately (drops snapshot, stops timer).  
**Why:** Cache already evicted server-side; holding/retrying would just pay another cold rewrite for an idle session.  
**Implication:** N-session eviction cascade becomes one rewrite + lazy re-warm on user return.

---

## 8. CRITICAL FILES & LINE RANGES

| **Component** | **File** | **Key Lines** |
|---|---|---|
| Session Lifecycle | proxy-ports.ts | 121-141 (Session interface), 144-176 (ISessionStore) |
| Session Reaper | proxy-client.ts | 424-450 |
| KA Engine Constructor | keepalive-engine.ts | 558-625 |
| notifyRealRequestStart | keepalive-engine.ts | 635-764 |
| notifyRealRequestComplete | keepalive-engine.ts | 777-840 |
| reload() | keepalive-engine.ts | 944-962 |
| tick() Full Loop | keepalive-engine.ts | 980-1344 |
| Snapshot Store Load/Save | ka-snapshot-store.ts | 107-150 |
| Snapshot Revival Logic | ka-snapshot-store.ts | 192-223 |
| lineageKey() | lineage.ts | 83-92 |
| classifyRole() | lineage.ts | 222-278 |
| classifyRewrite() | lineage.ts | 336-372 |
| Eviction Detection | eviction-breaker.ts | 49-74 |
| Org-Switch Pending | keepalive-engine.ts | 514-522, 845-847 |

---

## 9. EXECUTIVE SUMMARY FOR ARCHITECTURE DECISIONS

### **What token does a KA fire actually use?**
1. **Normal case:** Fresh token via `getToken()` callback (refresh-safe, follows credential rotation)
2. **Org-switch-pending case:** Old token from snapshot's Authorization header (keeps old org's cache warm)
3. **Snapshot capture:** Snapshot records the Authorization at registration time for audit/debugging, but it's not the live token unless org-switch-pending

### **Is there any per-session token or org pinning today?**
- **Token:** NO permanent pinning. Fresh token on every KA fire (except org-switch-pending). Snapshots capture token for audit only.
- **Org:** NO per-session org pinning at KA level. Org tracking is in prefix history (external to snapshots). Org-switch-pending flag provides temporary "old-org auth" window only.

### **Where would org/token pinning fit if needed?**
- **At Snapshot Registration:** Could extend `PersistedRegistryEntry` to add `orgId?: string` and `tokenSnapshot?: string` (for billing audit).
- **At Engine Revival:** Could pass `sessionOrgId` to engine constructor, enforce org matches on fire.
- **At Fire Time:** Could pin a specific token per session (not fresh-from-provider) if org-aware billing audit is required.

### **Current mitigations for org-billing hazards:**
1. **Rewrite Guard:** Detects org mismatch before request → blocks interactive clients
2. **Org-Switch Pending:** Temporary window keeps old-org's auth alive until user decides
3. **Per-Lineage Prefix History:** Tracks which org cached each prefix → feeds rewrite guard detection

---

**Document Status:** Complete structural map, all major code paths traced.
