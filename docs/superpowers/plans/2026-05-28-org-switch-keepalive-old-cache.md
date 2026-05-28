# Org-switch keepalive: warm OLD cache until per-session decision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the Anthropic org changes, each session's keepalive keeps warming the OLD org's cache with the OLD token until the user decides (send `[%cache-rewrite-ok%]` or start a new session), and a blocked request no longer disturbs keepalive.

**Architecture:** Two changes to the claude-max SDK (consumed by the claude-max-proxy daemon). (1) In `ProxyClient.handleRequest`, run the rewrite-guard decision BEFORE the keepalive-mutating `notifyRealRequestStart`, so a blocked org-switch request is a no-op for keepalive (no aborted warm, no advanced prefix history). (2) `KeepaliveEngine` gains a per-lineage "org-switch-pending" flag; while set, the KA fire replays the snapshot's OWN (old) `Authorization` header instead of overriding it with a fresh `getToken()`, warming the OLD org's cache until the old token expires (401 → existing auth-disarm) or the user proceeds.

**Tech Stack:** TypeScript, Bun (`bun test`, `tsc --noEmit`). Org detection (`FileOrgIdResolver` reading `~/.claude.json:oauthAccount.organizationUuid`) is already correct and reused unchanged.

**Spec:** `docs/superpowers/specs/2026-05-28-org-switch-keepalive-old-cache-design.md`

---

## File Structure

- **Modify** `src/keepalive-engine.ts`
  - Add `private orgSwitchPending = new Set<string>()` (keyed by engine-local `lineageKey`).
  - Add public `markOrgSwitchPending(lineageKey)`, `clearOrgSwitchPending(lineageKey)`, test-accessor `_orgSwitchPending`.
  - Clear the flag in `notifyRealRequestComplete` (a completed real request = user proceeded / re-registered under the new org) and in `clearRegistry`.
  - Both KA fire sites (`~:1195`, `~:1579`): when the lineage is org-switch-pending AND the snapshot carries an `Authorization` header, replay it as-is; otherwise keep current fresh-`getToken()` behavior.
- **Modify** `src/proxy-client.ts`
  - Import `lineageKey` from `./lineage.js` to compute the key without priming.
  - Split `predictCacheMiss` → `assessCacheMiss` (pure: read + classify + emit, NO history writes) + `commitPrefixHistory` (the two `.set` writes).
  - Reorder `handleRequest`: assess + guard FIRST; on block with `orgChanged`, call `session.engine.markOrgSwitchPending(reqLineageKey)`; only on the proceed path call `notifyRealRequestStart` + `commitPrefixHistory`.
- **Modify** `test/keepalive-engine.test.ts` (or new `test/ka-org-switch-token.test.ts`) — Change-2 unit tests.
- **Modify** `test/rewrite-guard.test.ts` — Change-1 / integration tests (existing harness with `mutableResolver`).

---

## Task 1: KeepaliveEngine — org-switch-pending state + lifecycle

**Files:**
- Modify: `src/keepalive-engine.ts` (add field near `private registry` ~`:493`; methods near `notifyRealRequestComplete` `:767`; clear in `clearRegistry`)
- Test: `test/ka-org-switch-token.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `test/ka-org-switch-token.test.ts`:

```typescript
import { describe, test, expect } from 'bun:test'
import { KeepaliveEngine } from '../src/keepalive-engine.js'
import type { RateLimitInfo, StreamEvent } from '../src/types.js'

const sys = (ttl = '1h') => ({
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl } }],
})

function mkEngine() {
  const captured: { headers: Record<string, string> }[] = []
  const e = new KeepaliveEngine({
    getToken: async () => 'NEW-token',
    doFetch: async function* (_body, headers): AsyncGenerator<StreamEvent> {
      captured.push({ headers })
      yield { type: 'message_stop', usage: { inputTokens: 100, outputTokens: 1, cacheReadInputTokens: 50_000 }, stopReason: 'end_turn' }
    },
    getRateLimitInfo: (): RateLimitInfo => ({ status: 'allowed', resetAt: null, claim: null, retryAfter: null, utilization5h: 0, utilization7d: 0 }),
  })
  return { e, captured }
}

