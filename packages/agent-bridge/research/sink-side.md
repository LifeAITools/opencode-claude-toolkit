# Sink Side — Event/Result Delivery Destinations

> Map of the **destinations** an event/result can be delivered to, feeding the
> refactor that splits "event emitter" from "event processor (context-injector /
> file-writer / socket-pusher)". All references are `file:line` against the
> source as of 2026-06-05.

Three candidate sinks exist in the codebase, at very different maturity levels:

1. **SOCKET PUSHER** — `agent-bridge` (live in-process delivery to a running SDK agent). **BUILT.**
2. **FILE WRITER** — Agent Teams file inbox (`~/.claude/teams/<t>/inboxes/<a>.json`). **SPEC ONLY** (no writer in our code) + several **audit/log writers** that exist and work.
3. **WAKE-ROUTER delivery** — HTTP `POST /wake` or vsock JSON-line to an *external* plugin listener. **BUILT but addresses a different surface** (plugin HTTP listener / Firecracker VM), **NOT the agent-bridge socket plane.**

---

## Sinks inventory

| Sink | API (the actual delivery call) | Built / Stub | Addressing |
|---|---|---|---|
| **Socket: live agent (in-process)** | `AgentBridge.send(sessionId, text)` → `AgentHandle.send(text)` → `InputStream.pushText()` → `InputStream.push(SDKUserMessage)` | **BUILT** — real, drains into SDK `query({prompt})` | `sessionId` (canonical) or `addressByRole(role)` → handle(s) |
| **Socket: WS envelope** | `bridge-server.ts` op `{op:"user", text}` → `bridge.send(session, text)` | **BUILT** | WS conn `?session=<id>`; auth `?token=` |
| **Socket: spawn/resume** | `AgentBridge.spawn(SpawnAgentOptions)` → `new AgentHandle(...)` wrapping SDK `query()` | **BUILT** | idempotent on `sessionId` |
| **Socket: control** | `AgentBridge.control(sessionId, {interrupt\|permission\|model})` | **BUILT** (forwards to SDK `Query`) | `sessionId` |
| **Socket: output fan-out** | `AgentHandle.onMessage(listener)`; bridge mirrors via `onSnapshot` | **BUILT** | per-handle subscribers |
| **File: Agent Teams inbox** | (none in our code) — Claude Code's own `[TeammateMailbox]` writes `~/.claude/teams/<t>/inboxes/<a>.json`, append+poll, `flock` | **SPEC ONLY** — documented in PROTOCOL.md, no writer/reader in this repo; no live team dirs present | `<team>/<agentName>` file path |
| **File: wake dispatch audit** | `wake-router/src/index.ts:376` `appendFileSync(AUDIT_LOG,…)` + `:398` unified signal-wire log | **BUILT** | n/a (observability) |
| **File: decision audit** | `wake-router/src/audit-log.ts:126` `appendAudit()` → `spawn-audit.jsonl` (rotation) | **BUILT** | n/a (observability) |
| **File: spawn brief** | `decision-engine.ts:382` `writeFileSync(brief-<nonce>.json)` in `tmpdir()/sw-spawn-briefs` | **BUILT** (but `/tmp`, chmod 600) | `spawnBriefRef` path handed to spawner |
| **File: Agent Teams lifecycle capture** | `agent-bridge.py` appends raw `Teammate*`/`Task*` payloads → `~/.claude-local/agent-teams-capture.jsonl` | **BUILT** (observation tap, live — 49KB) | n/a (observability) |
| **Wake: HTTP to plugin listener** | `transports/http.ts:17` `POST http://localhost:<port>/wake` (hdr `X-Wake-Token`, body=`WakeEvent`), 3 retries | **BUILT** | `agent.port` from discovery file |
| **Wake: vsock to VM agent** | `transports/vsock.ts:35` UDS `connect(vsockPath)` → JSON-line `{type:"wake_event",token,event}\n` | **BUILT** | `agent.vsockPath` from discovery file |
| **Wake: reuse-alive wake** | `decision-engine.ts` `wakeReusedAgent()` → `POST <url>/wake` `{type:"spawn_brief_dispatch",text}` | **BUILT** | `http://localhost:<port>` from registry |
| **Wake: spawn new process** | `decision-engine.ts:159` `EngineCtx.spawner: SpawnInvoker \| null` → `spawnNew({…})` | **STUB** — `index.ts:451` `spawner: null, // TODO Phase 6.3: wire context CLI invoker` | tmux session via `context project start` (planned) |

---

## 1. SOCKET sink — push a message into a live agent (BUILT)

The exact delivery chain to a **running** agent, end to end:

