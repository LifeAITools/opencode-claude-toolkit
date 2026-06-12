# Event Emitter / Processor split — synthesis & design

> Consolidates `emitter-side.md`, `processor-side.md`, `sink-side.md`.
> Directive (user): **split the event EMITTER from the event PROCESSOR (context-injector / file-writer / socket-pusher).**

## 1. Current state — the coupling

The signal-wire **engine** is already a pure evaluator: `event → EmitResult[]`. The coupling is NOT in the engine — it is in the **callers**, which inline-apply results in fused try-blocks.

```
                      ┌─────────────── ENGINE (pure-ish) ───────────────┐
event source ──emit──▶│ rulesStore.match → Pipeline.process → EmitResult[]│──▶ caller applies INLINE
                      └──────────────────────────────────────────────────┘
```

**Emission ↔ processing entanglement (emitter-side.md):**
- No event-bus / pub-sub anywhere. Strictly 1 emitter → 1 inline processor.
- `plugin.ts` hooks fuse evaluate + apply in one block: chat.message (`:787`), tool.before (`:886`, mutates live `output.args`), tool.after (`:913`, rewrites output **and writes a file**).
- `wake-listener.ts handleWake` (`:1792`) is the densest knot: ONE result hand-routed to 3 sinks (inject-hint / inject-wake / audit) via `if`-branches + busy-check + queue + SynqTask sync.
- Module-global `_sdkClient` is the shared socket-push sink — not abstracted behind a transport.

**Output kinds (processor-side.md):** 8 result types in one flat `EmitResult` union — hint, respond, block, compact, exec, wake, notify, audit.
- **3/8 already split** (hint/block/compact): pure emitter returns a *directive*, separate **applier** in `hook-listener.ts` mutates. ← **this is the template.**
- **4/8 do I/O inside `execute()`** (audit `appendFileSync`, exec `Bun.spawn`, wake/notify `fetch POST`) — effect fused into the match run, EmitResult is just a receipt. ← **must be inverted to directive+sink.**
- Fan-out is **action-level, not sink-level**: each `result.type` routes to exactly ONE emitter/applier. No multi-consumer sink registry.

**Sinks (sink-side.md):**
| Sink | API | State | Addressing |
|---|---|---|---|
| Socket-pusher (agent-bridge) | `AgentBridge.send(sessionId,text)` → `AgentHandle.send` → `InputStream.push`; `addressByRole(role)` | **BUILT, but an island — no upstream caller** | sessionId / role |
| File-writer (Agent Teams inbox) | `~/.claude/teams/<t>/inboxes/<a>.json`, `{from,text,timestamp:ISO,color}`, flock | **SPEC ONLY** — no writer in our code | recipient name |
| Wake-router | HTTP `POST /wake` (plugin listener) or vsock (Firecracker) | BUILT, but targets the **plugin**, not SDK stream-json; does NOT push into live `query()`; spawn = `null` TODO (tmux) | memberId→{port,vsockPath,token} |

**The gap:** wake-router has **zero** references to agent-bridge. Disjoint registries (bridge in-process `sessionId→AgentHandle` vs wake-router file-discovery `memberId→AgentRecord`). `addressByRole` + `onSnapshot` SSOT mirror unwired.

## 2. Proposed split — Emitter → SinkRegistry → Processor[]

Introduce a **SinkRegistry** (parallel to the existing per-action EmitterRegistry) that maps a neutral, pure result to **1..N independent sinks**. The engine PLANS (pure); sinks EXECUTE (effects), each subscribing independently.

```
                                            ┌─▶ ContextInjector  (hint/respond → inject into THIS agent's prompt)
event ──▶ EMITTER (engine, pure) ──EmitResult[]──▶ SinkRegistry ─┼─▶ FileWriter      (→ Agent Teams inbox / audit jsonl)
            (plan only, no I/O)                  (fan-out)        ├─▶ SocketPusher    (→ AgentBridge.send/addressByRole — live agent)
                                                                 └─▶ Auditor         (→ append-only trace)
```

**Principles:**
1. **Emitter is pure** — produces directives, never does I/O. (3/8 already are; invert the other 4.)
2. **Sinks are pluggable + independent** — emitter doesn't know who consumes. One result can fan out to many sinks.
3. **Reuse the existing directive+applier template** (hint/block/compact) — generalize it to ALL result kinds via the registry.
4. **The socket-pusher sink closes the agent-bridge gap** — it wraps `AgentBridge.send`/`addressByRole`, giving the island its upstream caller.
5. **Context-injection, file-write, socket-push become three interchangeable sinks for the SAME event** — exactly the user's split.

**Hardest constraint (processor-side.md):** preserve `ACTION_ORDER` + `actionsTakenSoFar` audit dependency across the new plan→dispatch boundary. The registry must dispatch in deterministic order and let auditing observe the full plan.

## 3. Phased plan (proposed)

- **P0 — Define the seam (types).** `Sink` interface (`canHandle(result) / deliver(result, ctx)`), `SinkRegistry` (ordered, 1..N per type), neutral `ProcessedEvent` carrying the pure `EmitResult[]` + context. No behavior change yet.
- **P1 — Extract existing appliers into sinks.** Move `applyChatHintResults`/`applyBlockResults`/`applyCompactResults` (hook-listener.ts) behind a `ContextInjectorSink` + `FileWriterSink` (compact already writes a file). Pure mechanical lift — keep order. Tests: golden output identical.
- **P2 — Invert the 4 side-effecting emitters.** audit/exec/wake/notify return directives; their I/O moves into `AuditorSink` / `ExecSink` / `WakePostSink` / `NotifySink` (using compact's deferred-I/O pattern). Engine becomes fully pure.
- **P3 — SocketPusher sink + agent-bridge wiring.** New `SocketPusherSink` wrapping `AgentBridge` (send/addressByRole). Wire `onSnapshot`→CentralRegistry so the router can discover bridge agents. This is where wake-delivery shifts from HTTP-POST-to-plugin → socket-push-into-live-query.
- **P4 — Collapse `handleWake`'s if-branch fan-out** into the registry (the densest knot). wake-listener publishes a ProcessedEvent; sinks subscribe.
- **P5 — (optional) File-writer Agent Teams inbox** — only if we want file-based async pickup as a sink (validate the envelope against a real `~/.claude/teams/` first; currently empty/unverified).

## 4. Open decisions for the user
1. **Home of the seam:** does the `SinkRegistry` live in `signal-wire-core` (engine-adjacent, reused by all consumers) or in the opencode plugin layer? (Recommend: core — it's the SSOT seam.)
2. **Scope now:** P0–P2 (pure split, no new behavior — pays down the coupling debt) vs P0–P4 (also close the agent-bridge gap / live socket delivery)?
3. **File-writer sink (P5):** build it now or defer until a concrete async-pickup need (the socket plane already covers live delivery)?
4. **Wake delivery migration:** keep HTTP-POST-to-plugin AND add socket-push as a parallel sink, or migrate wake-router fully onto the bridge transport?
