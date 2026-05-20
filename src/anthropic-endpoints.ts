/**
 * anthropic-endpoints — SSOT for Anthropic API endpoint URLs.
 *
 * This module is the **SINGLE SOURCE OF TRUTH** for every Anthropic-side
 * URL used anywhere in this SDK chain (main SDK + sub-packages). Per
 * claude-code-discipline-sdk PRP REQ-12 and architect-review SSOT-01:
 *
 *   - **ZERO** inline `'https://api.anthropic.com'` / `'https://platform.claude.com/...'`
 *     literals are allowed in any production file. All consumers MUST
 *     import the named constants from this module.
 *
 *   - Test files (`test/*.ts`, `test-*.ts`, `*.test.ts`) are EXEMPT from
 *     this discipline (REQ-12) — they may use literals as fixtures.
 *
 *   - This module lives in the main SDK `src/` rather than under
 *     `packages/opencode-claude/src/` (where `cache-config.ts` lives)
 *     because main SDK files (`sdk.ts`, `auth.ts`, `proxy-client.ts`,
 *     `voice.ts`) cannot reach upward into `packages/` (tsconfig
 *     `rootDir: src`). Sub-packages consume these endpoints via the
 *     `@life-ai-tools/claude-code-sdk` re-export — same dependency
 *     direction the `MAX_MODELS` SSOT already uses.
 *
 * Pure-constants module: NO IO, NO side effects, NO imports from other
 * source files in this package. Lives at the bottom of the dependency
 * graph.
 *
 * @see PRP claude-code-discipline-sdk REQ-12
 * @see architect-review SSOT-01 (endpoint URL consolidation)
 * @see packages/opencode-claude/src/cache-config.ts — parallel SSOT pattern
 */

/**
 * Anthropic REST API hostname — no scheme, no path. Used by raw-TCP
 * health probes in `keepalive-engine.ts` (which use `net.connect` on
 * port 443, where scheme is implicit). Other consumers should prefer
 * {@link ANTHROPIC_API_BASE} (which is `https://${ANTHROPIC_API_HOST}`).
 */
export const ANTHROPIC_API_HOST = "api.anthropic.com";

/**
 * Anthropic REST API base — host + scheme. Used for `/v1/messages`,
 * `/v1/messages/count_tokens`, and the voice WebSocket upgrade
 * (wss://api.anthropic.com/...).
 */
export const ANTHROPIC_API_BASE = `https://${ANTHROPIC_API_HOST}`;

/**
 * Full URL for the streaming-capable `/v1/messages` endpoint. Callers
 * append `?beta=true` (or other query strings) themselves to keep the
 * SSOT free of request-shape concerns.
 */
export const ANTHROPIC_API_MESSAGES = `${ANTHROPIC_API_BASE}/v1/messages`;

/**
 * Full URL for the `/v1/messages/count_tokens` endpoint. Used by
 * benchmark / quota-saving callers that want token counts without
 * triggering a billable generation.
 */
export const ANTHROPIC_API_MESSAGES_COUNT_TOKENS = `${ANTHROPIC_API_BASE}/v1/messages/count_tokens`;

/**
 * Anthropic platform/console base — used as the host portion of OAuth
 * console URLs (authorize, token exchange, callback). Kept separate
 * from {@link ANTHROPIC_API_BASE} because the OAuth surface lives on a
 * different origin than the inference API.
 */
export const ANTHROPIC_PLATFORM_BASE = "https://platform.claude.com";

/**
 * OAuth 2.0 token endpoint — POST target for both authorization-code
 * exchange and refresh-token rotation. Mirrors the URL hardcoded in
 * Claude Code CLI's `src/constants/oauth.ts:84` and `oauth/client.ts:146`.
 */
export const ANTHROPIC_OAUTH_TOKEN_URL = `${ANTHROPIC_PLATFORM_BASE}/v1/oauth/token`;

/**
 * OAuth 2.0 authorize endpoint on the Claude.ai consumer flow (personal
 * Pro/Max accounts). Preferred over the console authorize URL for
 * subscription users — better UX, no org gating. Matches Claude Code
 * CLI's CLAUDE_AI_OAUTH_HOST.
 */
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";

/**
 * OAuth 2.0 authorize endpoint on the console (enterprise / API key
 * flow). Used as fallback when `loginWithClaudeAi=false`.
 */
export const ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL = `${ANTHROPIC_PLATFORM_BASE}/oauth/authorize`;

/**
 * Manual-redirect target shown when the user can't run a localhost
 * callback server (e.g. SSH session). The code is rendered on this page
 * for copy-paste back to the CLI.
 */
export const ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI = `${ANTHROPIC_PLATFORM_BASE}/oauth/code/callback`;

/**
 * Grouped frozen view of all endpoints — convenience handle for callers
 * that want to pass "the endpoint set" as a single object (e.g. for
 * config inspection, debug logging, or building override layers in
 * tests). Individual exports above are still the preferred import shape.
 */
export const ANTHROPIC_ENDPOINTS = Object.freeze({
  API_HOST: ANTHROPIC_API_HOST,
  API_BASE: ANTHROPIC_API_BASE,
  API_MESSAGES: ANTHROPIC_API_MESSAGES,
  API_MESSAGES_COUNT_TOKENS: ANTHROPIC_API_MESSAGES_COUNT_TOKENS,
  PLATFORM_BASE: ANTHROPIC_PLATFORM_BASE,
  OAUTH_TOKEN_URL: ANTHROPIC_OAUTH_TOKEN_URL,
  OAUTH_AUTHORIZE_URL: ANTHROPIC_OAUTH_AUTHORIZE_URL,
  OAUTH_CONSOLE_AUTHORIZE_URL: ANTHROPIC_OAUTH_CONSOLE_AUTHORIZE_URL,
  OAUTH_MANUAL_REDIRECT_URI: ANTHROPIC_OAUTH_MANUAL_REDIRECT_URI,
} as const);
