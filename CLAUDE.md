# claude-code-sdk — Project Rules

## 🔴 Model metadata SSOT — `src/models.ts`

- **Every capability gate reads `models.ts`** (`getModelMetadata`,
  `supportsAdaptiveThinking`, `supportsSamplingParams`). Substring model lists
  anywhere else (sdk.ts, proxy, providers) are FORBIDDEN — that exact pattern
  caused the claude-fable-5 drift (live 400s + wrong cost accounting, see
  `PRPs/fable-5-support/evolution.md`).
- **New Anthropic model → follow `docs/adding-a-model.md`** (registry entry +
  openai-translate maps + registry-completeness test + deploy + live-verify).
  Watch the proxy log for `WARN UNKNOWN_MODEL_PASSTHROUGH` — that's the day-1
  signal a model shipped.

## Deploy (Rule #15)

- Local proxy deploys ONLY via
  `packages/claude-max-proxy/scripts/deploy-from-source.sh` (manifest-verified).
  Never hand-edit `~/.local/share/claude-max-proxy`.
- Sidecars (eco2, tixi-cold on kiberos.ai): build standalone binary →
  docker image → tag dated rollback on the remote BEFORE `docker load` →
  recreate via `kibctl boot --remote prod --only <bundle>`.
