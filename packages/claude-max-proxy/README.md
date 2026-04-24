# @kiberos/claude-max-proxy

HTTP proxy for `claude` CLI — enables Claude Max/Pro subscription.

## One-line install

```bash
curl -fsSL https://get.muid.io/claude-max | bash
```

## Usage

```bash
claude-max              # starts proxy, execs claude
claude-max doctor       # self-check + auto-heal
claude-max status       # proxy state
claude-max watch        # live TUI
claude-max logs -f      # tail logs
```

## How it works

Transparent HTTP proxy that injects OAuth bearer token + keeps prompt
cache warm via autonomous KA fires. Supports global (singleton) and
embedded (per-consumer) runtime modes.

The actual keepalive engine + orchestration lives in
`@life-ai-tools/claude-code-sdk`. This package is the HTTP wrapper.

## Architecture

See [/ARCHITECTURE.md](../../ARCHITECTURE.md) at repo root.
