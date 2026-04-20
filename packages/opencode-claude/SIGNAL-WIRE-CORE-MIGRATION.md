# Signal-Wire Core Adapter — Migration Guide

## Status

**Shipped 2026-04-20 — opt-in. Not yet production-default.**

The local `signal-wire.ts` (1151 LOC) remains the production path. A new
`signal-wire-core-adapter.ts` (193 LOC) provides the same public API
backed by the canonical `@kiberos/signal-wire-core` engine.

## What this gives you

- **Drop-in replacement:** `new SignalWire({serverUrl, sessionId, rulesPath, platform})` works identically
- **Same legacy API surface:** `evaluate(ctx)`, `trackTokens(u)`, `toggleRule(id, enabled)`, `listRules()`, `isRuleEnabled(id)`, `setSdkClient(c)`, `getContextPosition()`, `evaluateExternal(wakeEvent)`, `evaluateAsync(ctx)`
- **Automatic legacy rule translation:** rules.json with Python-style grammar (`action: {hint/bash}`, `events: [UserPromptSubmit]`) → canonical grammar on load
- **Platform filtering preserved:** `platforms: ['opencode']` filter still applied
- **Zero duplication:** one engine, shared with wake-router, Claude Code hooks (future), Telegram bot
- **Spec-conformant:** 150/150 golden vectors pass; behavior is tested

## How to try it

### Side-by-side test (recommended first)

```bash
cd packages/opencode-claude
bun test signal-wire-adapter.test.ts    # 12 adapter tests pass
bun test signal-wire-parity.test.ts     # 6 behavior-parity tests pass
```

### Switch provider.ts (when ready)

Change **one line** in `provider.ts`:

```ts
// BEFORE:
import { SignalWire } from './signal-wire.ts'

// AFTER:
import { SignalWire } from './signal-wire-core-adapter.ts'
```

No other code changes needed — public API is identical.

### Gradual cutover via environment flag (future)

Once `provider.ts` has been committed clean, wire a feature flag:

```ts
const SignalWireImpl = process.env.SIGNAL_WIRE_ENGINE === 'core'
  ? CoreAdapter
  : LegacySignalWire
```

## What stays in this package after migration

**Not touched by this migration:**
- `provider.ts` — OAuth, Claude SDK, provider registration (core unchanged)
- `wake-listener.ts` — L4 wake event listener (platform-specific, stays)
- `wake-preferences.ts`, `wake-types.ts` — platform contract types
- `index.ts` — plugin entry with wake-listener lifecycle
- `tui.tsx` — UI

**Deprecated (kept for reference, not used after cutover):**
- `signal-wire.ts` — 1151 LOC full engine → replaced by adapter
- `signal-wire-actions.ts` — 312 LOC action dispatch → in Core emitters
- `signal-wire-audit.ts` — 114 LOC audit log → in Core AuditEmitter

## Rules file — do I need to migrate?

**No.** The adapter translates legacy rule format on load:
- `events: [UserPromptSubmit, PostToolUse, Stop, PreToolUse, ExternalEvent]` → canonical
- `action: {hint: "..."}` → `actions: [{type: "hint", text: "..."}]`
- `action: {bash: "..."}` → `actions: [{type: "exec", command: "..."}]`
- `action: {exec: "...", timeout: 15}` → `actions: [{type: "exec", command: "..."}]`
- `cooldown_minutes: 5` → `cooldown_seconds: 300`
- `platforms: ['opencode']` filter preserved

21 production rules tested (17 applicable to opencode platform, 4 filtered as claude-code-only).

## Rollback

If any issue is observed after cutover:
1. Revert the one-line import change in provider.ts
2. Re-build — legacy engine is restored instantly

Legacy files (`signal-wire.ts`, `signal-wire-actions.ts`, `signal-wire-audit.ts`) are NOT deleted — they remain as fallback.

## After validation

Once 7+ days pass in production with no divergence:
1. Delete `signal-wire.ts`, `signal-wire-actions.ts`, `signal-wire-audit.ts`
2. Delete `signal-wire-parity.test.ts` (no longer needed)
3. Rename `signal-wire-core-adapter.ts` → `signal-wire.ts`
4. Rename `signal-wire-translate.ts` → keep as-is (shared helpers)
5. Bump `@life-ai-tools/opencode-claude@1.0.0` (breaking internal, same public API)

## References

- Canonical engine: `/home/relishev/packages/signal-wire-core/` + SPEC.md + 150 vectors
- Audit report: `/home/relishev/projects/vibe/kiberos-platform/PRPs/signal-wire-architecture-v3/AUDIT-FULL.md`
- Adapter contract: ADR-0007 (≤200 LOC pure translation)
