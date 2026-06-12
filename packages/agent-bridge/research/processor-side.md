# Signal-Wire: Event PROCESSOR / Context-Injector Side

Maps how a matched event is PROCESSED into outputs, and where those outputs
become context injection / block / exec / file-write / HTTP-push. Goal: feed an
architectural refactor that splits **event emitter** from **event processor
(context-injector / file-writer / socket-pusher)**.

Two packages:
- **Engine (core)**: `/home/relishev/packages/signal-wire-core/src/` — the rules
  engine, pipeline, emitters, `EmitResult`.
- **Adapter**: `/home/relishev/projects/vibe/claude-code-sdk/packages/opencode-signal-wire/`
  — `signal-wire.ts` (façade) + `hook-listener.ts` (the **appliers** that turn
  `EmitResult[]` into actual opencode mutations) + `spawn-brief-applier.ts`.

---

## 1. Processing pipeline (stages)

```
SignalWireEvent
  │
  ▼  signal-wire.ts façade (per-call):
  ├─ rulesStore.maybeReload()                         signal-wire.ts:798/810/833
  ├─ attachRuntimeMeta(event)  (tokens/quota/model)   signal-wire.ts:792
  ├─ logInvoke(...)                                    signal-wire.ts:801/813/835
  └─ pipeline.process(event)  ───────────────┐        signal-wire.ts:802/814/836
                                             │
  ▼  engine/pipeline.ts  Pipeline.process()  │        pipeline.ts:435
  ├─ re-entrancy guard (_processing)                  pipeline.ts:436
  ├─ adversarial normalize (event fields)             pipeline.ts:438-473
  ├─ lifecycle side-effect: session.compacted →
  │    cooldowns.resetSession()                        pipeline.ts:501-504
  ├─ approval detect-and-grant (chat.message/user)    pipeline.ts:506-520
  ├─ matches = evaluate(event, rules)  (PURE matcher) pipeline.ts:523  (evaluator.ts)
  │
  └─ for each match:
      ├─ cooldown gate (rule/session scope)            pipeline.ts:531-538
      ├─ RULE_FIRED log + metrics                      pipeline.ts:540-558
      ├─ sort actions by ACTION_ORDER                  pipeline.ts:561-565
      └─ for each action (sorted):
          ├─ per-action cooldown gate                  pipeline.ts:571-578
          ├─ registry.get(action.type) → emitter       pipeline.ts:580
          ├─ pre-fetch approval (block only)           pipeline.ts:596-607
          ├─ build EmitterContext                      pipeline.ts:609-622
          ├─ result = emitter.execute(action, ctx) ◀── EMITTER runs (may I/O) pipeline.ts:626
          ├─ stamp render meta (priority/group/        pipeline.ts:642-644
          │    runtimeMeta) onto result
          └─ record per-action cooldown                pipeline.ts:655-657
      └─ record rule/session cooldown                  pipeline.ts:661-663
  ├─ trace.outcome = no_match|blocked|dispatched       pipeline.ts:668-674
  ├─ histogram + traceSink.emit(trace)                 pipeline.ts:676-677
  ├─ EVENT_COMPLETE log                                pipeline.ts:687-696
  ├─ stamp wrapperTemplate from ruleSetMeta            pipeline.ts:702-707
  └─ return EmitResult[]                               pipeline.ts:709
  │
  ▼  back in signal-wire.ts:
  ├─ evaluateHook()      → returns RAW EmitResult[]    signal-wire.ts:832-840  ◀ preferred
  ├─ evaluateAsync()/evaluate() → toLegacy(results)    signal-wire.ts:797-818
  └─ evaluateExternal()  → {matched, results}          signal-wire.ts:843-878
  │
  ▼  toLegacy(results): collapse hint/respond → single signal-wire.ts:882-892
       {ruleId, hint} (lossy: drops block/exec/compact, joins hintText)
  │
  ▼  APPLIERS (hook-listener.ts) — the actual injection/mutation:
       applyChatHintResults / applyBlockResults / applyCompactResults
```

Key separation already present: **`evaluateHook()` returns the raw
`EmitResult[]`** (the pure-ish result envelope); the **appliers in
`hook-listener.ts` are a SEPARATE layer** that mutate opencode's hook output.

---

## 2. Output KINDS a processed event can produce

`ActionType` (`domain/action.ts:9-18`) → `EmitResult` shape
(`domain/result.ts:13-95`). 8 built-in emitters
(`emitters/registry.ts:22-39`):

