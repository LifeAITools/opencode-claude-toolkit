/**
 * org-identity.ts — resolve the current Anthropic organization UUID.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * A cached prompt prefix is billed against whichever org owns the OAuth token
 * in force when that prefix is (re-)sent. Replaying a prefix that was cached
 * under org A against org B silently burns org B's quota — a full cold
 * cache-write (~80K–500K tokens) charged to the wrong account, with no signal
 * to the user. The rewrite guard needs a STABLE org identity to detect that
 * cross-org replay and stop it.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY NOT DECODE THE TOKEN
 * ──────────────────────────────────────────────────────────────
 *
 * Anthropic's OAuth access/refresh tokens are OPAQUE secrets
 * (`sk-ant-oat01-…` / `sk-ant-ort01-…`) — a single segment, NOT a JWT. There
 * is no `organization_id` claim to decode out of them. (`token-rotation.ts`'s
 * `extractOrgId` JWT-decode therefore degrades to `null` against real
 * credentials — it is best-effort and "unknown org" is its normal output.)
 *
 * ──────────────────────────────────────────────────────────────
 *  THE STABLE SOURCE
 * ──────────────────────────────────────────────────────────────
 *
 * Claude Code records the authenticated account in `~/.claude.json` →
 * `oauthAccount.organizationUuid`. That field is REFRESH-STABLE: a routine
 * ~8h same-org token refresh does NOT rewrite it — only a `claude login` to a
 * different org does. So comparing it across requests never false-positives
 * on a token refresh; it flips exactly when (and only when) the org actually
 * changes. That is the precise property the guard needs — a false org-switch
 * on every refresh would block the user every 8 hours.
 *
 * Every function here is best-effort and NEVER THROWS — org-awareness is
 * advisory. A read failure yields `null` ("unknown org"), which the guard
 * treats as "cannot prove a switch" and lets the request through.
 */
/** Default location of Claude Code's account record. */
export declare const DEFAULT_ACCOUNT_CONFIG_PATH: string;
/**
 * Read the current org UUID straight from a Claude Code account-config file.
 * Pure (one fs read), never throws. Returns `null` when the file is missing,
 * malformed, or carries no `oauthAccount.organizationUuid` — all of which the
 * caller treats uniformly as "unknown org".
 */
export declare function readOrgIdFromConfig(configPath: string): string | null;
/**
 * Resolves the current org UUID. Implemented as a port so tests can drive
 * org switches directly and production reads the real account file — mirrors
 * the ICredentialsProvider / IUpstreamFetcher dependency-injection style of
 * ProxyClient.
 */
export interface OrgIdResolver {
    /** Current org UUID, or `null` if unknown. Never throws. */
    current(): string | null;
}
/**
 * Default resolver — reads `~/.claude.json` → `oauthAccount.organizationUuid`
 * with a TTL cache so the (133 KB) account file is not parsed on every
 * request. The TTL is SSOT-sourced (`~/.claude/keepalive.json` →
 * `orgIdCacheTtlMs`, default 5 min) and hot-reloaded — nothing hardcoded in
 * the decision path. A 5-min detection window for an org switch is acceptable:
 * `claude login` is a rare, deliberate act, and the cost asymmetry favours a
 * cheap stale read over a per-request file parse.
 */
export declare class FileOrgIdResolver implements OrgIdResolver {
    /** Account-config path. Default: `~/.claude.json`. */
    private readonly configPath;
    /** TTL override in ms. When omitted, read from the keepalive SSOT. */
    private readonly ttlMsOverride?;
    private cache;
    constructor(
    /** Account-config path. Default: `~/.claude.json`. */
    configPath?: string, 
    /** TTL override in ms. When omitted, read from the keepalive SSOT. */
    ttlMsOverride?: number | undefined);
    current(): string | null;
    private ssotTtlMs;
}
//# sourceMappingURL=org-identity.d.ts.map