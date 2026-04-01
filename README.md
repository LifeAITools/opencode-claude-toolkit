# opencode-claude-toolkit

Use your **Claude Max/Pro subscription** programmatically — no API key needed.

This toolkit provides:
- **`@lifeaitools/claude-code-sdk`** — TypeScript SDK for the Claude Code API (streaming, tool use, conversation management)
- **`@lifeaitools/opencode-proxy`** — OpenAI-compatible proxy server that lets you use Claude Max/Pro in [opencode](https://github.com/opencode-ai/opencode), Cursor, or any OpenAI-compatible client

> **Why this exists?** Read our [Open Letter to Anthropic](OPEN-LETTER.md) about token efficiency, developer freedom, and collaboration.

---

## Prerequisites

Before you start, make sure you have:

1. **Bun** (runtime for the proxy server):
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. **opencode** (or any OpenAI-compatible coding client):
   ```bash
   # Via Go
   go install github.com/opencode-ai/opencode@latest
   # Or via npm
   npm install -g opencode-ai
   ```

3. **Claude Code CLI** (needed once, to authenticate your subscription):
   ```bash
   # Install Claude Code CLI
   npm install -g @anthropic-ai/claude-code
   
   # Log in (this creates ~/.claude/.credentials.json)
   claude
   # Follow the OAuth flow in your browser, then exit Claude CLI
   ```

4. **Verify credentials exist:**
   ```bash
   ls ~/.claude/.credentials.json
   # Should show the file — if not, run `claude` again
   ```

---

## Quick Start — One Liner

```bash
# Start proxy and launch opencode in one go
bunx @lifeaitools/opencode-proxy &
LOCAL_ENDPOINT=http://localhost:4040/v1 opencode
```

Or step by step:

```bash
# Terminal 1: Start the proxy
bunx @lifeaitools/opencode-proxy --port 4040

# Terminal 2: Launch opencode pointing to the proxy
LOCAL_ENDPOINT=http://localhost:4040/v1 opencode
```

That's it. opencode will now use your Claude Max subscription for all requests.

### Supported Models

| Model ID | Maps to | Best for |
|----------|---------|----------|
| `claude-v4.6-sonnet` | Claude Sonnet 4.6 | Fast coding, daily driver |
| `claude-v4.6-opus` | Claude Opus 4.6 | Complex reasoning, architecture |
| `claude-v4.5-haiku` | Claude Haiku 4.5 | Quick tasks, low latency |

---

## opencode Configuration

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

Set the environment variable permanently:

```bash
# Add to your .bashrc / .zshrc
export LOCAL_ENDPOINT=http://localhost:4040/v1
```

---

## SDK Usage

```typescript
import { ClaudeCodeSDK } from '@lifeaitools/claude-code-sdk'

const sdk = new ClaudeCodeSDK()

// Non-streaming
const response = await sdk.generate({
  model: 'claude-sonnet-4-6-20250415',
  messages: [{ role: 'user', content: 'Hello!' }],
  maxTokens: 1024,
})
console.log(response.content)

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
import { Conversation } from '@lifeaitools/claude-code-sdk'

const conv = new Conversation(sdk, { model: 'claude-sonnet-4-6-20250415' })
const reply1 = await conv.send('What is TypeScript?')
const reply2 = await conv.send('How does it compare to JavaScript?')
```

See [`examples/`](examples/) for more usage patterns.

---

## Features

- **Zero API key** — uses your existing Claude Max/Pro OAuth credentials from `~/.claude`
- **Streaming** — real SSE streaming with text, thinking, and tool use events
- **Auto-refresh** — tokens are refreshed automatically when expired
- **Retry logic** — exponential backoff for 5xx errors, proper 429 handling
- **Tool use** — full support for function calling
- **Thinking** — extended thinking / chain-of-thought support
- **Caching** — prompt caching support for cost efficiency
- **Conversation** — stateful multi-turn conversation management
- **OpenAI-compatible** — proxy translates OpenAI format to/from Claude
- **Client disconnect handling** — clean abort propagation from client to API

---

## Troubleshooting

### "No credentials found"
```
Error: No credentials found. Run `claude` first or provide credentials.
```
**Fix:** Run `claude` in your terminal, complete the OAuth login, then try again. The file `~/.claude/.credentials.json` must exist.

### "Rate limited" / 429 errors
```
[proxy] error: Rate limited: ...
```
**Fix:** You've hit your subscription's usage limit. Wait for the reset window (usually resets daily). The proxy never retries 429 errors — this is by design, as subscription rate limits are window-based.

### "Stream idle timeout"
If opencode shows a timeout while waiting for a response (especially with Opus):
- The proxy has a 255-second idle timeout and 600-second request timeout
- Opus can take 30+ seconds for complex reasoning
- If timeouts persist, check your network connection to `api.anthropic.com`

### Proxy won't start
```bash
# Check if port 4040 is already in use
lsof -i :4040

# Use a different port
bunx @lifeaitools/opencode-proxy --port 4041
```

### "Token expired" / 401 errors
The SDK auto-refreshes tokens. If you see persistent 401 errors:
```bash
# Re-authenticate
claude  # log in again
# Restart the proxy
```

---

## How It Works

```
┌─────────────┐    OpenAI format     ┌──────────────────┐    Claude API     ┌──────────────┐
│   opencode   │ ──── SSE stream ──→ │  opencode-proxy   │ ──── SSE ──────→ │  Anthropic    │
│   (client)   │ ←── SSE stream ──── │  (Bun.serve)      │ ←── SSE ──────── │  API          │
└─────────────┘                      └──────────────────┘                   └──────────────┘
                                            │
                                     claude-code-sdk
                                     • OAuth auth + refresh
                                     • Request building
                                     • SSE parsing
                                     • Retry logic
```

The proxy translates between OpenAI's chat completion format and Claude's native API format. Streaming is end-to-end — chunks flow from Anthropic through the proxy to your client with minimal buffering.

---

## Project Structure

```
opencode-claude-toolkit/
├── packages/
│   └── opencode-proxy/         # OpenAI-compatible proxy (open source)
│       ├── server.ts           # HTTP server (Bun.serve)
│       ├── translate.ts        # OpenAI ↔ Claude format translation
│       └── launch.ts           # Auto-launcher
├── dist/                       # Compiled SDK (published to npm)
├── examples/                   # Usage examples
│   ├── basic-chat.ts
│   └── conversation.ts
├── OPEN-LETTER.md              # Our message to Anthropic
├── REQUEST-SOURCE.md           # How to request SDK source access
├── LICENSE                     # MIT
└── README.md
```

---

## License

MIT — see [LICENSE](LICENSE)

## Source Access

The SDK is distributed as a compiled bundle. If you need source access for auditing, contributions, or enterprise use, see [REQUEST-SOURCE.md](REQUEST-SOURCE.md).

## Open Letter

We built this with respect and appreciation for Anthropic's work. Read our [Open Letter to Anthropic](OPEN-LETTER.md) about why this project exists and our invitation to collaborate.

---

Built by [LifeAITools](https://lifeaitools.com) | [GitHub](https://github.com/LifeAITools)
