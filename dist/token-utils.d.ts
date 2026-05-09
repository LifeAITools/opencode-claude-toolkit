/**
 * token-utils.ts — small, pure helpers for credential token handling.
 *
 * Single SSOT for the 8-char token hint convention used across logs and
 * signal-wire events. See PRP token-rotation-deferred-apply DB-09.
 */
/**
 * Extract the first 8 chars after the `sk-ant-oat01-` prefix from an
 * Anthropic OAuth access token. Used in logs and signal-wire event
 * payloads to correlate API_REQ Authorization headers without leaking
 * the full token.
 *
 * Returns empty string for null/undefined/short inputs.
 */
export declare function tokenHint(accessToken: string | null | undefined): string;
//# sourceMappingURL=token-utils.d.ts.map