- `AgentBridge.send(sessionId, text)` — `agent-bridge.ts:71-76`. Looks up handle by sessionId, calls `a.send(text)`, returns false if no live handle.
- `AgentHandle.send(text)` — `agent-handle.ts:66-69`. `this.input.pushText(text, sessionId)` then flips state to `"running"`.
- `InputStream.pushText(text, sessionId)` — `input-stream.ts:27-34`. Wraps as `{type:"user", message:{role:"user",content:text}, parent_tool_use_id:null, session_id}` and calls `push()`.
- `InputStream.push(msg)` — `input-stream.ts:15-24`. Either resolves a waiting `next()` (agent currently awaiting input) or queues. This `AsyncIterable<SDKUserMessage>` is the `prompt` handed to the SDK `query()` (`agent-handle.ts:38`), so the agent receives it **mid-session**. This is the only supported feed path per the SDK (PROTOCOL.md:45).

Addressing options:
- By session: `AgentBridge.get(sessionId)` — `agent-bridge.ts:61`.
- By role: `AgentBridge.addressByRole(role)` — `agent-bridge.ts:66-68` returns all live handles with that role (the org-level seam the wake-router/task-assigner is *meant* to call).

WS exposure (`BridgeServer`, `bridge-server.ts`): one WS conn per `?session=<id>`; controller→bridge ops `attach|spawn|user|interrupt|permission|model|board` (`:85-117`); bridge→controller events `message|snapshot|board|ack|error` (envelope doc `:9-19`). The `{op:"user", text}` path (`:102-104`) is the socket-level push.

**Verdict: fully built, real, no stub.** It is the only sink that delivers into a *live in-process* SDK agent. It is NOT wired to anything upstream (no wake-router, no signal-wire caller).

## 2. FILE sink — Agent Teams inbox (SPEC ONLY) + audit writers (BUILT)

**Agent Teams inbox** — the peer-messaging mailbox. Documented in
`PROTOCOL.md:11`: path `~/.claude/teams/<t>/inboxes/<a>.json`, **append + poll**,
**`flock`** for concurrency. Envelope (per task brief / reverse-engineered):
`{from, text, timestamp, color}`.

- **There is NO writer or reader for this format anywhere in our code.** Grep for `inboxes|writeToMailbox|TeammateMailbox|proper-lockfile|flock` across `packages/` returns only `PROTOCOL.md`.
- The format lives inside Claude Code's own bundled binary (`~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe` — a compiled Bun single-file binary, not greppable JS), so even the envelope shape is **reverse-engineered, not source-confirmed**.
- `~/.claude/teams/` is currently **empty** (no active teams), so no live sample exists to validate the envelope against.
- We DO passively observe Agent Teams **lifecycle events** (not inbox messages) via the `agent-bridge.py` tap → `~/.claude-local/agent-teams-capture.jsonl` (live, 49KB; events `TaskCompleted`, `Teammate*`, raw hook payloads with `session_id`, `cwd`, `task_id`, `task_subject`, `task_description`). This is a *read/capture* side-channel, not a writer into the inbox.

**Audit/log file writers that DO exist and work** (these are real "file sinks", but for observability, not agent delivery):
- `wake-router/src/index.ts:376` — wake-dispatch audit `~/.opencode/wake/audit.jsonl`; `:398` forwards a unified entry to `~/.context/hooks/audit/signal-wire-audit.jsonl` (`caller='wake-router'`, `correlation_id=eventId`).
- `wake-router/src/audit-log.ts:126` `appendAudit()` — decision-engine audit `~/.opencode/wake/spawn-audit.jsonl` with 50MB rotation (`:155 rotateIfNeeded`).
- `decision-engine.ts:382` — ephemeral spawn brief JSON in `tmpdir()/sw-spawn-briefs/brief-<nonce>.json` (chmod 600), referenced by `spawnBriefRef`.

**Verdict: the agent-delivery file sink (Teams inbox) is spec-only with an unverified envelope; only observability file writers are built.**

## 3. WAKE-ROUTER — how a wake event reaches an agent TODAY

End-to-end pipeline (`wake-router/src/index.ts:247 handleEvent`):
classify → rate-limit/dedup → `registry.getAgent()` → subscription filter →
signal-wire engine (opt-in block/hint) → **transport.send(agent, event)**.

Two **built** transports, selected by `agent.transport` (`index.ts:332`):

- **HTTP** (`transports/http.ts:17`): `POST http://localhost:<agent.port>/wake`, header `X-Wake-Token: <agent.token>`, body = `WakeEvent` JSON, 3 retries w/ backoff, 5s timeout. Target = an **agent-side plugin HTTP listener** (the opencode/Claude-Code signal-wire plugin), NOT the agent process directly.
- **VSOCK** (`transports/vsock.ts:35`): UDS `connect(agent.vsockPath)`, writes JSON-line `{type:"wake_event", token, event}\n` matching `kiberos-worker-ts vsock-channels.ts sendToQueryChannel()`. Target = a **Firecracker microVM agent**'s query channel.

