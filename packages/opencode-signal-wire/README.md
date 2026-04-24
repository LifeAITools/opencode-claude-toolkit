# @life-ai-tools/opencode-signal-wire

Agent coordination infrastructure for opencode plugins.

Extracted from `@life-ai-tools/opencode-claude` for single-responsibility —
this package has **no dependency** on claude-code-sdk or claude-max-proxy.

## What's inside

- **SignalWire** — rule-driven hook evaluator (stop/run/wait → hint for next turn)
- **Wake Listener** — cross-process agent coordination (spawn depth, budget, helper tracking)
- **Wake Preferences** — global/per-project subscription config
- **Wake TUI** — terminal UI for wake event inspection

## Install

Typically installed transitively as a dep of `@life-ai-tools/opencode-claude`.
Can also be used standalone by other opencode plugins.

## Architecture

See [/ARCHITECTURE.md](../../ARCHITECTURE.md) at repo root.
