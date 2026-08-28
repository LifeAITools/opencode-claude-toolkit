export declare const DEFAULT_ORG_VAULT_PATH: string;
export interface OrgVaultEntry {
    orgId: string;
    orgName?: string;
    accountEmail?: string;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: number | null;
    capturedAt: number;
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
    private ensureLoaded;
    private persist;
    upsert(entry: OrgVaultEntry): void;
    get(orgId: string): OrgVaultEntry | null;
    resolve(query: string): OrgVaultEntry | null;
    list(): OrgVaultEntry[];
    markVerified(orgId: string, ts?: number): void;
    setPin(sessionId: string, orgId: string): void;
    getPin(sessionId: string): OrgPin | null;
    deletePin(sessionId: string): void;
    pins(): Record<string, OrgPin>;
    touchPin(sessionId: string, now?: number, minStaleMs?: number): void;
    gcPins(retain: (sessionId: string, lastSeenAt: number) => boolean, now?: number): string[];
}
