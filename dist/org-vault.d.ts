/**
 * org-vault.ts — persisted per-organization credential vault + session→org pins.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * Claude Code keeps exactly ONE OAuth credential on disk
 * (`~/.claude/.credentials.json`). Logging into a different organization
 * OVERWRITES it — the previous org's refresh token is gone, so a session
 * HOLDing its old org (see proxy-client.ts selectSessionToken) dies as soon
 * as the in-memory access token expires (≤8h), and a proxy restart rebinds
 * every session onto whatever org the file currently holds (the 2026-06-08
 * "stand-down gap" incident class).
 *
 * Organizations are SEPARATE accounts: org B's login does not invalidate
 * org A's tokens upstream. So the fix is simply to never lose them: snapshot
 * every credential we see, keyed by the org it belongs to, and refresh each
 * org's token independently via the standard OAuth refresh grant.
 *
 * The vault stores:
 *   - `orgs`  — one credential record per organization UUID;
 *   - `pins`  — session → orgId bindings (ONLY the binding; tokens always
 *               come from `orgs`, so a stale pin can never resurrect a
 *               revoked token on its own).
 *
 * Org identity is verified empirically: Anthropic returns
 * `anthropic-organization-id` on every response, which the proxy feeds back
 * via `markVerified()` — the vault's view of "which org owns this token"
 * is grounded in what the API actually served, not just `~/.claude.json`.
 *
 * File: `~/.claude-local/org-vault.json`, mode 0600, atomic tmp+rename
 * writes. Every method is fail-soft (never throws) — vault problems must
 * degrade to "behave like before the vault existed", never break requests.
 */
/** Default vault location. NOT /tmp — must survive reboots. */
export declare const DEFAULT_ORG_VAULT_PATH: string;
export interface OrgVaultEntry {
    orgId: string;
    orgName?: string;
    /** Account email that captured this credential (claude.json oauthAccount).
     *  First-class resolve() key: personal orgs happen to embed the email in
     *  orgName ("x@y's Organization"), but team/enterprise orgs carry custom
     *  names — email matching must not depend on Anthropic's naming. */
    accountEmail?: string;
    accessToken: string;
    refreshToken: string | null;
    /** epoch ms; null = unknown (treat as alive, upstream 401 is the backstop) */
    expiresAt: number | null;
    /** when this credential was captured from the system file or a refresh */
    capturedAt: number;
    /** last time the API confirmed this org served a request with this token */
    lastVerifiedAt?: number;
}
export interface OrgPin {
    orgId: string;
}
export declare class OrgVault {
    private readonly path;
    private state;
    private loaded;
    constructor(path?: string);
    /** Lazy-load from disk. Fail-soft: a corrupt/missing file yields an empty vault. */
    private ensureLoaded;
    /** Atomic persist (tmp + rename), 0600. Fail-soft. */
    private persist;
    /** Insert/update an org credential record. Newer capture always wins. */
    upsert(entry: OrgVaultEntry): void;
    get(orgId: string): OrgVaultEntry | null;
    /** Fuzzy resolve: exact orgId, then unique prefix, then unique account
     *  email substring, then unique orgName substring. */
    resolve(query: string): OrgVaultEntry | null;
    list(): OrgVaultEntry[];
    /** API confirmed this org served a request — ground-truth verification. */
    markVerified(orgId: string, ts?: number): void;
    setPin(sessionId: string, orgId: string): void;
    getPin(sessionId: string): OrgPin | null;
    deletePin(sessionId: string): void;
    pins(): Record<string, OrgPin>;
}
//# sourceMappingURL=org-vault.d.ts.map