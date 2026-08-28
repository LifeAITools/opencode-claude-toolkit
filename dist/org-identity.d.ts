export declare const DEFAULT_ACCOUNT_CONFIG_PATH: string;
export declare function readOrgIdFromConfig(configPath: string): string | null;
export declare function readOrgInfoFromConfig(configPath?: string): {
    orgId: string | null;
    orgName: string | null;
    accountEmail: string | null;
};
export interface OrgIdResolver {
    current(): string | null;
    invalidate(): void;
}
export declare class FileOrgIdResolver implements OrgIdResolver {
    private readonly configPath;
    private readonly ttlMsOverride?;
    private cache;
    constructor(configPath?: string, ttlMsOverride?: number | undefined);
    current(): string | null;
    invalidate(): void;
    private ssotTtlMs;
}
