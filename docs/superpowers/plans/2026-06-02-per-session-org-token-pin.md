# Per-session org/token pinning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make org/token a per-session property in claude-max-proxy: a cross-org `claude login` no longer blocks or silently migrates live sessions — each session HOLDS its old org+token and keeps serving, until an explicit switch (`[%reload-ok%]` marker, or cli `reload` global/per-session) or a force condition (old token truly expired, or non-org expensive rewrite).

**Architecture:** Two layers. **L1 — atomic account snapshot:** add `OrgIdResolver.invalidate()` + `ProxyClient.notifyCredentialsChanged()` and call it from the daemon's credentials `fs.watch`, so token and org-id invalidate in lock-step (kills the 5-min stale-org window). **L2 — per-session pin:** `sessionPins: Map<sessionId,{orgId,token,expiresAt}>` in ProxyClient drives forward token selection (adopt-same-org / hold-cross-org / 401-on-expired) and rebinds on `[%reload-ok%]` / `reloadSessions`. The `anomalous:org-switch` 400 path is removed for real traffic.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun test runner, build via `bun run scripts/build-sdk.ts`. Spec: `docs/superpowers/specs/2026-06-02-per-session-org-token-pin-design.md`.

**Run tests:** `bun test` (all) · `bun test test/<file>` (one) · typecheck `bunx tsc --noEmit`.

---

### Task 1: `OrgIdResolver.invalidate()` (L1 foundation)

**Files:**
- Modify: `src/org-identity.ts` (interface ~77-80, class ~91-117)
- Test: `test/org-identity.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { FileOrgIdResolver } from '../src/org-identity.js'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

test('invalidate() forces a re-read before TTL expiry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orgid-'))
  const cfg = join(dir, 'claude.json')
  writeFileSync(cfg, JSON.stringify({ oauthAccount: { organizationUuid: 'org-A' } }))
  const r = new FileOrgIdResolver(cfg, 300_000) // 5-min TTL
  expect(r.current()).toBe('org-A')
  writeFileSync(cfg, JSON.stringify({ oauthAccount: { organizationUuid: 'org-B' } }))
  expect(r.current()).toBe('org-A')   // still cached (TTL not elapsed)
  r.invalidate()
  expect(r.current()).toBe('org-B')   // re-read after invalidate
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/org-identity.test.ts`
Expected: FAIL — `r.invalidate is not a function`.

- [ ] **Step 3: Implement**

In `src/org-identity.ts`, add to the `OrgIdResolver` interface:
```ts
  /** Drop any cached org-id so the next current() re-reads from disk. */
  invalidate(): void
```
In `FileOrgIdResolver`, add the method:
```ts
  invalidate(): void {
    this.cache = null
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/org-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/org-identity.ts test/org-identity.test.ts
git commit -m "feat(org-identity): add OrgIdResolver.invalidate() for lock-step cache drop"
```

---

### Task 2: `ProxyClient.notifyCredentialsChanged()` (L1 atomic invalidate)

**Files:**
- Modify: `src/proxy-client.ts` (near `disarmSessions`/`reloadSessions`, ~505-580)
- Test: `test/proxy-client-org-pin.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Use injectable adapters. A fake credentials provider + a controllable org resolver:
```ts
import { test, expect } from 'bun:test'
import { ProxyClient } from '../src/proxy-client.js'

function makeClient() {
  let orgId = 'org-A'; let invalidatedCreds = 0; let invalidatedOrg = 0
  const orgIdResolver = { current: () => orgId, invalidate: () => { invalidatedOrg++ } }
  const credentialsProvider = {
    getAccessToken: async () => 'tok-A',
    invalidate: () => { invalidatedCreds++ },
  }
  const client = new ProxyClient({ config: { kaIntervalSec: 0 }, credentialsProvider, orgIdResolver } as any)
  return { client, get: () => ({ invalidatedCreds, invalidatedOrg }) }
}