| Kind | EmitResult fields | Where defined | Effect surface |
|---|---|---|---|
| **hint** (context injection) | `hintText` (result.ts:27) | `builtin/hint.ts` | adapter appends to chat tail (`applyChatHintResults` hook-listener.ts:450) |
| **respond** (context injection / channel route) | `hintText` OR `action.channel`/`target` | `builtin/respond.ts` | inline text or channel-routed by adapter |
| **block** | `blocked`, `reason` (result.ts:23-25) | `builtin/block.ts` | adapter neuters tool args (`applyBlockResults` hook-listener.ts:403) |
| **compact** (context shrink) | `compacted`, `bytesDropped`, `linesDropped`, `compactOutcome`, `compactNeedsFallback`, `hintText`=body (result.ts:38-65) | `builtin/compact.ts` | adapter rewrites tool output + writes fallback file (`applyCompactResults` hook-listener.ts:315) |
| **exec** (side-effect) | `execOutput` (result.ts:29) | `builtin/exec.ts` | **runs subprocess inline in emitter** |
| **wake** (push) | `wakeTriggered` (result.ts:31) | `builtin/wake.ts` | **HTTP POST inline in emitter** |
| **notify** (push) | `notifyDelivered` (result.ts:35) | `builtin/notify.ts` | **HTTP POST (webhook/telegram) inline in emitter** |
| **audit** (file write) | `auditWritten` (result.ts:33) | `builtin/audit.ts` | **appendFileSync inline in emitter** |

Plus third-party namespaced emitters via `registry.register()` (registry.ts:49).
Render-routing metadata stamped by pipeline (not emitter): `priority`,
`semanticGroup`, `runtimeMeta`, `wrapperTemplate` (result.ts:70-94).

**The EmitResult is a flat union envelope** — every kind reuses one struct with
optional per-type fields, discriminated by `type`.

---

## 3. Is processing PURE? — NO. Side effects are inline. (Side effects inline)

Processing is **NOT pure**. Side effects occur at two layers:

### A. Pipeline-level side effects (pipeline.ts)
- `cooldowns.resetSession()` on session.compacted — **pipeline.ts:503**
- `approvals.detectAndGrant()` mutates approval ledger — **pipeline.ts:513**
- cooldown `allowed()`/`record()` read+write state backend — **pipeline.ts:533, 573, 656, 662**
- `approvals.check()`/`approvalConsume()` — **pipeline.ts:599, 617**
- `metricSink.counter/histogram` — **pipeline.ts:489, 515, 535, 541, 575, 649-651, 676**
- structured log writes (`swInfo`) — **pipeline.ts:492, 549, 687**
- `traceSink.emit(trace)` — **pipeline.ts:677, 714**
- `emitCoreBanner()` log on construct — **pipeline.ts:372**

### B. Emitter-level side effects (the impure emitters)
- **audit**: `appendFileSync` + `mkdirSync` writes JSONL — **builtin/audit.ts:38** (imports node:fs at :10)
- **exec**: `Bun.spawn` / `child_process.spawn` runs shell command — **builtin/exec.ts:32, 86**
- **wake**: `fetch(POST ctx.serverUrl/wake)` — **builtin/wake.ts:44**
- **notify**: `fetch(POST)` webhook + `fetch(api.telegram.org)` — **builtin/notify.ts:65, 101**; reads `process.env` token — :82

### C. PURE emitters (event-in → result-out, no I/O)
- **hint** (hint.ts) — only `resolveVariables` + return
- **block** (block.ts) — pure (consumes approval via ctx callback, no direct I/O)
- **respond** (respond.ts) — pure
- **compact** (compact.ts) — pure: reads `ctx.variables._rawOutput`, returns
  rewritten body in `hintText`; **the file write is deferred to the adapter
  applier** (compactNeedsFallback flag → applier does I/O). Good model.

### D. Adapter/applier side effects (hook-listener.ts + signal-wire.ts)
- `applyChatHintResults`: **mutates `output.parts[].text`** in place — hook-listener.ts:475
- `applyBlockResults`: **mutates `output.args`** (neuters command) — hook-listener.ts:415-418
- `applyCompactResults`: **mutates `output.output`** + `writeFallbackFile` (`writeFileSync`) — hook-listener.ts:282, 336+
- `attachRuntimeMeta` reads stats file each call — signal-wire.ts:793
- rules hot-reload writes (`writeRulesFile`, atomic rename) — signal-wire.ts:336, 738
- log file appends (`appendFileSync`) — signal-wire.ts:84; hook-listener.ts:54, 253
- spawn-brief-applier: `readFileSync`/`unlinkSync` brief files + in-memory Map — spawn-brief-applier.ts:92, 148

---

## 4. Where CONTEXT INJECTION happens vs where result is RETURNED

