# Architecture — opencode-claude-toolkit

**One toolkit, five packages, one responsibility each.**

## Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: CORE LIBRARY                                                  │
│                                                                         │
│  @life-ai-tools/claude-code-sdk         (no runtime of its own)         │
│    • KeepaliveEngine — cache-keepalive with 9 safety patches           │
│    • ProxyClient — orchestrator using port/adapter pattern              │
│    • 5 port interfaces + 6 default adapters                            │
│    • OAuth helpers, FileCredentialStore, types                         │
│                                                                         │
│  Used by: everything below (as a library import)                       │
└─────────────────────────────────────────────────────────────────────────┘
                                 ▲
                                 │ imports
       ┌─────────────────────────┼────────────────────────┬─────────────┐
       │                         │                        │             │
┌──────┴─────────┐    ┌──────────┴──────────┐   ┌─────────┴──────┐  ┌───┴──────┐
│ LAYER 2A:      │    │ LAYER 2B:           │   │ LAYER 2C:      │  │ LAYER 2D:│
│ HTTP PROXY     │    │ IN-PROCESS PLUGIN   │   │ OPENAI-COMPAT  │  │ SIGNAL-  │
│                │    │                     │   │ HTTP SERVER    │  │ WIRE     │
│ @kiberos/      │    │ @life-ai-tools/     │   │                │  │          │
│ claude-max-    │    │ opencode-claude     │   │ @life-ai-tools │  │ @life-ai │
│ proxy          │    │                     │   │ /opencode-     │  │ -tools/  │
│                │    │ opencode plugin —   │   │ proxy          │  │ opencode │
│ Standalone     │    │ uses SDK directly   │   │                │  │ -signal- │
│ daemon (Bun    │    │ in opencode's       │   │ Exposes        │  │ wire     │
│ HTTP server).  │    │ Node process.       │   │ OpenAI API on  │  │          │
│                │    │                     │   │ 127.0.0.1:4040 │  │ Agent    │
│ Two modes:     │    │ Registers provider  │   │ translates to  │  │ coord    │
│  - global      │    │ 'claude-max' in     │   │ Anthropic.     │  │ (separate│
│    (systemd)   │    │ opencode config.    │   │                │  │ concern, │
│  - embedded    │    │                     │   │ For Cursor,    │  │ not      │
│    (per-app)   │    │                     │   │ raw OpenAI     │  │ cache)   │
│                │    │                     │   │ clients.       │  │          │
│ For native     │    │                     │   │                │  │          │
│ `claude` CLI   │    │                     │   │                │  │          │
└────────────────┘    └─────────────────────┘   └────────────────┘  └──────────┘
     │                         │                        │                │
     ▼                         ▼                        ▼                │
           All three upstream to api.anthropic.com                       │
           via SDK-owned logic (KA, OAuth, rate-limit tracking)          │
                                                                         │
           opencode-claude uses signal-wire package ──────────────────── ┘
```

## Packages

| Package | Version | Size | Role |
|---|---|---|---|
| `@life-ai-tools/claude-code-sdk` | 0.11.0 | core | Library: ProxyClient, KeepaliveEngine, OAuth, types |
| `@kiberos/claude-max-proxy` | 0.5.0 | ~420 LOC | HTTP server wrapping SDK for native `claude` CLI |
| `@life-ai-tools/opencode-claude` | 1.2.0 | ~2130 LOC | opencode plugin adapter |
| `@life-ai-tools/opencode-proxy` | 0.5.0 | ~900 LOC | OpenAI-compat HTTP server |
| `@life-ai-tools/opencode-signal-wire` | 0.1.0 | ~2200 LOC | Agent coordination (extracted from opencode-claude) |

## Hybrid Architecture (Ports & Adapters)

The SDK's `ProxyClient` doesn't hard-code credentials storage, event
emission, or session storage. Instead it accepts **interfaces** (ports) and
any consumer can plug in their own **adapters**.

### Ports (interfaces in `src/proxy-ports.ts`)

- **`ICredentialsProvider`** — how to get OAuth tokens
- **`IEventEmitter`** — where to send observability events
- **`ISessionStore`** — per-session state (engine, PID, lastRequestAt)
- **`IUpstreamFetcher`** — HTTP transport to api.anthropic.com
- **`ILivenessChecker`** — is a PID alive?

### Default adapters (in `src/proxy-adapters.ts`)

- `FileCredentialsProvider` — reads `~/.claude/.credentials.json`
- `ConsoleEventEmitter` / `NullEventEmitter`
- `InMemorySessionStore` — Map with PID reaping
- `DefaultLivenessChecker` — POSIX `kill(pid, 0)`
- `NativeFetchUpstream` — global fetch

### Custom adapters in claude-max-proxy

Proxy-package provides two thin adapter classes:

- `ProxyConfigCredentialsAdapter` — wraps local `getAccessToken` so
  proxy's config-driven credentials path feeds into ProxyClient
- `BusEventEmitterAdapter` — wraps proxy's TypedEventBus so SDK events
  route through logger + TUI + heartbeat pipeline

## Usage Recipes

### Native `claude` CLI (via claude-max wrapper)

```bash
curl -fsSL https://get.muid.io/claude-max | bash
claude-max           # starts proxy if needed, execs `claude`
```

### Programmatic in-process use

```ts
import { ProxyClient, FileCredentialsProvider } from '@life-ai-tools/claude-code-sdk'

const client = new ProxyClient({
  config: { kaIntervalSec: 120 },
  credentialsProvider: new FileCredentialsProvider(),
})

const response = await client.handleRequest(body, headers, {
  sessionId: 'my-session',
  sourcePid: process.pid,
})
```

### opencode plugin

```bash
opencode plugin install @life-ai-tools/opencode-claude
opencode providers login -p claude-max
```

## Migration from 0.10.x (old SDK)

If you directly constructed `ClaudeCodeSDK` — no changes. The facade is
preserved. Internally it now delegates to `ProxyClient` but the public API
is the same.

If you imported from `./session-tracker` inside proxy-package — it's still
there for backward compat but new code should use SDK's `ISessionStore`
and default `InMemorySessionStore`.

## Cache keepalive — where the 9 patches live

All cache safety logic is in `src/keepalive-engine.ts`. One file, one
source of truth. All consumers get the patches via SDK dep bump.

The 9 patches, for reference:
1. JIT PID check before fire (no wasted fires on dead owners)
2. Wake-from-sleep detection (`cacheAge > TTL` → disarm)
3. Aggressive TCP probe (5s → 10s cap) when network blips
4. Post-disarm revive mode (know when network returns)
5. `classifyError()` — network vs transient vs auth vs permanent
6. Safety margin 15s (was 5s) — network latency headroom
7. 10s max probe interval cap (fast recovery)
8. Heartbeat observability (networkState, disarmsLastHour, lastError)
9. Proxy returns 503 Retry-After on upstream network errors

## Where to file bugs

- Cache safety regression → `@life-ai-tools/claude-code-sdk` (engine bug)
- HTTP proxy issues → `@kiberos/claude-max-proxy`
- opencode integration → `@life-ai-tools/opencode-claude`
- Agent coordination (wake events) → `@life-ai-tools/opencode-signal-wire`
- OpenAI-compat server → `@life-ai-tools/opencode-proxy`
