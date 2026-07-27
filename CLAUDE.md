# claude-code-sdk — Project Rules

## 🔴 Model metadata SSOT — `src/models.ts`

- **Every capability gate reads `models.ts`** (`getModelMetadata`,
  `supportsAdaptiveThinking`, `supportsSamplingParams`). Substring model lists
  anywhere else (sdk.ts, proxy, providers) are FORBIDDEN — that exact pattern
  caused the claude-fable-5 drift (live 400s + wrong cost accounting, see
  `PRPs/fable-5-support/evolution.md`).
- **New Anthropic model → follow `docs/adding-a-model.md`** (registry entry +
  openai-translate maps + registry-completeness test + deploy + live-verify).
  Watch the proxy log for `UNKNOWN_MODEL_PASSTHROUGH` — that's the day-1
  signal a model shipped. (It is emitted on the event bus at `info`; the bus has
  no `warn` level, and until 1.0.21 this went to `console.error`, which reaches
  neither log sink — so the day-1 signal could not actually fire.)

## 🔴 Per-org OAuth token freshness

- **Token-use choke-point.** EVERY consumer of a pinned/served-org token — real
  request, KA fire, admin probe, proactive sweep — MUST obtain it through
  `withFreshOrgToken(orgId)` (`src/proxy-client.ts`). Never build an
  `Authorization` header from a bare vault/disk read: that path skips the
  check-and-refresh + force-on-401 invariant and is exactly the KA-path bypass
  that caused the per-org idle token-expiry incident
  (`PRPs/per-org-tokens/evolutions/`). A NEW consumer that constructs a bearer
  from a raw `orgVault.get()` / disk read instead of the choke-point is a red
  flag — route it through `withFreshOrgToken` (or `handleOrg401` for the 401
  backstop), never around it.
- **Reference-impl-first for auth/session/cache-lifetime mechanics.** For any
  OAuth / token-refresh / session-pin / cache-TTL work, consult
  `/home/relishev/projects/vibe/claude-code-source` (the canonical Claude Code
  impl) BEFORE designing, and cite the specific `file:line` in the plan /
  execution log (e.g. `utils/auth.ts:1360 handleOAuth401Error`,
  `services/oauth/client.ts:146 refreshOAuthToken`). The canonical model
  (lazy check-before-every-use + force-on-401 + config-dir `proper-lockfile`)
  is the answer to reach for — adapt it, don't reinvent it.

## Deploy (Rule #15)

- Local proxy deploys ONLY via
  `packages/claude-max-proxy/scripts/deploy-from-source.sh` (manifest-verified).
  Never hand-edit `~/.local/share/claude-max-proxy`.
- Sidecars (eco2, tixi-cold on kiberos.ai): build standalone binary →
  docker image → tag dated rollback on the remote BEFORE `docker load` →
  recreate via `kibctl boot --remote prod --only <bundle>`.
