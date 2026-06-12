# Emitter side of the signal-wire / opencode-plugin architecture

Scope: `/home/relishev/projects/vibe/claude-code-sdk/packages/opencode-signal-wire/`
Purpose: map where events are BORN and where emission is COUPLED to processing (context-injection / file-write / socket-push), to drive a refactor that splits **event emitter** from **event processor**.

Key finding up front: there is **NO event-bus / pub-sub / fan-out seam**. Every emission point is wired **1 emitter → 1 inline processor** directly inside the same callback. "Emit" and "apply" (inject prompt / write file / mutate the live hook output) happen in the same `await`, in the same function. The `SignalWire` engine (`evaluateHook` / `evaluateExternal`) is the only shared layer, but it returns `EmitResult[]` synchronously to the caller, which then **immediately applies** them — the engine does not own a dispatcher.

---

## 1. Event sources (emission points)

All emission registration lives in **`plugin.ts` → `default.server()` return object** (the opencode hook table), lines 656–938, plus two background watchers and one external HTTP server.

| # | Source / trigger | Where registered | Payload shape | Emitting fn |
|---|---|---|---|---|
| A | `chat.message` (≈ UserPromptSubmit) | `plugin.ts:722` | `{sessionID, agent, model, messageID}` + `{message, parts}` → normalized to `SignalWireEvent{source:'hook', type:'chat.message', payload:{parts,message,agent,prompt}}` | `normalizeChatMessage` (`hook-listener.ts:141`) → `signalWireEngine.evaluateHook` |
| B | `tool.execute.before` (≈ PreToolUse) | `plugin.ts:820` | `{tool, sessionID, callID}` + live mutable `{args}` → `SignalWireEvent{type:'tool.before', payload:{tool,callID,args,toolName}}` | `normalizeToolBefore` (`hook-listener.ts:89`) → `evaluateHook` |
| C | `tool.execute.after` (≈ PostToolUse) | `plugin.ts:903` | `{tool,sessionID,callID,args}` + mutable `{title,output,metadata}` → `SignalWireEvent{type:'tool.after', payload:{...,output,response:{output}}}` | `normalizeToolAfter` (`hook-listener.ts:112`) → `evaluateHook` |
| D | `pre_tool_use` (spawn/task intercept) | `plugin.ts:695` | `{toolName, input}` (task description/subagent_type) | `handlePreToolUseSpawnCheck` → `routeTaskThroughEngine` (`plugin.ts:213`) — POSTs to wake-router `/agent-action/request` |
| E | `experimental.chat.system.transform` | `plugin.ts:704` | `{sessionID, model}` + mutable `{system:string[]}` | `systemTransformHook` (`system-prompt-hook.ts:136`) |
| F | `tool.definition` | `plugin.ts:709` | `{toolID}` + mutable `{description, parameters}` | `toolDefinitionHook` (`tool-definition-hook.ts:151`) |
| G | opencode lifecycle `event` (`session.created/updated`, `app.exit`, `server.stop`) | `plugin.ts:657` | raw opencode event | inline in `event` callback (session bind / listener stop) — no signal-wire eval |
| H | **External wake** (`POST /wake`) | `wake-listener.ts:1713` (Bun.serve at `:1924`) | `WakeEvent{eventId,source,type,priority,targetMemberId,payload,timestamp}` (`wake-types.ts:101`) | `handleWake` (`wake-listener.ts:1730`) → `signalWireInstance.evaluateExternal` |
| I | **Quota watcher** (file-watch on `quota-status.json`) | started `plugin.ts:646`; impl `quota-watcher.ts` | synthesizes `WakeEvent{source:'proxy', type:'quota_critical|warning|recovered|status'}` (`quota-watcher.ts:178`) | `synthesizeWakeEvent` → `signalWire.evaluateExternal` + `injectContextEvent` |
| J | **Heartbeat** (30s interval) | `heartbeat.ts:41` | none — rewrites `lastSeen` in discovery file | liveness only, NOT a signal-wire event (pure file-writer) |
| K | **Token-rotation turn boundary** | inside `chat.message`, `plugin.ts:730–743` | none — triggers `sdk.tokenRotation.applyPending('turn-boundary')` | piggybacks on source A; side-effect, not an event |

Two engine entry methods, defined in the `signalWireEngine` wrapper (`plugin.ts:512–543`):
- `evaluateHook(event)` → raw `EmitResult[]` (in-process hooks A/B/C).
- `evaluateExternal(event)` → `{matched, actionsExecuted, wakeTriggered, hintTexts}` (wake/quota H/I). Note: `evaluateExternal` **pre-extracts `hintTexts`** from results at `plugin.ts:521–528` — the first sign that even the "engine boundary" is shaped for one specific downstream consumer.

---

## 2. Per-source: emit-only vs emit+process (the coupling)

**Every signal-wire source also processes inline.** None of A–I merely emit.