test('notifyCredentialsChanged invalidates BOTH credentials and org-id', () => {
  const { client, get } = makeClient()
  client.notifyCredentialsChanged('test')
  expect(get().invalidatedCreds).toBe(1)
  expect(get().invalidatedOrg).toBe(1)
  client.stop()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/proxy-client-org-pin.test.ts`
Expected: FAIL — `client.notifyCredentialsChanged is not a function`.

- [ ] **Step 3: Implement**

In `src/proxy-client.ts`, add a public method (mirror `reloadSessions` style):
```ts
  /**
   * Credentials file changed on disk (daemon fs.watch). Invalidate the token
   * cache AND the org-id cache in lock-step so the rewrite/pin logic never sees
   * a fresh token paired with a stale org-id (the 2026-06-02 5-min window).
   * Does NOT touch session pins — a same-org refresh must stay seamless and a
   * cross-org switch must HOLD until an explicit reload.
   */
  notifyCredentialsChanged(reason: string): void {
    this.credentials.invalidate()
    this.orgIdResolver.invalidate()
    this.events.emit({ level: 'info', kind: 'CREDENTIALS_CHANGED', reason })
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/proxy-client-org-pin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/proxy-client-org-pin.test.ts
git commit -m "feat(proxy): notifyCredentialsChanged() invalidates token+org-id atomically (L1)"
```

---

### Task 3: `reloadMarker` config (L2 marker SSOT)

**Files:**
- Modify: `src/keepalive-config.ts` (RewriteGuardConfig ~196-224, loader ~458-465)
- Test: `test/keepalive-config.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { loadKeepaliveConfig } from '../src/keepalive-config.js'

test('reloadMarker defaults to [%reload-ok%]', () => {
  const cfg = loadKeepaliveConfig()
  expect(cfg.rewriteGuard.reloadMarker).toBe('[%reload-ok%]')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/keepalive-config.test.ts -t reloadMarker`
Expected: FAIL — `reloadMarker` undefined.

- [ ] **Step 3: Implement**

In `RewriteGuardConfig` interface add (after `overrideMarker`):
```ts
  /** Marker that switches THIS session to the current org+token (rebind).
   *  Distinct from overrideMarker (which only consents to a non-org rewrite). */
  readonly reloadMarker: string
```
In `DEFAULT_REWRITE_GUARD` add:
```ts
  reloadMarker: '[%reload-ok%]',
```
In the loader (next to overrideMarker, ~462):
```ts
    reloadMarker: (typeof rg.reloadMarker === 'string' && rg.reloadMarker.length > 0)
      ? rg.reloadMarker
      : DEFAULT_REWRITE_GUARD.reloadMarker,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/keepalive-config.test.ts -t reloadMarker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/keepalive-config.ts test/keepalive-config.test.ts
git commit -m "feat(config): add reloadMarker ([%reload-ok%]) SSOT for org rebind"
```

---

### Task 4: Credentials expiry access (L2 pin needs expiresAt)

**Files:**
- Modify: `src/proxy-ports.ts` (ICredentialsProvider ~67-73)
- Modify: `src/proxy-adapters.ts` (FileCredentialsProvider ~51-107)
- Test: `test/proxy-adapters.test.ts` (add a case; create if absent)

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from 'bun:test'
import { FileCredentialsProvider } from '../src/proxy-adapters.js'
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'; import { tmpdir } from 'os'

test('currentExpiresAt returns the stored expiry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'creds-'))
  const p = join(dir, '.credentials.json')
  const exp = Date.now() + 3_600_000
  writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 'tok', expiresAt: exp, refreshToken: 'r', scopes: [] } }))
  const cp = new FileCredentialsProvider({ path: p })
  await cp.getAccessToken()
  expect(cp.currentExpiresAt()).toBe(exp)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/proxy-adapters.test.ts -t currentExpiresAt`
Expected: FAIL — not a function.

- [ ] **Step 3: Implement**

In `ICredentialsProvider` add an OPTIONAL method (additive — keeps port stable):
```ts
  /** Expiry (ms epoch) of the currently-cached token, or null if unknown.
   *  Optional: providers that cannot report expiry omit it (pin treats null as
   *  "alive" and relies on the upstream-401 stop path). */
  currentExpiresAt?(): number | null
```
In `FileCredentialsProvider`, expose the cached value:
```ts
  currentExpiresAt(): number | null {
    return this.cached?.expiresAt ?? null
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/proxy-adapters.test.ts -t currentExpiresAt`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-ports.ts src/proxy-adapters.ts test/proxy-adapters.test.ts
git commit -m "feat(proxy): optional ICredentialsProvider.currentExpiresAt() for pin expiry"
```

---

### Task 5: `sessionPins` map + Pin type + reap (L2 state)

**Files:**
- Modify: `src/proxy-client.ts` (field near `lineagePrefix` ~371; reaper loop ~430-439)
- Test: `test/proxy-client-org-pin.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

```ts
test('a reaped session drops its pin', async () => {
  // build a client whose store reports the session dead, then trigger reapDead
  // (use the same fake-adapter harness as Task 2; expose sessionPins via a test getter)
  // Assert: after reap, the pin for that sessionId is gone.
})
```
(Concrete harness: extend `makeClient()` with an injectable `sessionStore` whose
`reapDead()` returns `['s1']`; add a private-but-test-visible accessor
`__pinCount()` returning `this.sessionPins.size`.)

- [ ] **Step 2: Run test to verify it fails** — `bun test ... -t "drops its pin"` → FAIL.

- [ ] **Step 3: Implement**

Add the type + field:
```ts
/** Per-session pinned account: org+token captured at bind time. In-memory only
 *  (restart ⇒ rebind current). Reaped with the session. */
interface SessionPin { orgId: string | null; token: string; expiresAt: number | null }
```
```ts
  private readonly sessionPins: Map<string, SessionPin> = new Map()
```
In the reaper loop (where prefixHistory/lineagePrefix are pruned per `sid`):
```ts
        this.sessionPins.delete(sid)
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/proxy-client-org-pin.test.ts
git commit -m "feat(proxy): per-session pin map + reap (L2 state)"
```

---

### Task 6: Forward token selection — hold/adopt/rebind/401 (L2 core)

**Files:**
- Modify: `src/proxy-client.ts` (inject path ~660-674; add a pure helper `selectSessionToken`)
- Test: `test/proxy-client-org-pin.test.ts` (add cases 6a-6d)

- [ ] **Step 1: Write the failing tests** (one per branch)

```ts
// 6a same-org refresh → fresh token, pin stays same org
// 6b cross-org, old token alive → pin.token (HOLD), HTTP 200, no 400
// 6c cross-org, old token expired → 401-stop with reload instructions
// 6d new session → auto-pins current, uses current token
```
Drive these through `handleRequest` with the fake upstream capturing the
outgoing `Authorization` header; flip `orgId` between calls; set `expiresAt`
in the fake credentials. Assert the captured Bearer + status.

- [ ] **Step 2: Run → FAIL** (current code always uses fresh token; 6b/6c fail).

- [ ] **Step 3: Implement**

Extract a pure selector (testable in isolation):
```ts
  /** Decide which token a session's request uses, given the live account and the
   *  session's existing pin. Returns the token to send, a possibly-updated pin,
   *  and whether to 401-stop (cross-org pin expired). */
  private selectSessionToken(
    sessionId: string,
    account: { orgId: string | null; token: string; expiresAt: number | null },
    reloadAsked: boolean,
    now: number,
  ): { token: string; stop: boolean } {
    const pin = this.sessionPins.get(sessionId)
    if (!pin || reloadAsked) {                                   // new session OR explicit switch
      this.sessionPins.set(sessionId, { ...account })
      return { token: account.token, stop: false }
    }
    if (pin.orgId === null || account.orgId === null || pin.orgId === account.orgId) {
      pin.token = account.token; pin.expiresAt = account.expiresAt   // same org → adopt fresh
      return { token: account.token, stop: false }
    }
    if (pin.expiresAt === null || now < pin.expiresAt) {         // cross-org, old token alive → HOLD
      return { token: pin.token, stop: false }
    }
    return { token: pin.token, stop: true }                      // cross-org, expired → force
  }
```
At the inject path (replace `const token = await this.credentials.getAccessToken()`):
```ts
    let token: string
    try {
      const acctToken = await this.credentials.getAccessToken()
      const account = {
        orgId: this.orgIdResolver.current(),
        token: acctToken,
        expiresAt: this.credentials.currentExpiresAt?.() ?? null,
      }
      const reloadAsked = inspectLastUserMessage(parsedBody, loadKeepaliveConfig().rewriteGuard.reloadMarker).hasMarker
      const sel = this.selectSessionToken(sessionId, account, reloadAsked, Date.now())
      if (sel.stop) {
        this.events.emit({ level: 'error', kind: 'ORG_PIN_EXPIRED', sessionId,
          msg: 'pinned org token expired — reload required' })
        return jsonResponse(401, { error: { type: 'authentication_error',
          message: 'Your session was pinned to a previous org whose token has expired. '
            + 'Re-send with [%reload-ok%] (or run reload) to continue on the current org '
            + '(expect a ~150k cache rewrite).' } })
      }
      token = sel.token
    } catch (credErr: any) { /* existing 401 TOKEN_NEEDS_RELOGIN block unchanged */ }
    upstreamHeaders[HEADER_AUTHORIZATION] = `Bearer ${token}`
```

- [ ] **Step 4: Run → PASS** all of 6a-6d.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/proxy-client-org-pin.test.ts
git commit -m "feat(proxy): per-session token selection — hold cross-org, adopt same-org, 401 on expiry (L2)"
```

---

### Task 7: Remove the `anomalous:org-switch` BLOCK for real traffic; derive KA hold from pin

**Files:**
- Modify: `src/proxy-client.ts` (guard block ~768-795; `markOrgSwitchPending` call ~773)
- Test: `test/rewrite-guard.test.ts` (adjust the org-switch case)

- [ ] **Step 1: Update the test to the new contract**

Change the existing "org-switch → 400" expectation to: an org-changed request from
a session with a live pin → **200**, outgoing Bearer == old pin token, and the KA
lineage is marked org-switch-pending (old-cache warming preserved).

- [ ] **Step 2: Run → FAIL** (current code returns 400 for orgChanged).

- [ ] **Step 3: Implement**

In the rewrite-guard block, stop treating `orgChanged` as a blockable class for
real traffic: gate the 400 on `!rewriteAssessment.signals.orgChanged` (org holds
are handled by Task 6's selector, not by a block). Keep the org-switch-pending
mark so KA keeps warming the old cache:
```ts
      if (guard.enabled && rewriteAssessment && !rewriteAssessment.expected
          && !rewriteAssessment.signals.orgChanged       // org no longer blocks — it HOLDS (Task 6)
          && rewriteAssessment.predictedTokens >= guard.minRewriteTokens
          && !lastMsg.isContinuation && !lastMsg.hasMarker) {
        /* existing non-org block path unchanged */
      }
      // Independently: when org changed and the session is holding, keep the old
      // cache warm (KA replays the pin token).
      if (rewriteAssessment?.signals.orgChanged) session.engine.markOrgSwitchPending(reqLineageKey)
```

- [ ] **Step 4: Run → PASS** (org-switch real traffic is 200; non-org rewrite still 400).

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/rewrite-guard.test.ts
git commit -m "refactor(proxy): cross-org no longer blocks real traffic — holds old org; KA still warms old cache"
```

---

### Task 8: Rebind on cli reload (`reloadSessions` clears/rebinds pin)

**Files:**
- Modify: `src/proxy-client.ts` (`reloadSessions` ~560-580)
- Test: `test/proxy-client-org-pin.test.ts` (add cases 8a global, 8b per-session)

- [ ] **Step 1: Write the failing tests**

```ts
// 8a: pin session to org-A; switch file to org-B; reloadSessions('cli') → pin dropped;
//     next request auto-pins org-B and uses tok-B.
// 8b: same but reloadSessions('cli', sid) drops ONLY that session's pin.
```

- [ ] **Step 2: Run → FAIL** (reloadSessions does not touch pins yet).

- [ ] **Step 3: Implement**

In `reloadSessions`, after the engine reload loop, drop the matching pin(s) so the
next request rebinds to the current account:
```ts
    if (sessionId) this.sessionPins.delete(sessionId)
    else this.sessionPins.clear()
```
(Dropping the pin = "rebind on next request" — simpler and equivalent to writing
the current account now, and it naturally picks up whatever is current at request
time.)

- [ ] **Step 4: Run → PASS** 8a + 8b.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-client.ts test/proxy-client-org-pin.test.ts
git commit -m "feat(proxy): cli reload rebinds session pin(s) to current org (global + per-session)"
```

---

### Task 9: Daemon wiring — call `notifyCredentialsChanged` from the credentials fs.watch

**Files:**
- Modify: `packages/claude-max-proxy/src/server.ts` (~257-276)
- Modify: `packages/claude-max-proxy/src/quota-watcher.ts` (~296-349, the creds watcher)
- Test: `packages/claude-max-proxy/test/*` (add a wiring test if the harness allows; else cover via manual live-probe in Task 10)

- [ ] **Step 1: Write/adjust the test** (if a server harness exists) asserting that a
  simulated credentials-file change calls `proxyClient.notifyCredentialsChanged`.
  If no harness, mark this task verified-by-live-probe (Task 10) and note it.

- [ ] **Step 2: Run → FAIL / N/A.**

- [ ] **Step 3: Implement**

In the credentials `fs.watch` handler that currently emits `TOKEN_FILE_CHANGED`,
add (right after the emit) a call into the SDK client:
```ts
  proxyClient.notifyCredentialsChanged('fs.watch')
```
Do it in BOTH watchers (server.ts and quota-watcher.ts) IF both are active; if
quota-watcher is the canonical one, wire it there and leave server.ts emitting
only. Verify which is live before editing (grep the daemon boot path).

- [ ] **Step 4: Run → PASS / deferred to live-probe.**

- [ ] **Step 5: Commit**

```bash
git add packages/claude-max-proxy/src/server.ts packages/claude-max-proxy/src/quota-watcher.ts
git commit -m "feat(proxy-daemon): invalidate org-id in lock-step with token on credentials fs.watch"
```

---

### Task 10: Full suite + build + deploy + live-probe (Rule #15)

- [ ] **Step 1:** `bun test` — all green; `bunx tsc --noEmit` — clean.
- [ ] **Step 2:** Build SDK: `bun run scripts/build-sdk.ts`.
- [ ] **Step 3:** Deploy: copy `dist/` → `~/.local/share/claude-max-proxy/node_modules/@life-ai-tools/claude-code-sdk/dist/`; rebuild/redeploy the proxy package; `systemctl --user restart claude-max-proxy.service`.
- [ ] **Step 4: Live-probe (verify the running instance serves new code):**
  - Same-org refresh: a normal request → 200, no `CREDENTIALS_CHANGED` storm.
  - Cross-org: with an active session, `claude login` to another org → the session's next request returns **200 on the OLD org** (check `claude-max-proxy.jsonl`: NO `CACHE_REWRITE_BLOCKED anomalous:org-switch` for that session); a NEW session runs on the new org.
  - `[%reload-ok%]`: re-send → session rebinds, one expected cold rewrite on the new org.
  - cli `reload` (global + per-session): pin(s) drop, next request on the new org.
- [ ] **Step 5: Commit** any deploy-script / config deltas. Reconcile live↔source if drift found (Rule #15).

---

## Self-Review

- **Spec coverage:** L1 (Tasks 1-2, 9), reloadMarker (3), expiry access (4), pin state (5), hold/adopt/rebind/401 selector (6), org-block removal + KA hold (7), cli reload rebind (8), deploy+probe (10). Same-org adopt, cross-org hold, cross-org expiry, both rebind paths, non-org guard intact — all have tests.
- **Type consistency:** `SessionPin {orgId, token, expiresAt}`; `selectSessionToken(...) → {token, stop}`; `currentExpiresAt(): number|null`; marker via `inspectLastUserMessage(body, reloadMarker).hasMarker`. Consistent across tasks.
- **Open verification:** Task 9 — confirm whether server.ts or quota-watcher.ts is the live creds-watch on the deployed daemon before editing (grep boot path); covered by live-probe in Task 10.
