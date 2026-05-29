/**
 * models.ts — Single Source of Truth for claude-max model metadata
 *
 * All packages in this SDK chain consume their model metadata from this file:
 *   - src/sdk.ts                              uses resolveMaxTokens() for final HTTP body
 *   - packages/claude-max-provider/src/index.ts  uses resolveMaxTokens() for AI-SDK adapter defaults
 *   - packages/opencode-claude/provider.ts       uses MAX_MODELS + resolveMaxTokens()
 *   - packages/opencode-claude/index.ts          uses MAX_MODELS for provider registration
 *
 * Values chosen to mirror the native @anthropic-ai/claude-code CLI's wa() function
 * (per-model default + upperLimit). See audit at:
 *   ~/.npm-global/lib/node_modules/@anthropic-ai/claude-code/cli.js
 *
 * Rationale for mirroring the native CLI:
 *   1) Prevents the "max_tokens cut-off" retry loop we observed on pid=1660075
 *      (2026-04-11) — 12 consecutive max_tokens failures because we capped output
 *      at 16384 when the model could have emitted 64000.
 *   2) Anthropic's claude-max OAuth endpoint accepts the same max_tokens values as
 *      the regular API.
 *   3) max_tokens is a HARD ceiling (truncation), not a budget. Setting it too low
 *      causes truncated tool-call JSON → retries. Setting it to the model's real
 *      upperLimit is safe — the model stops naturally when done.
 *
 * Environment overrides (checked in order):
 *   1. Explicit user override passed to sdk.generate({ maxTokens })         — wins
 *   2. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var                                — per-process override
 *   3. Per-model default from MAX_MODELS[modelId].default                   — baseline
 */

export interface ModelMetadata {
  /** Display name shown in UI */
  name: string
  /** Input context window (tokens). 1_000_000 for 1M-context betas. */
  context: number
  /**
   * Default max_tokens to send on the HTTP request for this model.
   * Mirrors native CLI's wa(model).default.
   * This is the "happy path" cap — high enough that most generations
   * complete naturally without truncation.
   */
  defaultOutput: number
  /**
   * Absolute ceiling this model+subscription will accept.
   * Mirrors native CLI's wa(model).upperLimit.
   * User can bump default up to this via CLAUDE_CODE_MAX_OUTPUT_TOKENS env var.
   */
  maxOutput: number
  /** Whether this model supports adaptive thinking (SDK sets { type: 'adaptive' }) */
  adaptiveThinking: boolean
  /** Equivalent API pricing (USD per million tokens) — for savings display on Max subscription */
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
}

/**
 * Single source of truth for all claude-max models.
 *
 * Keyed by the Anthropic model ID (as sent in the `model` field of the
 * /v1/messages request body). Add new models here as they ship on the
 * Max/Pro subscription.
 */
export const MAX_MODELS: Record<string, ModelMetadata> = {
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    context: 1_000_000,
    defaultOutput: 64_000,   // native CLI wa() default (mirrors 4.7 flagship)
    maxOutput: 128_000,      // native CLI wa() upperLimit
    adaptiveThinking: true,
    cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 },
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    context: 1_000_000,
    defaultOutput: 64_000,   // native CLI wa() default
    maxOutput: 128_000,      // native CLI wa() upperLimit
    adaptiveThinking: true,
    cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 },
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    context: 1_000_000,
    defaultOutput: 64_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    cost: { input: 15, output: 75, cacheRead: 1.875, cacheWrite: 18.75 },
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    context: 1_000_000,
    defaultOutput: 32_000,
    maxOutput: 128_000,
    adaptiveThinking: true,
    cost: { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  },
  'claude-haiku-4-5-20251001': {
    name: 'Claude Haiku 4.5',
    context: 200_000,
    defaultOutput: 32_000,
    maxOutput: 64_000,
    adaptiveThinking: false,
    cost: { input: 0.80, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  },
}

/** Fallback for unknown/unlisted models — mirrors native CLI's else-branch in wa() */
export const FALLBACK_MODEL: Pick<ModelMetadata, 'defaultOutput' | 'maxOutput' | 'adaptiveThinking'> = {
  defaultOutput: 32_000,
  maxOutput: 128_000,
  adaptiveThinking: false,
}

/**
 * Resolve max_tokens for the final HTTP request body.
 *
 * Priority order:
 *   1. explicitOverride (user passed sdkOpts.maxTokens / maxOutputTokens)
 *   2. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (clamped to model.maxOutput)
 *   3. Per-model default (MAX_MODELS[modelId].defaultOutput)
 *   4. Global fallback (FALLBACK_MODEL.defaultOutput = 32000)
 *
 * @param modelId  Anthropic model id (e.g. "claude-opus-4-7")
 * @param explicitOverride  User-provided override (from generate/stream options)
 * @returns number of tokens to send as `max_tokens` in the HTTP request body
 */
export function resolveMaxTokens(modelId: string, explicitOverride?: number): number {
  if (typeof explicitOverride === 'number' && explicitOverride > 0) {
    return explicitOverride
  }

  const meta = getModelMetadata(modelId)
  const maxAllowed = meta?.maxOutput ?? FALLBACK_MODEL.maxOutput
  const defaultVal = meta?.defaultOutput ?? FALLBACK_MODEL.defaultOutput

  const envRaw = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  if (envRaw) {
    const parsed = parseInt(envRaw, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      // Clamp to model's documented maxOutput to avoid 400 "max_tokens exceeds
      // model max" errors from Anthropic.
      return Math.min(parsed, maxAllowed)
    }
  }

  return defaultVal
}

/**
 * Lookup model metadata with fuzzy matching.
 * Matches on substring (so 'claude-opus-4-7' lookup matches 'claude-opus-4-7-20251115')
 * falling through to exact-match then prefix-match.
 */
export function getModelMetadata(modelId: string): ModelMetadata | undefined {
  if (MAX_MODELS[modelId]) return MAX_MODELS[modelId]
  const lower = modelId.toLowerCase()
  for (const [id, meta] of Object.entries(MAX_MODELS)) {
    if (lower.includes(id) || id.includes(lower)) return meta
  }
  // Substring match on model family (opus-4-7, sonnet-4-6, etc.)
  for (const [id, meta] of Object.entries(MAX_MODELS)) {
    const family = id.replace(/^claude-/, '').split('-').slice(0, 3).join('-')
    if (lower.includes(family)) return meta
  }
  return undefined
}

/**
 * Check whether a model supports adaptive thinking mode.
 * (The SDK sets thinking: { type: 'adaptive' } for these models instead of the
 * older { type: 'enabled', budgetTokens: N } format.)
 */
export function supportsAdaptiveThinking(modelId: string): boolean {
  const meta = getModelMetadata(modelId)
  if (meta) return meta.adaptiveThinking
  // Legacy fuzzy checks for models not in the table (e.g. preview variants)
  const lower = modelId.toLowerCase()
  return (
    lower.includes('opus-4-8') ||
    lower.includes('opus-4-7') ||
    lower.includes('opus-4-6') ||
    lower.includes('sonnet-4-6') ||
    lower.includes('sonnet-4-7')
  )
}
