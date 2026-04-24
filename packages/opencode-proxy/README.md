# @life-ai-tools/opencode-proxy

OpenAI-compatible HTTP server backed by Claude Max/Pro.

Use with any OpenAI-compatible client (Cursor, raw curl, OpenAI SDKs).

## Install

```bash
npm install -g @life-ai-tools/opencode-proxy
opencode-proxy                      # start server on :4040
opencode-claude <args>              # convenience: launch opencode through proxy
```

## How it works

Listens on 127.0.0.1:4040 with OpenAI API surface. Translates each
`/v1/chat/completions` request to Anthropic's `/v1/messages` using
`@life-ai-tools/claude-code-sdk` for OAuth + keepalive.

## Architecture

See [/ARCHITECTURE.md](../../ARCHITECTURE.md) at repo root.