function arm(e: KeepaliveEngine, auth: string): string {
  const key = e.notifyRealRequestStart('claude-opus-4-7', sys(), { Authorization: auth })
  e.notifyRealRequestComplete({ inputTokens: 50_000, outputTokens: 10, cacheReadInputTokens: 0 } as any, key)
  return key
}

describe('KeepaliveEngine — org-switch-pending lifecycle', () => {
  test('mark sets the flag; clear and complete remove it', () => {
    const { e } = mkEngine()
    const key = arm(e, 'Bearer OLD')
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(true)

    e.clearOrgSwitchPending(key)
    expect(e._orgSwitchPending.has(key)).toBe(false)

    e.markOrgSwitchPending(key)
    // a completed real request = user proceeded → flag cleared on re-registration
    e.notifyRealRequestComplete({ inputTokens: 60_000, outputTokens: 5, cacheReadInputTokens: 0 } as any, key)
    expect(e._orgSwitchPending.has(key)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ka-org-switch-token.test.ts -t "org-switch-pending lifecycle"`
Expected: FAIL — `e.markOrgSwitchPending is not a function` / `e._orgSwitchPending` undefined.

- [ ] **Step 3: Add the state + methods**

In `src/keepalive-engine.ts`, near the registry maps (`~:493-512`) add:

```typescript
  // Lineages whose cache was last written under a DIFFERENT org than the one
  // now billing real requests. While pending, KA replays the snapshot's OWN
  // (old) Authorization to keep the OLD org's cache warm — see fire sites.
  private orgSwitchPending = new Set<string>()
  /** Test accessor. */
  get _orgSwitchPending(): Set<string> { return this.orgSwitchPending }
```

Add public methods (place just after `notifyRealRequestComplete`, ~`:826`):

```typescript
  /** Flag a lineage as awaiting the user's org-switch decision. */
  markOrgSwitchPending(lineageKey: string): void { this.orgSwitchPending.add(lineageKey) }
  /** Clear the org-switch-pending flag for a lineage. */
  clearOrgSwitchPending(lineageKey: string): void { this.orgSwitchPending.delete(lineageKey) }
```

In `notifyRealRequestComplete`, immediately after the line that registers the entry (`this.registry.set(key, entry)` ~`:810`), add:

```typescript
      // A completed real request means the user proceeded (marker accepted or
      // same-org). The snapshot just re-registered under the current token, so
      // the org-switch window for this lineage is over.
      this.orgSwitchPending.delete(key)
```

In `clearRegistry` (the registry-clearing helper, ~`:930-940`), add alongside the registry clear:

```typescript
    this.orgSwitchPending.clear()
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/ka-org-switch-token.test.ts -t "org-switch-pending lifecycle"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keepalive-engine.ts test/ka-org-switch-token.test.ts
git commit -m "feat(keepalive): org-switch-pending per-lineage state + lifecycle"
```

---

## Task 2: KA fire replays the snapshot's old token while org-switch-pending

**Files:**
- Modify: `src/keepalive-engine.ts` — both fire sites (`~:1189-1195` heaviest-fire, `~:1575-1579` retry-fire)
- Test: `test/ka-org-switch-token.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/ka-org-switch-token.test.ts` (inside the `describe`):

```typescript
  test('pending lineage → KA fire replays the snapshot OLD token (not getToken)', async () => {
    const { e, captured } = mkEngine()
    const key = arm(e, 'Bearer OLD')
    e.markOrgSwitchPending(key)
    await e._tick()
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.at(-1)!.headers.Authorization).toBe('Bearer OLD')  // old token, NOT NEW-token
  })

  test('non-pending lineage → KA fire uses fresh getToken (current behavior)', async () => {
    const { e, captured } = mkEngine()
    arm(e, 'Bearer OLD')
    await e._tick()
    expect(captured.length).toBeGreaterThan(0)
    expect(captured.at(-1)!.headers.Authorization).toBe('Bearer NEW-token')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/ka-org-switch-token.test.ts -t "replays the snapshot OLD token"`
Expected: FAIL — `Authorization` is `Bearer NEW-token` (the fire currently always overrides with `getToken()`).

- [ ] **Step 3: Patch the heaviest-fire site (~:1189-1195)**

Replace:

```typescript
      const token = await this.getToken()

      const body = JSON.parse(JSON.stringify(best.body))
      const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
      body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1

      const headers = { ...best.headers, Authorization: `Bearer ${token}` }
```

with:

```typescript
      const body = JSON.parse(JSON.stringify(best.body))
      const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
      body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1

      // While this lineage is org-switch-pending, replay the snapshot's OWN
      // (old-org) Authorization so the OLD cache stays warm until the user
      // decides. Otherwise rebuild auth from a fresh getToken() (refresh-safe).
      const headers = this.orgSwitchPending.has(best.lineageKey) && best.headers.Authorization
        ? { ...best.headers }
        : { ...best.headers, Authorization: `Bearer ${await this.getToken()}` }
```

- [ ] **Step 4: Patch the retry-fire site (~:1575-1579)**

Replace:

```typescript
        const token = await this.getToken()
        const body = JSON.parse(JSON.stringify(entry.body))
        const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
        body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1
        const headers = { ...entry.headers, Authorization: `Bearer ${token}` }
```

with:

```typescript
        const body = JSON.parse(JSON.stringify(entry.body))
        const budgetTokens = (body.thinking as any)?.budget_tokens ?? 0
        body.max_tokens = budgetTokens > 0 ? budgetTokens + 1 : 1
        const headers = this.orgSwitchPending.has(entry.lineageKey) && entry.headers.Authorization
          ? { ...entry.headers }
          : { ...entry.headers, Authorization: `Bearer ${await this.getToken()}` }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/ka-org-switch-token.test.ts -v`
Expected: PASS (all in the file, both pending → `Bearer OLD` and non-pending → `Bearer NEW-token`).

- [ ] **Step 6: Commit**

```bash
git add src/keepalive-engine.ts test/ka-org-switch-token.test.ts
git commit -m "feat(keepalive): replay snapshot old token for org-switch-pending lineages"
```

---

## Task 3: Split predictCacheMiss → pure assess + explicit commit

**Files:**
- Modify: `src/proxy-client.ts` — `predictCacheMiss` (`~:1301-1395`)
- Test: `test/rewrite-guard.test.ts` (add a unit test using `(c as any)`)

- [ ] **Step 1: Write the failing test**

Add to `test/rewrite-guard.test.ts` (new `describe` at end of file):

```typescript
describe('assessCacheMiss is pure (does not advance prefix history)', () => {
  test('two assess calls in a row see identical prev state', () => {
    const c = mkClient({ orgIdResolver: { current: () => 'org-A' } })
    const body = JSON.parse(reqBody())
    // First assess must NOT persist anything → second assess still sees no prev.
    const a1 = (c as any).assessCacheMiss('rg-pure-1', 'lin', body, 6000)
    const a2 = (c as any).assessCacheMiss('rg-pure-1', 'lin', body, 6000)
    // isFirstRequest is encoded via expected cold-start on BOTH when no commit happened
    expect(a1.rewriteClass).toBe(a2.rewriteClass)
    expect((c as any).prefixHistory.get('rg-pure-1:lin')).toBeUndefined()
    c.stop()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rewrite-guard.test.ts -t "does not advance prefix history"`
Expected: FAIL — `assessCacheMiss is not a function` (still named `predictCacheMiss`, and it writes history).

- [ ] **Step 3: Refactor predictCacheMiss into assess + commit**

In `src/proxy-client.ts`, rename `predictCacheMiss` to `assessCacheMiss` and REMOVE the two history writes from it. Specifically delete these two lines (`~:1322-1326`):

```typescript
      this.lineagePrefix.set(key, { system: body.system, tools: body.tools })
      ...
      this.prefixHistory.set(key, { hashes: ph, lastReqAt: now, orgId, lastKaAt: prev?.lastKaAt })
```

Have `assessCacheMiss` additionally return the data needed to commit (extend its return object):

```typescript
    // ...existing return fields...
      prevPrefix,
      // commit payload — caller persists ONLY when the request proceeds
      _commit: { key, ph, now, orgId, prevLastKaAt: prev?.lastKaAt },
```

Extend the `_commit` payload to also carry the prefix body parts (`lineagePrefix` stores a `CachePrefix = { system, tools }`):

```typescript
      _commit: { key, ph, now, orgId, prevLastKaAt: prev?.lastKaAt, system: body.system, tools: body.tools },
```

Add a new private method right after `assessCacheMiss`:

```typescript
  /** Persist this lineage's new prefix fingerprint. Call ONLY when the request
   *  proceeds (NOT when the rewrite guard blocks it — a blocked, unconsented
   *  request must not advance history or it poisons the retry's classification). */
  private commitPrefixHistory(c: {
    key: string; ph: ReturnType<typeof prefixHashes>; now: number;
    orgId: string | null; prevLastKaAt: number | undefined; system: unknown; tools: unknown
  }): void {
    this.lineagePrefix.set(c.key, { system: c.system, tools: c.tools })
    this.prefixHistory.set(c.key, { hashes: c.ph, lastReqAt: c.now, orgId: c.orgId, lastKaAt: c.prevLastKaAt })
  }
```

- [ ] **Step 4: Update existing call site (proceed path only)**

In `handleRequest`, the current single call `this.predictCacheMiss(...)` (`~:706`) is reworked in Task 4. For THIS task, keep behavior identical on the proceed path by calling assess then commit together where the old call was, so the full suite stays green until Task 4 reorders it:

```typescript
    const rewriteAssessment = this.assessCacheMiss(sessionId, reqLineageKey, parsedBody, bodyBytes)
    if (rewriteAssessment?._commit) this.commitPrefixHistory(rewriteAssessment._commit)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test test/rewrite-guard.test.ts -v`
Expected: PASS (new purity test + all existing guard tests unchanged — commit still happens at the same point for now).

- [ ] **Step 6: Commit**

```bash
git add src/proxy-client.ts test/rewrite-guard.test.ts
git commit -m "refactor(proxy): split predictCacheMiss into pure assess + explicit commit"
```

---

## Task 4: Reorder handleRequest — guard before KA prime; mark org-switch-pending on block

**Files:**
- Modify: `src/proxy-client.ts` — `handleRequest` (`~:699-779`), add `import { lineageKey } from './lineage.js'` (top, near `~:58`)
- Test: `test/rewrite-guard.test.ts` (add)

- [ ] **Step 1: Write the failing test**

Add to `test/rewrite-guard.test.ts` (extend the org-switch describe at `~:137`):

```typescript
  test('org-switch block marks the session engine org-switch-pending', async () => {
    const c = mkClient({ orgIdResolver: mutableResolver('org-A') as any })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-pending' })   // cache under org-A
    ;((c as any).orgIdResolver as any).org = 'org-B'                         // claude login → org-B
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-pending' })
    expect(r.status).toBe(400)                                              // blocked, awaiting decision
    const eng = c.listSessions().find(s => s.sessionId === 'rg-org-pending')!.engine
    const key = lineageKeyOf(reqBody())                                     // helper below
    expect(eng._orgSwitchPending.has(key)).toBe(true)
    c.stop()
  })
```

Add at the top of `test/rewrite-guard.test.ts` imports:

```typescript
import { lineageKey as lineageKeyOf_ } from '../src/lineage.js'
const lineageKeyOf = (bodyStr: string) => lineageKeyOf_(JSON.parse(bodyStr))
```

(Sessions are reached via the public `c.listSessions()` → `Session<KeepaliveEngine>[]` with `.sessionId` and `.engine`; no private access needed.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rewrite-guard.test.ts -t "marks the session engine org-switch-pending"`
Expected: FAIL — `_orgSwitchPending.has(key)` is false (nothing marks it yet; also prime still runs before guard).

- [ ] **Step 3: Reorder handleRequest**

In `src/proxy-client.ts`, add the import near `~:58`:

```typescript
import { lineageKey } from './lineage.js'
```

Replace the block `~:699-779` (currently: `notifyRealRequestStart` → `predictCacheMiss`/assess+commit → guard) with this order — compute key, assess (pure), guard (mark-pending + return 400 on block), then prime + commit only on proceed:

```typescript
    // Compute the lineage key WITHOUT priming — lineageKey(body) is pure.
    const reqLineageKey = lineageKey(parsedBody)

    // Assess (pure — no history writes) so a blocked request never advances state.
    const rewriteAssessment = this.assessCacheMiss(sessionId, reqLineageKey, parsedBody, bodyBytes)

    // Rewrite guard — block BEFORE any keepalive mutation.
    {
      const guard = loadKeepaliveConfig().rewriteGuard
      const lastMsg = inspectLastUserMessage(parsedBody, guard.overrideMarker)
      if (guard.enabled && rewriteAssessment && !rewriteAssessment.expected
          && rewriteAssessment.predictedTokens >= guard.minRewriteTokens
          && !lastMsg.isContinuation
          && !lastMsg.hasMarker) {
        let dumpPath: string | null = null
        if (guard.dumpBlocked) {
          dumpPath = writeRewriteBlockDump(this.rewriteBlockDumpDir, {
            sessionId, lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass,
            predictedTokens: rewriteAssessment.predictedTokens,
            signals: rewriteAssessment.signals,
            blockedRequest: parsedBody,
            previousPrefix: rewriteAssessment.prevPrefix,
          })
        }
        if (isAutomatedAgent(parsedBody, headers)) {
          this.events.emit({ level: 'info', kind: 'CACHE_REWRITE_UNGUARDED', sessionId, lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass, predictedTokens: rewriteAssessment.predictedTokens, dumpPath,
            msg: `rewrite guard would block ${rewriteAssessment.rewriteClass} (~${rewriteAssessment.predictedTokens} tok) — automated agent (cannot consent); passed through` + (dumpPath ? ` — dump: ${dumpPath}` : '') })
          // fall through to the proceed path below
        } else {
          // org-switch block: keep warming the OLD cache for this lineage until
          // the user proceeds. Other block classes do not warm-old (no org change).
          if (rewriteAssessment.signals.orgChanged) session.engine.markOrgSwitchPending(reqLineageKey)
          this.events.emit({ level: 'error', kind: 'CACHE_REWRITE_BLOCKED', sessionId, lineageKey: reqLineageKey,
            rewriteClass: rewriteAssessment.rewriteClass, predictedTokens: rewriteAssessment.predictedTokens, dumpPath,
            msg: `rewrite guard blocked ${rewriteAssessment.rewriteClass} (~${rewriteAssessment.predictedTokens} tok) — awaiting user override marker` + (dumpPath ? ` — dump: ${dumpPath}` : '') })
          return jsonResponse(400, { error: { type: 'cache_rewrite_guard',
            message: `Cache-rewrite guard: this turn would re-cache ~${rewriteAssessment.predictedTokens} tokens (${rewriteAssessment.rewriteClass}) — an unconfirmed quota spend. To proceed, re-send your message with ${guard.overrideMarker} in it. (Disable: keepalive.json → rewriteGuard.enabled=false.)` } })
        }
      }
    }

    // PROCEED path — request will be forwarded. Now (and only now) mutate KA.
    const primedLineageKey = session.engine.notifyRealRequestStart(model, parsedBody, upstreamHeaders)
    if (rewriteAssessment?._commit) this.commitPrefixHistory(rewriteAssessment._commit)
```

Then ensure the rest of `handleRequest` uses `primedLineageKey` where it previously used `reqLineageKey` from the old `notifyRealRequestStart` return (the completion-matching at `~:906`, `~:1243`, `~:1270`). They are the same value (`lineageKey(body)`), but use `primedLineageKey` on the proceed path for clarity. Remove the now-duplicated old `REAL_REQUEST_START` emit only if it moved; keep a single `REAL_REQUEST_START` emit on the proceed path.

NOTE: keep the existing `checkRewriteGuard(model)` burst-guard call (`~:782-791`) exactly where it is on the proceed path (after prime).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/rewrite-guard.test.ts -v`
Expected: PASS — including the new mark-pending test and all existing org-switch / guard tests.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/rewrite-guard.test.ts
git commit -m "fix(proxy): rewrite guard runs before KA prime; mark org-switch-pending on block"
```

---

## Task 5: Regression pins + full suite + typecheck

**Files:**
- Test: `test/rewrite-guard.test.ts` (add), `test/ka-org-switch-token.test.ts` (add)

- [ ] **Step 1: Write the regression tests**

Add to `test/rewrite-guard.test.ts` (org-switch describe):

```typescript
  test('same-org token rotation does NOT mark org-switch-pending', async () => {
    // org UUID unchanged across requests → no window, even though the token rotated.
    const c = mkClient({ orgIdResolver: { current: () => 'org-stable' } })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-rot' })
    const r = await c.handleRequest(reqBody(), {}, { sessionId: 'rg-rot' })  // rapid, same org
    expect(r.status).not.toBe(400)
    const eng = c.listSessions().find(s => s.sessionId === 'rg-rot')!.engine
    expect(eng._orgSwitchPending.size).toBe(0)
    c.stop()
  })

  test('marker after org-switch clears the pending flag (window ends)', async () => {
    const c = mkClient({ orgIdResolver: mutableResolver('org-A') as any })
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-end' })
    ;((c as any).orgIdResolver as any).org = 'org-B'
    await c.handleRequest(reqBody(), {}, { sessionId: 'rg-org-end' })                 // blocked → pending
    const r = await c.handleRequest(reqBody('[cache-rewrite-ok]'), {}, { sessionId: 'rg-org-end' })  // marker → proceeds + completes
    expect(r.status).not.toBe(400)
    const eng = c.listSessions().find(s => s.sessionId === 'rg-org-end')!.engine
    expect(eng._orgSwitchPending.size).toBe(0)   // cleared on completion
    c.stop()
  })
```

- [ ] **Step 2: Run the regression tests**

Run: `bun test test/rewrite-guard.test.ts -t "org-switch"` and `bun test test/ka-org-switch-token.test.ts -v`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck**

Run: `bun test`
Expected: all green (≥ 602 + the new tests), 0 fail.

Run: `bun run typecheck`
Expected: clean (no output / exit 0).

- [ ] **Step 4: Commit**

```bash
git add test/
git commit -m "test(proxy,keepalive): regression pins for org-switch window (token≠org, marker clears)"
```

---

## Task 6: Build + deploy + live smoke

**Files:** none (uses `packages/claude-max-proxy/scripts/deploy-from-source.sh`)

- [ ] **Step 1: Deploy from source (rebuilds SDK bundle, restarts daemon, runs existing smoke gate)**

Run: `bash packages/claude-max-proxy/scripts/deploy-from-source.sh`
Expected: `building SDK` → `health: {"ok":true...}` → `smoke ... PASS` → `deploy OK`.

- [ ] **Step 2: Verify deployed bundle carries the new behavior**

Run: `grep -c "orgSwitchPending" /home/relishev/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/index.js`
Expected: ≥ 1.

- [ ] **Step 3: Commit any manifest/version changes if produced** (only if `git status` shows tracked changes).

---

## Self-Review

**Spec coverage:**
- Change 1 (guard before prime, blocked = no-op) → Tasks 3 + 4. ✓
- Change 2 (warm old cache with snapshot token in window) → Tasks 1 + 2. ✓
- Window end: marker → Task 5; token expiry (401 → existing auth-disarm) → no code needed, covered by existing classification + `clearRegistry` clearing the set (Task 1). ✓
- token≠org (same-org rotation opens no window) → Task 5 regression. ✓
- Detection reused unchanged → no task touches `org-identity.ts`. ✓
- Deploy-and-verify-live → Task 6. ✓

**Placeholder scan:** resolved against the live source — sessions are reached via the public `c.listSessions()` (sessions live in `this.store`, accessed as in `proxy-client.ts:509`), and `commitPrefixHistory` carries `system`/`tools` through the `_commit` payload (matching `CachePrefix`). The only remaining `NOTE` is in Task 4: on the proceed path use `primedLineageKey` for completion-matching and keep a single `REAL_REQUEST_START` emit — straightforward implementer guidance, no unfilled work.

**Type consistency:** `markOrgSwitchPending`/`clearOrgSwitchPending`/`_orgSwitchPending` consistent across Tasks 1, 2, 4, 5. `assessCacheMiss` + `commitPrefixHistory` + `_commit` payload consistent across Tasks 3 and 4. Fire-site guard uses `best.lineageKey`/`entry.lineageKey` matching `RegistryEntry.lineageKey`. ✓
