# opencode-claude-toolkit

Use your **Claude Max/Pro subscription** in [opencode](https://github.com/opencode-ai/opencode) — no API key needed.

> **Why this exists?** Read our [Open Letter to Anthropic](OPEN-LETTER.md) about token efficiency, developer freedom, and collaboration.

---

## Three Ways to Use

| Approach | Best for | Install |
|----------|----------|---------|
| **[Plugin](#-plugin-recommended)** | opencode users — native provider, no proxy | `opencode plugin @life-ai-tools/opencode-claude` |
| **[Proxy](#-proxy)** | Cursor, other OpenAI-compatible clients | `bunx @life-ai-tools/opencode-proxy` |
| **[SDK](#-sdk)** | Building your own tools | `npm i @life-ai-tools/claude-code-sdk` |

---

## 🔌 Plugin (Recommended)

Native Vercel AI SDK v3 provider — installs directly into opencode. No proxy, no translation layer. Each opencode instance gets its own isolated provider backed by our `claude-code-sdk` for OAuth, streaming, retry logic, and thinking support.

### Setup

```bash
# 1. Install the plugin
opencode plugin @life-ai-tools/opencode-claude

# 2. Login (opens browser)
opencode providers login -p claude-max

# 3. Done — Claude models appear in opencode's model list
opencode
```

Select **Claude Opus 4.6 (Max)**, **Sonnet 4.6 (Max)**, or **Haiku 4.5 (Max)** from the model picker.

### Features

- **Native AI SDK provider** — implements `LanguageModelV3` directly, no `@ai-sdk/anthropic` dependency
- **Reasoning effort selector** — low/medium/high for Opus and Sonnet 4.6 (controls thinking budget)
- **Streaming with full lifecycle** — text, thinking/reasoning, tool calls with incremental arguments
- **Image/PDF support** — paste images (Ctrl+V), attach files (Ctrl+U); auto-resize to Anthropic's native 1568px
- **Prompt caching** — 1-marker strategy matching Claude Code, with cross-project cache sharing
- **Cache keepalive** — keeps cache warm indefinitely while session is open (zero quota cost)
- **TUI sidebar** — real-time cache hit ratio and estimated savings visible in sidebar (`Ctrl+X B`)
- **`/cache` command** — diagnostics dialog with keepalive stats, API jitter, active sessions
- **Auto token refresh** — credentials managed by `claude-code-sdk` with triple-check pattern
- **Per-project isolation** — each opencode instance runs its own provider, no shared state
- **Compaction hook** — injects cache context into compaction summaries for better continuity

### Configuration

Configure via `opencode.json` provider options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "claude-max": {
      "options": {
        "keepalive": true,
        "keepaliveInterval": 120,
        "keepaliveIdle": 0,
        "debug": false
      }
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keepalive` | `boolean` | `true` | Enable/disable cache keepalive |
| `keepaliveInterval` | `number` | `120` | Keepalive fire interval in seconds |
| `keepaliveIdle` | `number` | `0` (∞) | Stop keepalive after N seconds idle (0 = never) |
| `debug` | `boolean` | `true` | Enable debug logging to `~/.claude/claude-max-debug.log` |
| `customCompaction` | `string` | — | Replace default compaction prompt entirely (see [Compaction](#compaction)) |

**Live-reload config** — edit `~/.claude/keepalive.json` to tune keepalive at runtime without restarting:

```json
{
  "enabled": true,
  "intervalSec": 120,
  "idleTimeoutSec": null,
  "minTokens": 2000
}
```

### Cache & Keepalive

The plugin automatically caches prompt prefixes (system prompt + tools ≈ 30K tokens) and keeps them warm via periodic 1-token API calls. This means:

- **First call** of the day: ~30K tokens written to cache (one-time cost)
- **Every subsequent call**: reads from cache (99%+ hit ratio typical)
- **Cross-project**: all projects share the same tool prefix cache (CWD paths normalized)
- **Cross-session**: restarting a session reuses cache from any alive session
- **Keepalive cost**: ~183 output tokens/day (0.04% of real traffic), zero quota impact

View cache stats in the sidebar (`Ctrl+X B`) or type `/cache` for detailed diagnostics.

### Compaction

When opencode compacts a long conversation into a summary, our plugin injects cache optimization context:

```
## Cache Optimization Notes
- This session uses Anthropic prompt caching with keepalive
- Cache prefix (system + tools ≈30K tokens) is shared across all sessions
- When continuing, reuse exact tool names and file paths to maximize cache hits
- Cache read is 10x cheaper than uncached input
```

This helps the next turn after compaction maintain good cache behavior.

**Full custom compaction prompt:**

You can completely replace opencode's default compaction prompt:

```json
{
  "provider": {
    "claude-max": {
      "options": {
        "customCompaction": "Summarize this conversation focusing on: 1) Current task and progress 2) File paths being worked on 3) Key decisions made. Format as structured handover for the next agent."
      }
    }
  }
}
```

**Compaction model override:**

Use a cheaper/faster model for compaction summaries:

```json
{
  "agents": {
    "compaction": {
      "model": "claude-max/claude-haiku-4-5-20251001",
      "temperature": 0.3
    }
  }
}
```

**Disable auto-compaction** (manage context manually):

```json
{
  "compaction": {
    "auto": false,
    "prune": false
  }
}
```

### Image Support

Paste images with `Ctrl+V` or attach files with `Ctrl+U`. The plugin:

- Auto-resizes to 1568px (Anthropic's native vision resolution) — zero quality loss
- Preserves PNG format for screenshots (sharp text), falls back to JPEG only if PNG exceeds 3.75MB
- Rejects images >5MB with user-friendly message
- Supports JPEG, PNG, GIF, WebP

### Per-Project Credentials

During login, choose where to save credentials:

- **"This project"** → saves to `./.claude/.credentials.json` — isolated to this project
- **"Global"** → saves to `~/.claude/.credentials.json` — shared across projects

### Supported Models

| Model | Name in opencode | Reasoning | Context | Best for |
|-------|-----------------|-----------|---------|----------|
| `claude-opus-4-6` | Claude Opus 4.6 (Max) | ✅ low/med/high | 1M | Complex reasoning, architecture |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Max) | ✅ low/med/high | 1M | Fast coding, daily driver |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 (Max) | — | 200K | Quick tasks, title generation |

---

## 🔀 Proxy

For Cursor, Continue, or any OpenAI-compatible client. Runs a local server that translates between OpenAI format and Claude's API.

### Quick Start

```bash
# Install Bun
curl -fsSL https://bun.sh/install | bash

# Start proxy
bunx @life-ai-tools/opencode-proxy

# In opencode:
LOCAL_ENDPOINT=http://localhost:4040/v1 opencode
```

### Proxy Features

- **Daemon mode** — proxy survives opencode exit, shared by multiple instances
- **Zero-downtime reload** — `POST /admin/reload` drains active streams
- **Multi-account** — per-request credential routing via `X-Account` header
- **Token usage logging** — in/out/cache stats on every request
- **Verbose mode** — `--verbose` dumps raw SSE events

---

## 📦 SDK

For building your own tools on top of Claude Max/Pro.

```bash
npm install @life-ai-tools/claude-code-sdk
```

```typescript
import { ClaudeCodeSDK } from '@life-ai-tools/claude-code-sdk'

const sdk = new ClaudeCodeSDK()

// Streaming
for await (const event of sdk.stream({
  model: 'claude-sonnet-4-6-20250415',
  messages: [{ role: 'user', content: 'Write a haiku about coding' }],
  maxTokens: 1024,
})) {
  if (event.type === 'text_delta') process.stdout.write(event.text)
  if (event.type === 'thinking_delta') process.stdout.write(event.text)
}

// Non-streaming
const response = await sdk.generate({
  model: 'claude-opus-4-6-20250415',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  maxTokens: 256,
  thinking: { type: 'enabled', budgetTokens: 5000 },
})
```

### SDK Features

- **Zero API key** — uses Claude Max/Pro OAuth credentials
- **Streaming** — SSE with text, thinking (with signature), and tool use events
- **Auto-refresh** — token triple-check refresh pattern
- **Retry logic** — exponential backoff for 5xx errors, never retry 429
- **Tool use** — full function calling support
- **Thinking** — extended thinking with signature capture for multi-turn
- **Prompt caching** — automatic cache markers with keepalive
- **Image support** — auto-resize to 1568px native resolution
- **Live config** — `~/.claude/keepalive.json` for runtime tuning

---

## Troubleshooting

### "Not logged in"
```bash
opencode providers login -p claude-max
```

### "Rate limited" / 429
Subscription usage limit reached. Wait for reset window (usually daily). Rate limits are never retried by design.

### "Token expired" / 401
Tokens auto-refresh. If persistent, re-login:
```bash
opencode providers login -p claude-max
```

### Slow cold start
If first response takes 30+ seconds, check MCP servers — disable unused ones:
```bash
opencode mcp disable <server-name>
```

### Debug logging
```bash
# Via config (opencode.json)
{ "provider": { "claude-max": { "options": { "debug": true } } } }

# Via env var
CLAUDE_MAX_DEBUG=1 opencode

# View logs
tail -f ~/.claude/claude-max-debug.log
```

### Cache not working
Check sidebar (`Ctrl+X B`) — should show "Cache" section with hit ratio. If missing:
1. Restart opencode to load TUI plugin
2. Verify `~/.config/opencode/tui.json` has the plugin listed
3. Type `/cache` for detailed diagnostics

---

## Project Structure

```
opencode-claude-toolkit/
├── packages/
│   ├── opencode-claude/          # Plugin + native AI SDK provider
│   │   ├── index.ts              # Plugin server: config, OAuth, compaction hook
│   │   ├── provider.ts           # LanguageModelV3: createClaudeMax()
│   │   └── tui.tsx               # TUI plugin: sidebar cache stats + /cache command
│   └── opencode-proxy/           # OpenAI-compatible proxy server
│       ├── server.ts             # HTTP server with daemon mode
│       └── translate.ts          # OpenAI ↔ Claude format translation
├── dist/                         # Compiled SDK (published to npm)
├── examples/                     # Usage examples
├── CHANGELOG.md                  # Version history
├── OPEN-LETTER.md
└── README.md
```

## npm Packages

| Package | Description |
|---------|-------------|
| [`@life-ai-tools/claude-code-sdk`](https://www.npmjs.com/package/@life-ai-tools/claude-code-sdk) | TypeScript SDK (compiled bundle) |

---

## License

MIT — see [LICENSE](LICENSE)

## Source Access

The SDK is distributed as a compiled bundle. For source access requests, see [REQUEST-SOURCE.md](REQUEST-SOURCE.md).

---

Built by [LifeAITools](https://lifeaitools.com) | [GitHub](https://github.com/LifeAITools)