### A — `chat.message` (`plugin.ts:722–818`)
Emits, then in the SAME try-block:
- mutates engine runtime state: `signalWire.setSessionId`, `trackModel`, `trackTokens` (`plugin.ts:759–786`),
- `const results = await signalWireEngine.evaluateHook(event)` (`:787`),
- **applies inline**: `applyChatHintResults(results, output, …)` mutates `output.parts[last].text` (`:790`),
- **fires a secondary side-effect**: if rule `quota-on-demand-trigger` matched, `quotaHandle.injectCurrentSnapshot()` (`:806–809`).
> Quote: `const injected = applyChatHintResults(results, output ?? { parts: [] }, event.sessionId)` (`plugin.ts:790`).

### B — `tool.execute.before` (`plugin.ts:820–901`)
Two processors stacked before the engine even runs:
- ephemeral-brief tool block: mutates `output.args = {_swBlocked…}` (`plugin.ts:832–847`),
- role-based block: mutates `output.args` (`:856–869`),
- then engine eval + `applyBlockResults(results, output, input.tool)` which **rewrites `output.args.command`** to a safe `echo` (`hook-listener.ts:403–424`, called `plugin.ts:888`).
> Quote: `const blockReason = applyBlockResults(results, output ?? { args: {} }, input?.tool)` (`plugin.ts:888`).

### C — `tool.execute.after` (`plugin.ts:903–937`)
Emits then applies TWO processors in mandated order:
- `applyCompactResults(...)` — **rewrites `output.output`** and **writes a fallback file** to `~/.local/share/opencode/tool-output/` (`hook-listener.ts:315–384`; file write `writeFallbackFile` `hook-listener.ts:269`),
- `applyHintResults(...)` — **appends hint text to `output.output`** (`hook-listener.ts:193–203`).
> Quote: `const compactResult = applyCompactResults(results, safeOutput, event.sessionId); const injected = applyHintResults(results, safeOutput, event.sessionId)` (`plugin.ts:919–920`).

### D — `routeTaskThroughEngine` (`plugin.ts:213–372`)
Emits (POST to router) AND processes the decision inline: on `inline_ok` it **registers a brief** (`registerBrief`, `plugin.ts:327–332`); on denial/error it **returns a `{decision:'block', message}`** that opencode applies to abort the tool. Emission and policy-application fused.

### E — `systemTransformHook` (`system-prompt-hook.ts:136–189`)
Pure processor, no engine: reads brief/identity, **mutates `output.system[]`** directly (`:162`, `:179`, `:183`). Reads identity cache file from disk on each call (`:68–96`).

### F — `toolDefinitionHook` (`tool-definition-hook.ts:151–171`)
Pure processor: **mutates `output.description` + `output.parameters`** (`:163–167`).

### H — `handleWake` (`wake-listener.ts:1730–1920`)
The densest coupling. One handler does: auth, dedup, SynqTask lifecycle sync (`syncTaskStart`, `syncExplicitTaskResultOrCompletion`, `:1769–1770`), engine eval (`evaluateExternal`, `:1794`), and **three different inline injection sinks** branched by result shape:
- hint actions → `injectHintText` (`:1806`),
- `wake`-action → fall through to `injectWakeEvent` (`:1904`, full LLM-loop, `promptAsync`),
- advisory (quota) → `injectContextEvent` (`:1875`, `noReply:true`),
- plus busy-check + `queueWakeEvent` fallback (`:1891–1919`).

### I — quota watcher (`quota-watcher.ts`)
Synthesizes the event AND injects it: `evaluateExternal` for cooldown/audit, then explicitly `injectContextEvent(event, sessionId)` because "the engine's wake-emitter doesn't inject for us" (`quota-watcher.ts:249–292`, comment at `:254`). Emitter and sink in one function.

---

## 3. How a result is physically applied back

There is no central applier. Application is done **in the hook callback that emitted**, by mutating the live mutable second-arg object opencode passes in. Physical sinks:

| Result kind | Physical injection site | Mechanism |
|---|---|---|
| hint → chat | `applyChatHintResults` `hook-listener.ts:450–478` | append to `output.parts[lastText].text` (in-place, to keep validator fields) |
| hint → tool output | `applyHintResults` `hook-listener.ts:193–203` | `output.output += '\n'+packed.text` |
| block | `applyBlockResults` `hook-listener.ts:403–424` | rewrite `output.args.command` to `echo` (Bash) or empty `output.args` |
| compact + file | `applyCompactResults` `hook-listener.ts:315–384` | rewrite `output.output`; `writeFallbackFile` → `~/.local/share/opencode/tool-output/` (`:269–290`) |
| system prompt | `system-prompt-hook.ts:162/179/183` | mutate `output.system[]` |
| tool def | `tool-definition-hook.ts:163–167` | mutate `output.description`/`parameters` |
| external/wake → LLM | `injectWakeEvent` `wake-listener.ts:1516` | `sdkClient.session.promptAsync` (noReply:false, forces turn) |
| external advisory → context | `injectContextEvent` `wake-listener.ts:1485` | `sdkClient.session.prompt` (noReply:true) |
| external hint → context | `injectHintText` `wake-listener.ts:1567` | `sdkClient.session.prompt` (noReply:true), wrapped `<signal-wire-hint>` |

