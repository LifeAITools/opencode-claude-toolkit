export declare const DEFAULT_REWRITE_DUMP_DIR: string;
export interface CachePrefix {
    system: unknown;
    tools: unknown;
}
export interface PrefixDiff {
    noBaseline: boolean;
    systemChanged: boolean;
    toolsChanged: boolean;
    systemLen: {
        prev: number;
        cur: number;
    };
    tools: {
        added: string[];
        removed: string[];
        definitionChanged: string[];
    };
    summary: string;
}
export declare function diffPrefix(prev: CachePrefix | null, cur: CachePrefix): PrefixDiff;
export interface RewriteBlockDumpInput {
    sessionId: string;
    lineageKey: string;
    rewriteClass: string;
    predictedTokens: number;
    signals: {
        systemChanged: boolean;
        toolsChanged: boolean;
        orgChanged: boolean;
        idleMs: number | null;
        ttlMs: number;
    };
    blockedRequest: unknown;
    previousPrefix: CachePrefix | null;
    sessionState?: {
        sessionOnRecord: boolean;
        lineageOnRecord: boolean;
        siblingLineages: Array<{
            lineageKey: string;
            lastReqAgeMs: number | null;
        }>;
        historyEntriesTotal: number;
        proxyStartedAt: number | null;
        spansProxyRestart: boolean;
    };
}
export declare function writeRewriteBlockDump(dir: string, input: RewriteBlockDumpInput): string | null;
export declare function sweepRewriteDumps(dir: string, ttlMs: number, maxBytes: number): {
    ttlDeleted: number;
    capDeleted: number;
    kept: number;
};
export declare function startRewriteDumpCleanup(dir?: string): () => void;
