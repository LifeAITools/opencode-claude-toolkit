/**
 * rewrite-dump.ts — persist a guard-blocked request for offline analysis.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * When the rewrite guard blocks a request it returns a 400 and the request
 * is gone — there is nothing left to inspect. But a block is exactly the
 * moment a human (or another agent) wants to SEE: what was the request, why
 * did the predictor think it would re-cache, and HOW does its cacheable
 * prefix differ from the previous one of the same lineage.
 *
 * On every block we therefore write one self-contained JSON artifact:
 *   - the full blocked request body (the one the proxy believes triggers
 *     the rewrite),
 *   - the previous request's cacheable prefix (system + tools) for that
 *     lineage, when known,
 *   - a computed prefix diff + the predictor's verdict & signals.
 *
 * An analysing agent reads ONE file and has everything. The proxy also
 * "saves the diff itself" — `prefixDiff` is pre-computed so no second pass
 * is needed for the common questions (which tools changed, did system move,
 * or was it purely a TTL/idle event with no content change at all).
 *
 * Every function here is best-effort and NEVER THROWS — a dump failure must
 * not affect the request path (the request is already being rejected; a
 * broken dump must not turn a 400 into a 500).
 */
/** Default location for guard-block dumps. */
export declare const DEFAULT_REWRITE_DUMP_DIR: string;
/** A request's cacheable prefix — system + tools are what define cache identity. */
export interface CachePrefix {
    system: unknown;
    tools: unknown;
}
export interface PrefixDiff {
    /** No previous prefix on record (first request of the lineage). */
    noBaseline: boolean;
    systemChanged: boolean;
    toolsChanged: boolean;
    /** system block-text length, previous vs current. */
    systemLen: {
        prev: number;
        cur: number;
    };
    /** Tool-name set deltas. */
    tools: {
        added: string[];
        removed: string[];
        definitionChanged: string[];
    };
    /** Human summary — the one-line "what differs". */
    summary: string;
}
/**
 * Structured diff of two cacheable prefixes. Pure, never throws. When `prev`
 * is null the request is the lineage's first — `noBaseline` is set and the
 * caller knows the rewrite is an unavoidable cold start, not a divergence.
 */
export declare function diffPrefix(prev: CachePrefix | null, cur: CachePrefix): PrefixDiff;
export interface RewriteBlockDumpInput {
    sessionId: string;
    lineageKey: string;
    rewriteClass: string;
    predictedTokens: number;
    /** Predictor signals that drove the verdict. */
    signals: {
        systemChanged: boolean;
        toolsChanged: boolean;
        orgChanged: boolean;
        idleMs: number | null;
        ttlMs: number;
    };
    /** The full request body the guard rejected. */
    blockedRequest: unknown;
    /** Previous cacheable prefix of this lineage, or null if none on record. */
    previousPrefix: CachePrefix | null;
}
/**
 * Write one guard-block dump artifact. Returns the file path, or null on any
 * failure (logged by the caller). Never throws.
 *
 * Layout — one JSON file per block:
 *   <dir>/<ISO-compact ts>-<sid8>-<rewriteClass>.json
 */
export declare function writeRewriteBlockDump(dir: string, input: RewriteBlockDumpInput): string | null;
//# sourceMappingURL=rewrite-dump.d.ts.map