**Clean architectural seam already exists for hint/block/compact:**
- The **engine returns** `EmitResult[]` from `pipeline.process()` (pipeline.ts:709)
  and `evaluateHook()` hands it back **raw** (signal-wire.ts:839). For these
  three kinds the emitter is PURE — it only *describes* the intended mutation.
- The **injection/mutation is performed separately** by the appliers in
  `hook-listener.ts`: `applyChatHintResults` (hint→chat tail, :450),
  `applyBlockResults` (block→tool args, :403), `applyCompactResults`
  (compact→tool output + fallback file, :315). These are the
  **context-injector / file-writer**.

**Leaky for exec/wake/notify/audit:** for these 4, the side effect happens
**inside `emitter.execute()` during `pipeline.process()`** — there is NO
separate sink layer. The EmitResult is just an after-the-fact *receipt*
(`wakeTriggered`, `notifyDelivered`, `auditWritten`, `execOutput`). The
"socket-pusher" and "file-writer" for these is fused into the matcher run.

→ **Injector IS separable for hint/block/compact** (already split: pure emitter
+ adapter applier). **NOT separable as-built for exec/wake/notify/audit** —
those need extraction (see §Separability).

---

## 5. Multiple SINKS / consumers per matched event?

**Per matched RULE: yes (multi-action fan-out).** One rule can declare multiple
actions; pipeline iterates `sortedActions` and produces one `EmitResult` per
action (pipeline.ts:571-658). So one event → many rules → many actions → flat
`EmitResult[]`.

**Per OUTPUT KIND: effectively single-sink, hard-wired.** There is no generic
"sink registry" that lets N consumers subscribe to one matched event. Routing is
by `action.type` → exactly one `Emitter` in `EmitterRegistry`
(registry.ts:63, one entry per type, built-ins non-overridable :51). The adapter
appliers are likewise hard-coded one-per-kind in `hook-listener.ts`. There is a
plugin seam for *new action types* (`registry.register`, namespaced) but not for
*multiple sinks on the same result*. `toLegacy` (signal-wire.ts:882) is a lossy
single-sink collapse (hint/respond only).

**Verdict:** fan-out is **action-level**, not **sink/consumer-level**. To support
"emit once, deliver to many sinks (inject + log + push)" you'd add a sink layer
the refactor is reaching for.

---

## Separability assessment (extract a PURE processor)

**Already pure / trivially separable (3/8):** hint, block, compact — emitter
returns a description, adapter applier does the I/O. Use these as the template.

**Pipeline orchestration impurity (medium effort):** `pipeline.process()`
interleaves matching with stateful gating (cooldowns, approvals), metrics,
logs, trace. To get a pure `process(event, state) → EmitResult[]`:
- Move cooldown/approval reads to a pre-pass that yields an immutable decision
  set; move their *writes* to a post-pass keyed off the returned results.
- Inject metric/trace/log sinks (already injectable via config —
  pipeline.ts:364-365) and make them no-op by default (already are). Low risk.
- `evaluate()` (evaluator.ts) is already a pure matcher — keep as-is.

**Emitter impurity (higher effort — 4/8):** exec, wake, notify, audit perform
I/O inline (subprocess, HTTP POST, file append). To extract a pure processor:
- Convert each to the **compact pattern**: emitter returns a *directive*
  (`{kind:'exec', command}`, `{kind:'wake', url, body}`, `{kind:'notify',...}`,
  `{kind:'audit', record}`) with no I/O; move the subprocess/fetch/append into
  **adapter sinks** that run AFTER `process()` returns, mirroring the hint/
  block/compact appliers in `hook-listener.ts`.
- This makes `pipeline.process()` a **pure planner** (event → EmitResult[]
  describing intended effects) and introduces a uniform **sink dispatch layer**
  (the "context-injector / file-writer / socket-pusher" the refactor wants).

**Recommended target shape:**
1. `EmitResult` becomes purely declarative (it nearly is — `execOutput`/
   `wakeTriggered`/etc. are receipts that move to the sink layer).
2. A `SinkRegistry` (parallel to `EmitterRegistry`) maps result.type → 1..N
   sinks, enabling the multi-consumer fan-out missing today (§5).
3. The engine package exports the **pure planner** (match + plan, no I/O);
   each platform adapter (opencode-signal-wire) supplies sinks. `hook-listener.ts`
   appliers are 80% of the opencode sink layer already.

**Effort:** hint/block/compact = done. Pipeline state writes = a focused
refactor (split read-gate / write-record). exec/wake/notify/audit = 4 emitters
to invert into directive+sink. The hardest constraint is preserving ACTION_ORDER
ordering and the `actionsTakenSoFar` audit dependency (pipeline.ts:593, 646)
across the new plan→dispatch boundary.
