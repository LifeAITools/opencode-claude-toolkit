/**
 * anthropic-headers — SSOT for Anthropic HTTP header names and API
 * version string.
 *
 * This module is the **SINGLE SOURCE OF TRUTH** for the HTTP header
 * surface used anywhere in this SDK chain (main SDK + sub-packages).
 * Per claude-code-discipline-sdk PRP REQ-12 and architect-review
 * SSOT-02:
 *
 *   - **ZERO** inline `'Content-Type'` / `'Authorization'` /
 *     `'anthropic-version'` / `'anthropic-beta'` / `'application/json'`
 *     / `'2023-06-01'` literals are allowed in any production file.
 *     All consumers MUST import the named constants from this module.
 *
 *   - Test files (`test/*.ts`, `test-*.ts`, `*.test.ts`) are EXEMPT
 *     from this discipline (REQ-12) — they may use literals as fixtures.
 *
 *   - This module lives in the main SDK `src/` rather than under
 *     `packages/opencode-claude/src/` (where `cache-config.ts` lives)
 *     because main SDK files (`sdk.ts`, `auth.ts`, `proxy-client.ts`,
 *     `voice.ts`) cannot reach upward into `packages/` (tsconfig
 *     `rootDir: src`). Sub-packages consume these headers via the
 *     `@life-ai-tools/claude-code-sdk` re-export — same dependency
 *     direction the `MAX_MODELS` SSOT already uses.
 *
 * Pure-constants module: NO IO, NO side effects, NO imports from other
 * source files in this package. Lives at the bottom of the dependency
 * graph.
 *
 * @see PRP claude-code-discipline-sdk REQ-12
 * @see architect-review SSOT-02 (HTTP header consolidation)
 * @see anthropic-endpoints.ts — parallel SSOT for URLs
 * @see packages/opencode-claude/src/cache-config.ts — parallel SSOT pattern
 */
/**
 * Anthropic Messages API version pinned by every request. Sent in the
 * `anthropic-version` header. Bumping this is a breaking-change event —
 * coordinate with provider.ts and the beta-flag inventory.
 */
export declare const ANTHROPIC_API_VERSION = "2023-06-01";
/**
 * Back-compat alias retained because the main SDK previously named this
 * `API_VERSION`. New code should prefer {@link ANTHROPIC_API_VERSION}
 * — the `ANTHROPIC_` prefix avoids name collisions with other versioned
 * APIs we may consume in the future.
 */
export declare const API_VERSION = "2023-06-01";
/**
 * `Content-Type` request/response header. Use the capitalized form for
 * outgoing requests (matches Claude Code CLI behaviour for billing-
 * attribution server-side matching).
 */
export declare const HEADER_CONTENT_TYPE = "Content-Type";
/**
 * `Authorization` request header — always paired with `Bearer <token>`
 * value in this SDK chain (we never use Basic auth).
 */
export declare const HEADER_AUTHORIZATION = "Authorization";
/**
 * `Accept` request header — used for SSE-streaming endpoints which
 * accept both JSON and `text/event-stream`.
 */
export declare const HEADER_ACCEPT = "Accept";
/**
 * `User-Agent` request header — value is always
 * `claude-cli/<CC_COMPAT_VERSION>` for billing attribution.
 */
export declare const HEADER_USER_AGENT = "User-Agent";
/**
 * `anthropic-version` request header — pin to {@link ANTHROPIC_API_VERSION}.
 */
export declare const HEADER_ANTHROPIC_VERSION = "anthropic-version";
/**
 * `anthropic-beta` request header — comma-separated list of beta flag
 * names (oauth-2025-04-20, prompt-caching-scope-2026-01-05, etc.). Each
 * SDK call composes its own beta set; the header NAME is owned here.
 */
export declare const HEADER_ANTHROPIC_BETA = "anthropic-beta";
/**
 * `anthropic-dangerous-direct-browser-access` request header. Required
 * by Anthropic when calling the Messages API from a non-server origin
 * (the Claude Code CLI sets this to `'true'` for its own requests, and
 * we mirror that to look like CC traffic).
 */
export declare const HEADER_ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS = "anthropic-dangerous-direct-browser-access";
/**
 * `x-app` request header — billing attribution tag. Set to `'cli'` for
 * all SDK traffic (matches Claude Code CLI's getAttributionHeader()).
 */
export declare const HEADER_X_APP = "x-app";
/**
 * `X-Claude-Code-Session-Id` request header — opaque session identifier
 * for Anthropic-side session tracking (mirrors CC's sessionId UUID).
 */
export declare const HEADER_X_CLAUDE_CODE_SESSION_ID = "X-Claude-Code-Session-Id";
/**
 * `application/json` — the canonical MIME for both request bodies and
 * non-streaming responses on the Messages API.
 */
export declare const CONTENT_TYPE_JSON = "application/json";
/**
 * `application/json, text/event-stream` — the `Accept` value used by
 * SSE-streaming Messages API calls (matches Claude Code CLI).
 */
export declare const ACCEPT_JSON_SSE = "application/json, text/event-stream";
/**
 * `text/html` — used when serving the OAuth localhost-callback failure
 * page (auth.ts and the opencode-claude server).
 */
export declare const CONTENT_TYPE_TEXT_HTML = "text/html";
/**
 * Grouped frozen view of all header NAMES — convenience handle for
 * callers that want "the header-name set" as a single object (debug,
 * tests, override layers). Individual exports above are still the
 * preferred import shape.
 */
export declare const ANTHROPIC_HEADERS: Readonly<{
    readonly CONTENT_TYPE: "Content-Type";
    readonly AUTHORIZATION: "Authorization";
    readonly ACCEPT: "Accept";
    readonly USER_AGENT: "User-Agent";
    readonly ANTHROPIC_VERSION: "anthropic-version";
    readonly ANTHROPIC_BETA: "anthropic-beta";
    readonly ANTHROPIC_DANGEROUS_DIRECT_BROWSER_ACCESS: "anthropic-dangerous-direct-browser-access";
    readonly X_APP: "x-app";
    readonly X_CLAUDE_CODE_SESSION_ID: "X-Claude-Code-Session-Id";
    readonly API_VERSION: "2023-06-01";
    readonly CONTENT_TYPE_JSON: "application/json";
    readonly ACCEPT_JSON_SSE: "application/json, text/event-stream";
    readonly CONTENT_TYPE_TEXT_HTML: "text/html";
}>;
//# sourceMappingURL=anthropic-headers.d.ts.map