The SDK socket-push sink is `_sdkClient.session.prompt / promptAsync` — a module-global `_sdkClient` in wake-listener (`:1618`). All three external inject fns share it.

---

## 4. Is there an event-bus / fan-out seam?

**No.** It is strictly 1 emitter → 1 inline processor everywhere.
- The closest thing to a shared layer is the `SignalWire` engine wrapper (`plugin.ts:512–543`), exposing `evaluateHook` / `evaluateExternal`. But the engine is a **pure evaluator** that returns results to the caller; it does not dispatch, fan out, or own subscribers. The caller is responsible for applying.
- There are no listeners/subscribers, no `EventEmitter`, no queue between emit and apply (the only queue — `queueWakeEvent`, `wake-listener.ts:1652` — is a busy-retry buffer for ONE sink, not a fan-out bus).
- Multiple downstreams of the SAME event are achieved by **stacking `if`-branches in one function** (see H, which hand-routes to three sinks), not by publishing to N subscribers.
- The `evaluateExternal` wrapper hard-codes extraction of `hintTexts` (`plugin.ts:521`) — coupling the engine boundary to one specific consumer instead of returning a neutral result other processors could subscribe to.

This is exactly the seam the refactor needs to introduce: a dispatcher between `evaluate*()` and the apply-functions, so emitters publish a normalized result and N processors (context-injector, file-writer, socket-pusher, auditor) subscribe independently.

---

## 5. The wake / external path (how an external event enters)

1. **wake-router** (separate L2 service) discovers this plugin via the discovery file (`~/.opencode/wake/agents/<pid>-<session>.json`, written `wake-listener.ts:1937`) which carries `port` + `token`.
2. Router POSTs a `WakeEvent` to `http://<host>:<port>/wake` with header `X-Wake-Token` (`wake-listener.ts:1713`). The Bun.serve listener is `wake-listener.ts:1924`.
3. `handleWake` (`:1730`): auth (`:1732`) → JSON parse → field validation (`:1753`) → dedup `hasSeenWakeEvent` (`:1762`) → SynqTask lifecycle sync (`:1769`).
4. Routes through `signalWireInstance.evaluateExternal(event)` (`:1794`), then branches to a sink (§2.H): `injectHintText` / `injectWakeEvent` / `injectContextEvent`, with busy-check + queue fallback.
5. **Reverse direction** (this plugin → router): `routeTaskThroughEngine` (source D) calls `requestAgentAction` (`agent-action-client.ts:147`) → POST `/agent-action/request` (router URL from `~/.opencode/wake/router.json`, `agent-action-client.ts:22`). Decision (`inline_ok` / `denied`) is applied inline by registering a brief or blocking the task tool.

So "external event in" = HTTP POST `/wake` → `handleWake` → engine eval → inline inject via `_sdkClient.session.prompt*`. The trigger is always a context injection into the running opencode session's LLM loop.

---

## Coupling points (where emission and processing are entangled)

These are the exact lines a refactor must cut to separate emitter from processor:

1. **`plugin.ts:787–809`** — `chat.message`: `evaluateHook` immediately followed by `applyChatHintResults` + `quotaHandle.injectCurrentSnapshot` in the same try. Emit + 2 sinks fused.
2. **`plugin.ts:886–888`** — `tool.execute.before`: `evaluateHook` → `applyBlockResults` mutates live `output.args` inline. (Plus pre-engine brief/role blocks at `:832–869` that mutate args BEFORE any event is emitted.)
3. **`plugin.ts:913–920`** — `tool.execute.after`: `evaluateHook` → ordered `applyCompactResults` (rewrites output + writes file) → `applyHintResults` (appends), all inline.
4. **`plugin.ts:521–535`** — `evaluateExternal` wrapper hard-extracts `hintTexts` from `EmitResult[]`, coupling the engine boundary to the hint-injection consumer.
5. **`wake-listener.ts:1792–1858`** — `handleWake` hand-routes ONE engine result to three different sinks via `if`-branches (`injectHintText` / fall-through-to-`injectWakeEvent` / audit-only). This is the fan-out that should be a dispatcher.
6. **`wake-listener.ts:1871–1919`** — same handler additionally owns advisory-vs-actionable branching, busy-check, and queue fallback — policy + transport + sink in one function.
7. **`hook-listener.ts:269–290 / 315–384`** — `applyCompactResults` is both a transformer (rewrite `output.output`) AND a file-writer (`writeFallbackFile`). Two distinct processor responsibilities in one applier.
8. **`quota-watcher.ts:241–292`** — synthesize event + `evaluateExternal` + explicit `injectContextEvent` in one `processAccount` body; emitter cannot be reused without dragging the injector.
9. **Module-global `_sdkClient`** (`wake-listener.ts:1618`) is the shared socket-push sink for `injectWakeEvent` / `injectContextEvent` / `injectHintText`; the three external sinks are not abstracted behind a pluggable transport.
10. **`plugin.ts:730–743`** — token-rotation `applyPending` piggybacks on the `chat.message` emission point (turn boundary) — an unrelated side-effect coupled to an event source purely for timing.
