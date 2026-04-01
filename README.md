# opencode-claude-toolkit

Use your **Claude Max/Pro subscription** in [opencode](https://github.com/opencode-ai/opencode) — no API key needed.

> **Why this exists?** Read our [Open Letter to Anthropic](OPEN-LETTER.md) about token efficiency, developer freedom, and collaboration.

---

## Three Ways to Use

| Approach | Best for | Install |
|----------|----------|---------|
| **[Plugin](#-plugin-recommended)** | opencode users — native integration, no proxy | `opencode plugin @life-ai-tools/opencode-claude` |
| **[Proxy](#-proxy)** | Cursor, other OpenAI-compatible clients | `bunx @life-ai-tools/opencode-proxy` |
| **[SDK](#-sdk)** | Building your own tools | `npm i @life-ai-tools/claude-code-sdk` |

---

## 🔌 Plugin (Recommended)

The cleanest approach — installs directly into opencode as a native provider. No separate proxy, no configuration files. Each opencode instance manages its own credentials.

### Setup

```bash
# 1. Install the plugin
opencode plugin @life-ai-tools/opencode-claude

# 2. Login (opens browser)
opencode providers login -p claude-max

# 3. Done — Claude models appear in opencode's model list
opencode
```

That's it. Select **Claude Sonnet 4.6 (Max)**, **Opus 4.6 (Max)**, or **Haiku 4.5 (Max)** from the model picker. Costs show as $0 (subscription-included).

### Per-Project Credentials

During login, choose where to save credentials:

- **"This project"** → saves to `./‌.claude/.credentials.json` — isolated to this project
- **"Global"** → saves to `~/.claude/.credentials.json` — shared across projects

This means you can use **different Anthropic accounts for different projects** simultaneously:

```
Project A (personal account):
  /projects/personal/.claude/.credentials.json
  
Project B (work account):
  /projects/work/.claude/.credentials.json
  
Project C (shared/global):
  ~/.claude/.credentials.json
```

Each opencode instance loads credentials from its CWD, holds tokens in isolated closure memory, and refreshes independently. No interference between instances.

### Supported Models

| Model | Name in opencode | Best for |
|-------|-----------------|----------|
| `claude-sonnet-4-6-20250415` | Claude Sonnet 4.6 (Max) | Fast coding, daily driver |
| `claude-opus-4-6-20250415` | Claude Opus 4.6 (Max) | Complex reasoning, architecture |
| `claude-haiku-4-5-20251001` | Claude Haiku 4.5 (Max) | Quick tasks, low latency |

---

## 🔀 Proxy

For Cursor, Continue, or any OpenAI-compatible client. Runs a local server that translates between OpenAI format and Claude's API.

### Prerequisites

```bash
# Install Bun (runtime for the proxy)
curl -fsSL https://bun.sh/install | bash
```

### Quick Start

```bash
# Start proxy (runs as a background daemon)
bunx @life-ai-tools/opencode-proxy

# In opencode:
LOCAL_ENDPOINT=http://localhost:4040/v1 opencode
```

Or use the launcher that starts proxy + opencode together:

```bash
bunx @life-ai-tools/opencode-proxy launch
```

### First-Time Login (no Claude CLI needed)

```bash
# Interactive login — opens browser
curl -X POST http://localhost:4040/admin/login

# Headless/remote — get URL to open manually
curl -X POST http://localhost:4040/admin/login-url
```

### Proxy Features

- **Daemon mode** — proxy survives opencode exit, shared by multiple instances
- **Zero-downtime reload** — `POST /admin/reload` drains active streams, starts new instance
- **Multi-account** — per-request credential routing via `X-Account` header
- **Active stream tracking** — `GET /health` shows `activeStreams`, `pid`, `uptime`
- **Error surfacing** — rate limits, auth errors shown in opencode (not swallowed)
- **Token usage logging** — `in/out/cache_read/cache_write/hit%` on every request
- **Verbose mode** — `--verbose` dumps raw SSE events for debugging

### Proxy Configuration

```bash
# Custom port
bunx @life-ai-tools/opencode-proxy --port 8080

# Verbose logging
PROXY_VERBOSE=1 bunx @life-ai-tools/opencode-proxy

# Log to files
PROXY_LOG_DIR=/tmp/proxy-logs bunx @life-ai-tools/opencode-proxy

# Multiple accounts
bunx @life-ai-tools/opencode-proxy --accounts ~/.config/opencode-proxy/accounts.json
```

Accounts file format:
```json
{
  "work": "/home/user/.claude-work/.credentials.json",
  "personal": "/home/user/.claude/.credentials.json"
}
```

### opencode Configuration

To make opencode always use the proxy, add to your `.opencode.json`:

```json
{
  "provider": {
    "id": "openai",
    "api_key": "not-needed",
    "model": {
      "id": "claude-v4.6-sonnet",
      "name": "Claude Sonnet 4.6",
      "api_model": "claude-v4.6-sonnet",
      "can_reason": true
    }
  }
}
```

Or set the environment variable permanently:

```bash
# Add to your .bashrc / .zshrc
export LOCAL_ENDPOINT=http://localhost:4040/v1
```

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
  if (event.type === 'text_delta') {
    process.stdout.write(event.text)
  }
}

// Multi-turn conversation
import { Conversation } from '@life-ai-tools/claude-code-sdk'

const conv = new Conversation(sdk, { model: 'claude-sonnet-4-6-20250415' })
const reply1 = await conv.send('What is TypeScript?')
const reply2 = await conv.send('How does it compare to JavaScript?')

// OAuth login (no Claude CLI needed)
import { oauthLogin } from '@life-ai-tools/claude-code-sdk'

const creds = await oauthLogin({
  credentialsPath: './my-credentials.json',
})
```

See [`examples/`](examples/) for more usage patterns.

### SDK Features

- **Zero API key** — uses Claude Max/Pro OAuth credentials
- **Streaming** — real SSE streaming with text, thinking, and tool use events
- **Auto-refresh** — tokens refreshed automatically when expired
- **OAuth login** — full PKCE flow, no Claude CLI dependency
- **Retry logic** — exponential backoff for 5xx errors
- **Tool use** — full function calling support
- **Thinking** — extended thinking / chain-of-thought
- **Prompt caching** — automatic cache markers (5-min TTL, server-side)
- **Conversation** — stateful multi-turn management

---

## How It Works

### Plugin (direct)
```
opencode ──→ plugin ──→ Anthropic API
              │
              ├── OAuth token from closure memory
              ├── Auto-refresh on expiry
              └── Per-project credential isolation
```

### Proxy (OpenAI-compatible)
```
┌─────────────┐    OpenAI format     ┌──────────────────┐    Claude API     ┌──────────────┐
│   opencode   │ ──── SSE stream ──→ │  opencode-proxy   │ ──── SSE ──────→ │  Anthropic    │
│   Cursor     │ ←── SSE stream ──── │  (daemon)         │ ←── SSE ──────── │  API          │
│   any client │                     └──────────────────┘                   └──────────────┘
└─────────────┘
```

---

## Troubleshooting

### "Not logged in"
```
Run: opencode providers login -p claude-max
```
Or for proxy: `curl -X POST http://localhost:4040/admin/login`

### "Rate limited" / 429
You've hit your subscription's usage limit. Wait for the reset window (usually daily). Rate limits are never retried — this is by design for subscription-based rate limiting.

### "Token expired" / 401
Tokens auto-refresh. If persistent:
```bash
# Plugin: re-login
opencode providers login -p claude-max

# Proxy: re-login
curl -X POST http://localhost:4040/admin/login
```

### Stream timeout (Opus)
Opus can take 30+ seconds for complex reasoning. The proxy has a 255-second idle timeout and 600-second request timeout. If timeouts persist, check your network to `api.anthropic.com`.

---

## Project Structure

```
opencode-claude-toolkit/
├── packages/
│   ├── opencode-plugin/        # opencode plugin (recommended)
│   │   └── src/index.ts        # OAuth, token management, model config
│   └── opencode-proxy/         # OpenAI-compatible proxy server
│       ├── server.ts           # HTTP server with daemon mode
│       ├── translate.ts        # OpenAI ↔ Claude format translation
│       └── launch.ts           # Auto-launcher
├── dist/                       # Compiled SDK
├── examples/                   # Usage examples
├── OPEN-LETTER.md              # Our message to Anthropic
├── REQUEST-SOURCE.md           # SDK source access requests
├── LICENSE                     # MIT
└── README.md
```

## npm Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@life-ai-tools/opencode-claude`](https://www.npmjs.com/package/@life-ai-tools/opencode-claude) | 0.1.1 | opencode plugin — native Claude Max/Pro |
| [`@life-ai-tools/opencode-proxy`](https://www.npmjs.com/package/@life-ai-tools/opencode-proxy) | 0.3.1 | OpenAI-compatible proxy server |
| [`@life-ai-tools/claude-code-sdk`](https://www.npmjs.com/package/@life-ai-tools/claude-code-sdk) | 0.1.1 | TypeScript SDK |

---

## License

MIT — see [LICENSE](LICENSE)

## Source Access

The SDK is distributed as a compiled bundle. If you need source access for auditing, contributions, or enterprise use, see [REQUEST-SOURCE.md](REQUEST-SOURCE.md).

## Open Letter

We built this with respect and appreciation for Anthropic's work. Read our [Open Letter to Anthropic](OPEN-LETTER.md) about why this project exists and our invitation to collaborate.

---

Built by [LifeAITools](https://lifeaitools.com) | [GitHub](https://github.com/LifeAITools)
