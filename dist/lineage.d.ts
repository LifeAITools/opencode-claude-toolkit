export declare function lineageKey(body: unknown): string;
export interface PrefixHashes {
    system: string;
    tools: string;
    toolNames: string;
    toolCount: number;
}
export declare function prefixHashes(body: unknown): PrefixHashes;
export type AgentRole = "main" | "sub" | "aux" | "unknown";
export interface RoleClassification {
    role: AgentRole;
    confidence: number;
    basis: string;
}
export interface RoleHints {
    resumedAfterIdle?: boolean;
    oldestInGroup?: boolean;
    richestToolsInGroup?: boolean;
}
export interface RoleWeights {
    mainThreshold: number;
    baseline: number;
    spawnTool: number;
    resumedAfterIdle: number;
    oldest: number;
    richest: number;
    auxToolCountMax: number;
    spawnToolPatterns: string[];
}
export declare const DEFAULT_ROLE_WEIGHTS: RoleWeights;
export declare function classifyRole(body: unknown, headers: unknown, hints?: RoleHints, weights?: RoleWeights): RoleClassification;
export type RewriteClass = "expected:cold-start" | "expected:compact" | "expected:tools-changed" | "expected:system-changed" | "expected:proxy-restart" | "avoidable:ttl-expiry" | "anomalous:stale-ka-snapshot" | "anomalous:org-switch" | "unknown";
export interface RewriteContext {
    isFirstRequest?: boolean;
    toolsChanged?: boolean;
    idleMs?: number;
    ttlMs?: number;
    isKaFire?: boolean;
    spansProxyRestart?: boolean;
    kaRevivalDropped?: boolean;
    orgChanged?: boolean;
    warmSiblingExists?: boolean;
    warmSiblingKind?: "tools" | "system";
}
export interface RewriteVerdict {
    class: RewriteClass;
    expected: boolean;
}
export declare function classifyRewrite(ctx: RewriteContext): RewriteVerdict;
