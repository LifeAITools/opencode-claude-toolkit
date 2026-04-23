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
    name: string;
    /** Input context window (tokens). 1_000_000 for 1M-context betas. */
    context: number;
    /**
     * Default max_tokens to send on the HTTP request for this model.
     * Mirrors native CLI's wa(model).default.
     * This is the "happy path" cap — high enough that most generations
     * complete naturally without truncation.
     */
    defaultOutput: number;
    /**
     * Absolute ceiling this model+subscription will accept.
     * Mirrors native CLI's wa(model).upperLimit.
     * User can bump default up to this via CLAUDE_CODE_MAX_OUTPUT_TOKENS env var.
     */
    maxOutput: number;
    /** Whether this model supports adaptive thinking (SDK sets { type: 'adaptive' }) */
    adaptiveThinking: boolean;
    /** Equivalent API pricing (USD per million tokens) — for savings display on Max subscription */
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
/**
 * Single source of truth for all claude-max models.
 *
 * Keyed by the Anthropic model ID (as sent in the `model` field of the
 * /v1/messages request body). Add new models here as they ship on the
 * Max/Pro subscription.
 */
export declare const MAX_MODELS: Record<string, ModelMetadata>;
/** Fallback for unknown/unlisted models — mirrors native CLI's else-branch in wa() */
export declare const FALLBACK_MODEL: Pick<ModelMetadata, 'defaultOutput' | 'maxOutput' | 'adaptiveThinking'>;
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
export declare function resolveMaxTokens(modelId: string, explicitOverride?: number): number;
/**
 * Lookup model metadata with fuzzy matching.
 * Matches on substring (so 'claude-opus-4-7' lookup matches 'claude-opus-4-7-20251115')
 * falling through to exact-match then prefix-match.
 */
export declare function getModelMetadata(modelId: string): ModelMetadata | undefined;
/**
 * Check whether a model supports adaptive thinking mode.
 * (The SDK sets thinking: { type: 'adaptive' } for these models instead of the
 * older { type: 'enabled', budgetTokens: N } format.)
 */
export declare function supportsAdaptiveThinking(modelId: string): boolean;
//# sourceMappingURL=models.d.ts.map