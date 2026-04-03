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

Select **Claude Opus 4.6 (Max)**, **Sonnet 4.6 (Max)**, or **Haiku 4.5 (Max)** from the model picker. Costs show as $0 (subscription-included).

### Features

- **Native AI SDK provider** — implements `LanguageModelV3` directly, no `@ai-sdk/anthropic` dependency
- **Reasoning effort selector** — low/medium/high for Opus and Sonnet 4.6 (controls thinking budget)
- **Streaming with full lifecycle** — text, thinking/reasoning, tool calls with incremental arguments
- **Auto token refresh** — credentials managed by `claude-code-sdk` with triple-check pattern
- **Per-project isolation** — each opencode instance runs its own provider, no shared state
- **Zero stderr noise** — debug logging to file only (`CLAUDE_MAX_DEBUG=1` → `~/.claude/claude-max-debug.log`)

### Per-Project Credentials

During login, choose where to save credentials:

- **"This project"** → saves to `./‌.claude/.credentials.json` — isolated to this project
- **"Global"** → saves to `~/.claude/.credentials.json` — shared across projects

Different Anthropic accounts for different projects simultaneously:

```
Project A (personal):  /projects/personal/.claude/.credentials.json
Project B (work):      /projects/work/.claude/.credentials.json
Project C (global):    ~/.claude/.credentials.json
```

### Supported Models

| Model | Name in opencode | Reasoning | Best for |
|-------|-----------------|-----------|----------|
| `claude-opus-4-6` | Claude Opus 4.6 (Max) | ✅ low/medium/high | Complex reasoning, architecture |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 (Max) | ✅ low/medium/high | Fast coding, daily driver |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 (Max) | — | Quick tasks, title generation |

### Architecture

```
opencode ──→ plugin (index.ts) ──→ provider (provider.ts) ──→ claude-code-sdk ──→ Anthropic API
              │                      │
              ├── config: models     ├── createClaudeMax()
              ├── auth: OAuth login  ├── doGenerate() → sdk.generate()
              └── credentials mgmt  └── doStream() → sdk.stream()
                                         ├── text-start/delta/end
                                         ├── reasoning-start/delta/end
                                         ├── tool-input-start/delta/end
                                         └── tool-call + finish
```

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
  if (event.type === 'thinking_end') console.log('[signature captured]')
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
- **Prompt caching** — automatic cache markers

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
CLAUDE_MAX_DEBUG=1 opencode
tail -f ~/.claude/claude-max-debug.log
```

---

## Project Structure

```
opencode-claude-toolkit/
├── packages/
│   ├── opencode-claude/          # Plugin + native AI SDK provider
│   │   ├── index.ts              # Plugin server: config, OAuth, credentials
│   │   └── provider.ts           # LanguageModelV3: createClaudeMax()
│   └── opencode-proxy/           # OpenAI-compatible proxy server
│       ├── server.ts             # HTTP server with daemon mode
│       └── translate.ts          # OpenAI ↔ Claude format translation
├── dist/                         # Compiled SDK (published to npm)
├── examples/                     # Usage examples
├── OPEN-LETTER.md
└── README.md
```

## npm Packages

| Package | Description |
|---------|-------------|
| [`@life-ai-tools/opencode-claude`](https://www.npmjs.com/package/@life-ai-tools/opencode-claude) | opencode plugin + native AI SDK provider |
| [`@life-ai-tools/opencode-proxy`](https://www.npmjs.com/package/@life-ai-tools/opencode-proxy) | OpenAI-compatible proxy server |
| [`@life-ai-tools/claude-code-sdk`](https://www.npmjs.com/package/@life-ai-tools/claude-code-sdk) | TypeScript SDK (compiled bundle) |

---

## License

MIT — see [LICENSE](LICENSE)

## Source Access

The SDK is distributed as a compiled bundle. For source access requests, see [REQUEST-SOURCE.md](REQUEST-SOURCE.md).

---

Built by [LifeAITools](https://lifeaitools.com) | [GitHub](https://github.com/LifeAITools)