A third path — **spawn a fresh agent** — is a **STUB**: `EngineCtx.spawner: SpawnInvoker | null` (`decision-engine.ts:159`), and the production wiring sets `spawner: null` with `// TODO Phase 6.3: wire context CLI invoker` (`index.ts:451`). When present it would call `context project start` to create a **tmux** session (`SpawnInvoker.spawnNew` returns `{tmuxSession}`, `decision-engine.ts:164-172`) — i.e. an OS-process/tmux spawn, **not** an in-process SDK `query()` handle.

**Is it vsock-only / does it work for local Claude Code agents?**
- Not vsock-only — HTTP is the default/local transport; vsock is specifically for Firecracker VMs.
- For a **local** agent it delivers to that agent's **plugin HTTP listener** on `localhost:<port>` (discovered via `~/.opencode/wake/*` discovery files + `router.json`). It assumes the agent runs a `/wake` HTTP endpoint (the signal-wire plugin). It does **not** speak the SDK stream-json control protocol and does **not** push a `SDKUserMessage` into a running `query()`.

**Does wake-router reference agent-bridge? NO — confirmed.** Grep for
`agent-bridge|AgentBridge|BridgeServer|sdk-url|InputStream` across
`wake-router/src/` returns **zero** hits. The two systems are entirely disjoint.

Other wake-router agent-facing endpoints: `/identity/provision` (`index.ts:434`, plugin bootstrap → SynqTask identity) and `/agent-action/request` (`index.ts:453` → decision-engine `decide()`), neither of which delivers a *message into a live agent*.

---

## THE GAP

The wake/signal-wire control plane and the agent-bridge socket plane **share no
wire**. Specifically, nothing connects an upstream event to
`AgentBridge.send` / `addressByRole`:

1. **No transport adapter targets the bridge.** wake-router's transports
   (`http.ts`, `vsock.ts`) deliver to an external plugin listener (HTTP `/wake`)
   or a VM query channel (vsock). There is **no** "bridge transport" that opens a
   WS to `BridgeServer (?session=<id>)` and sends `{op:"user", text}`, nor one
   that calls `AgentBridge.send()` in-process. (`wake-router/src/index.ts:84-85`
   instantiates only `HttpTransport` + `VSocketTransport`.)

2. **The spawn sink is a stub on the wake-router side.** `EngineCtx.spawner` is
   `null` (`index.ts:451`); the only designed spawn target is `context project
   start` → **tmux** (`decision-engine.ts:164`), an OS process — not an
   `AgentBridge.spawn()` in-process SDK handle. So even "spawn new" does not flow
   through the bridge.

3. **`addressByRole` has no caller.** `agent-bridge.ts:66` exists as the org-level
   addressing seam "so the wake-router / task assigner can deliver to a live
   agent" (per its own doc `agent-bridge.ts:6-7`), but no code calls it. The
   wake-router resolves targets via its **own** `AgentRegistry` (discovery files),
   a parallel registry that is **not** the bridge's `Map<sessionId, AgentHandle>`.

4. **Two disjoint agent registries / identity models.** Bridge: in-process
   `sessionId → AgentHandle` (`agent-bridge.ts:28`). Wake-router: file-discovery
   `memberId/sessionId → AgentRecord {port, vsockPath, token, transport}`
   (`registry.ts`). Nothing reconciles them; a `sessionId` known to one is not
   known to the other.

5. **The Agent Teams file inbox sink is unimplemented.** No writer exists; the
   envelope is reverse-engineered and unverified against a live file. If the
   refactor wants a "file-writer" sink (peer mailbox), it must be **built**, and
   the `{from,text,timestamp,color}` + `flock` contract validated against a real
   team dir first.

6. **`onSnapshot` SSOT mirror is unwired.** `AgentBridgeConfig.onSnapshot`
   (`agent-bridge.ts:24`) is the intended seam to mirror bridge state into
   CentralRegistry/SynqTask (so wake-router could *discover* bridge-managed
   agents), but no production caller provides it — so wake-router can never learn
   that a bridge agent exists.

**Net:** the only **built** sink that delivers into a live in-process SDK agent
is `AgentBridge.send` / `BridgeServer {op:"user"}` — and it is an island. Every
**built** wake-router delivery path targets a *different* surface (plugin HTTP
listener, VM vsock channel), and its in-process-spawn path is a `null` stub. The
refactor's "socket-pusher" processor is the bridge; wiring it requires either (a)
a new wake-router **BridgeTransport** (WS→`?session=`, or in-process
`AgentBridge.send`) plus an `onSnapshot`→registry mirror so the router can
address bridge agents, or (b) making `SpawnInvoker` spawn via `AgentBridge.spawn`
instead of tmux. Neither exists today.
