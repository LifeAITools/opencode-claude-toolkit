# Claude Code agent control — wire protocol & design (source-grounded)

Extracted from the real `@anthropic-ai/claude-agent-sdk` `cli.js` (not the docs — the
docs omit most of this). This package builds **on** the SDK so we never hand-roll the
protocol; the SDK owns it. This file records *why* the design is shaped the way it is.

## The transport reality (3 mechanisms, only one is for agent control)

| Mechanism | Transport | Purpose | Use for agent control? |
|---|---|---|---|
| Teammate mailbox (`[TeammateMailbox]`) | files `~/.claude/teams/<t>/inboxes/<a>.json` (append + poll, `flock`) | Agent Teams peer messaging | ❌ file-based, not a control socket |
| MCP/IDE (`class hKA`) | unix socket / WebSocket, JSON-RPC | MCP servers (incl. IDE `tabs_context_mcp`) | ❌ for MCP, not the agent |
| **SDK remote-io (`class AI1 extends so6`)** | **WebSocket** (or stdio) carrying **stream-json** | drive a Claude Code agent | ✅ **this is the socket control plane** |

`--sdk-url <ws-url>` makes the agent run `--print --input-format stream-json
--output-format stream-json --session-id <id> --replay-user-messages` and connect its
stream-json transport to **your** WebSocket server (instead of stdin/stdout). Auth:
`Authorization: Bearer <session ingress token>`. A `[bridge:session]` spawns one agent
per `session-id`, with `keepAliveTimer` in the transport. Addressing = `session-id ↔
WS connection`. (`ANTHROPIC_UNIX_SOCKET` is a *different* thing — routes the API
dispatcher over a unix socket; not agent control.)

## The stream-json control protocol (what flows over the transport)

Top-level message `type`: `user` · `assistant` · `result` · `system` ·
`control_request` · `control_response` · `control_cancel_request`.

Control is **request/response correlated by `request_id`** (the SDK's `so6` keeps a
`pendingRequests` Map). `control_request.subtype` ∈ `initialize` · `interrupt` ·
`can_use_tool` (permission) · `set_permission_mode` · `set_model` · `mcp_message` ·
`hook_callback`. Result/notification subtypes seen: `success` · `error` ·
`informational` · `compact_boundary` · `task_started` · `task_progress` ·
`task_notification` · `turn_duration` · `stop_hook_summary`.

**We do NOT implement any of this by hand.** The official `query()` returns a `Query`
(an `AsyncGenerator<SDKMessage>`) and exposes the control methods directly:
`interrupt()`, `setPermissionMode(mode)`, `setModel(model)`,
`setMaxThinkingTokens()`, `initializationResult()`. Input in streaming mode is an
`AsyncIterable<SDKUserMessage>` passed as `prompt` — we push messages into it.

## Design — what this package is

A thin, reusable control plane that COMPLIES by delegating to the SDK:

- **InputStream** — a push-based `AsyncIterable<SDKUserMessage>`; feeds the agent.
- **AgentHandle** — ONE agent: wraps `query({ prompt: InputStream, options })`,
  re-broadcasts the output `SDKMessage` stream to subscribers, and forwards control
  (`send`, `interrupt`, `setPermissionMode`, `setModel`) to the `Query`. Identity =
  `sessionId` (+ optional `role`, `project`). Resume via the SDK session APIs.
- **AgentBridge** — registry/router: `sessionId ↔ AgentHandle (+ role/project)`. Spawn,
  look up, address-by-session-id/role, lifecycle. Transport-agnostic (the SSOT seam to
  CentralRegistry lives here).
- **BridgeServer** — the socket adapter: a `ws` WebSocket server. Each connection is an
  agent endpoint addressed by `?session=<id>`; socket→`AgentHandle.send`, agent
  output→socket. Unix-socket variant trivial (ws over a unix `net.Server`).

Compliance principles: official SDK only · official message/control types · official
session APIs (`forkSession`/`resumeSession`/`renameSession`/`listSessions`/
`getSessionMessages`) · no parallel protocol · the SDK's `--sdk-url`/stdio choice is an
implementation detail behind `query()`.
