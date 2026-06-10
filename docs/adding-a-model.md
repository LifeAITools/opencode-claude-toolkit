# Adding a New Anthropic Model — Checklist

> Born from the claude-fable-5 drift (2026-06-10, PRPs/fable-5-support/evolution.md):
> the model shipped, worked only via the passthrough fallback, and was invisible to
> cost/quota accounting and the OpenAI-format surface for days. `claude-mythos-5`
> is already visible in the native CLI binary — it will need this checklist next.

## Detection

You'll know a new model has shipped when the proxy log prints:

```
WARN  UNKNOWN_MODEL_PASSTHROUGH model=claude-XXX
```

(emitted once per unknown model by `resolveModel()` in
`packages/claude-max-proxy/src/openai-translate.ts`).

## Authoritative facts — gather BEFORE editing

1. **claude-api skill** (`/claude-api <model> pricing context thinking`) — pricing
   per Mtok, context window, max output, thinking/sampling support, breaking quirks.
2. **Native CLI binary** (`grep -a '<model-id>' $(readlink -f ~/.local/bin/claude)`)
   — confirms the id ships on the Max subscription.
3. Cache cost convention: `cacheRead = 0.1 × input`, `cacheWrite = 1.25 × input`.

## Edits (in order)

| # | File | What |
|---|------|------|
| 1 | `src/models.ts` | Add the `MAX_MODELS` entry — name, context, defaultOutput, maxOutput, `adaptiveThinking`, `samplingParams`, cost. Add a family substring to the legacy fuzzy branches of `supportsAdaptiveThinking` / `supportsSamplingParams` if the family is new. |
| 2 | `packages/claude-max-proxy/src/openai-translate.ts` | `DIRECT_MODEL_MAP` (id → id), `PROXY_MODEL_MAP` (`claude-vN-<family>` alias), `SUPPORTED_MODELS` (both entries). |
| 3 | — | **Nothing else.** If you find yourself editing a model list anywhere else, that list is violating the SSOT rule — refactor it to read `models.ts` instead. |

## Forbidden

- ❌ Substring model lists outside `src/models.ts` (capability gates MUST call
  `getModelMetadata` / `supportsAdaptiveThinking` / `supportsSamplingParams`).
- ❌ Silently remapping existing GPT aliases (o1/o3/gpt-4) onto the new model —
  that changes cost/quota behavior for downstream consumers. Product decision,
  not a launch-checklist item.

## Verify

```bash
bun test packages/claude-max-proxy/test/fable-registry.test.ts  # registry-completeness
bun test && npx tsc --noEmit                                     # full suite
```

The registry-completeness test fails if any model reachable through the OpenAI
surface has no `MAX_MODELS` entry.

## Ship (Rule #15 — deployed, not just built)

1. Bump version, `npm publish --registry https://npm.muid.io`.
2. Local proxy: `bash packages/claude-max-proxy/scripts/deploy-from-source.sh`
   (backup → sync → manifest → restart → smoke). Verify
   `curl -s localhost:5050/v1/models` lists the model, then a live
   chat-completion probe with `temperature` set (the 400-trap combo).
3. eco2/tixi sidecars: `bun run packages/claude-max-proxy/scripts/build-proxy.ts
   --target=bun-linux-x64` → `docker build -t kiberos/claude-max-proxy:latest
   packages/claude-max-proxy` → tag a dated rollback on the remote FIRST →
   `docker save | gzip | ssh kiberos.ai 'gunzip | docker load'` →
   `kibctl boot --remote prod --only eco2` → probe `/v1/models` inside the
   container.
4. Commit + push.
