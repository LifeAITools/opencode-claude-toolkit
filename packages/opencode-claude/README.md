# @life-ai-tools/opencode-claude

opencode plugin — Claude Max/Pro provider for opencode.

## Install

```bash
opencode plugin install @life-ai-tools/opencode-claude
opencode providers login -p claude-max
```

## What this plugin does

Registers a `claude-max` provider in opencode that routes requests through
Anthropic with OAuth-bearer subscription access — no API key needed.

Uses `@life-ai-tools/claude-code-sdk` for the actual orchestration
(cache keepalive, OAuth refresh, session tracking).

Agent coordination (wake events, spawn depth, helper tracking) is in a
separate package: `@life-ai-tools/opencode-signal-wire`.

## Architecture

See [/ARCHITECTURE.md](../../ARCHITECTURE.md) at repo root.
