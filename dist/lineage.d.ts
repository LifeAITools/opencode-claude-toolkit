/**
 * lineage.ts — cache-prefix lineage identification + main-agent detection.
 *
 * ──────────────────────────────────────────────────────────────
 *  WHY THIS EXISTS
 * ──────────────────────────────────────────────────────────────
 *
 * Anthropic caches a PREFIX of (system + tools + messages), keyed by content
 * hash, with a TTL. That cached prefix is the only thing that can "warm" or
 * "die" — it does not know or care whether the client that produced it is an
 * OS process, a thread, a fiber, or a logical agent.
 *
 * Therefore the unit of keepalive tracking must be the cache prefix itself —
 * NOT the process / thread / agent-id. Those are platform-specific HINTS.
 *
 * This is consumer-agnostic by construction:
 *   - Claude Code  — main agent + sub-agent threads share one PID; each has a
 *                    distinct system+tools → distinct lineage automatically.
 *   - opencode     — sub-agents may be separate processes; each still has its
 *                    own conversation → its own lineage.
 *
 * Every function here is PURE and NEVER THROWS — classification is advisory
 * for the KA optimization layer; it must never break request passthrough.
 */
/**
 * Identity of a cache-prefix family: hash(system) ⊕ hash(tool-name-set).
 *
 * Uses tool NAMES (not full definitions) — the name set is the stable
 * discriminator of "which agent family"; a description-only edit does not
 * change identity (it DOES change the real Anthropic cache — that is what
 * `prefixHashes` below is for, used by the miss predictor).
 *
 * Same (system, tool-name-set) → same lineageKey. Never throws.
 */
export declare function lineageKey(body: unknown): string;
export interface PrefixHashes {
    /** Hash of the full system blocks (description changes included). */
    system: string;
    /** Hash of the full tool definitions (descriptions included). */
    tools: string;
    /** Hash of just the sorted tool-name set (cheap change detector). */
    toolNames: string;
    /** Number of tools — quick magnitude signal. */
    toolCount: number;
}
/**
 * Full-content prefix hashes. Unlike `lineageKey`, this hashes complete tool
 * DEFINITIONS — a tool whose description changed (without a name change) still
 * invalidates the Anthropic cache, and the predictor must catch that.
 * Never throws.
 */
export declare function prefixHashes(body: unknown): PrefixHashes;
export type AgentRole = 'main' | 'sub' | 'aux' | 'unknown';
export interface RoleClassification {
    role: AgentRole;
    /** 0..1 — how sure we are. Low confidence → caller applies the safe default. */
    confidence: number;
    /** Which signal(s) drove the decision — for the decision log. */
    basis: string;
}
/**
 * Behavioural / positional hints assembled by the engine (it has the history
 * + the PID-group context that a single request body lacks). All optional —
 * a missing hint is just one absent signal, never an error.
 */
export interface RoleHints {
    /** This lineage has been seen to go idle past TTL and then resume — the
     *  DEFINITIONALLY-correct "is main" signal (sub-agents never resume). */
    resumedAfterIdle?: boolean;
    /** Oldest lineage (earliest firstSeenAt) among those sharing its PID. */
    oldestInGroup?: boolean;
    /** Richest tool set among lineages sharing its PID (relative, not by name). */
    richestToolsInGroup?: boolean;
}
/**
 * Tunable role-detector parameters. Every threshold/weight here is sourced
 * from the SSOT (`~/.claude/keepalive.json` → `roleDetector`) and hot-reloaded
 * by the engine — NOTHING is hardcoded in a decision path. These defaults
 * apply only when the SSOT omits the field.
 */
export interface RoleWeights {
    /** Score ≥ this → `main`; below → `unknown`. */
    mainThreshold: number;
    /** Baseline score for an absent agent-id header. */
    baseline: number;
    /** Added when a sub-agent-spawning tool is present. */
    spawnTool: number;
    /** Added when this lineage has resumed after going idle past TTL. */
    resumedAfterIdle: number;
    /** Added when this lineage is the oldest in its group. */
    oldest: number;
    /** Added when this lineage has the richest tool set in its group. */
    richest: number;
    /** No agent-id + ≤ this many tools → `aux`. */
    auxToolCountMax: number;
    /** Tool names (case-insensitive) treated as sub-agent-spawning tools. */
    spawnToolPatterns: string[];
}
export declare const DEFAULT_ROLE_WEIGHTS: RoleWeights;
/**
 * Classify the agent role of a request. Layered: per-request signals
 * (agent-id header, spawn-tool, tool count) combined with optional
 * behavioural hints. Pure, never throws.
 *
 * Decision summary:
 *   - agent-id header present              → `sub`  (Claude Code marks sub-agents)
 *   - no agent-id + ≤1 tool                → `aux`  (title-gen / quota probe / classifier)
 *   - no agent-id + real tools             → score `main`-ness; below threshold → `unknown`
 *
 * `unknown` is NOT a failure — the engine treats it as an over-KA-safe
 * candidate (cost asymmetry: under-KA is expensive, over-KA is cheap).
 */
export declare function classifyRole(body: unknown, headers: unknown, hints?: RoleHints, weights?: RoleWeights): RoleClassification;
export type RewriteClass = 'expected:cold-start' | 'expected:compact' | 'expected:tools-changed' | 'expected:proxy-restart' | 'avoidable:ttl-expiry' | 'anomalous:stale-ka-snapshot' | 'anomalous:org-switch' | 'unknown';
export interface RewriteContext {
    /** This is the first request observed for the lineage. */
    isFirstRequest?: boolean;
    /** Tool-name set differs from the previous request of this lineage. */
    toolsChanged?: boolean;
    /** ms since this lineage's previous request. */
    idleMs?: number;
    /** Effective cache TTL in ms. */
    ttlMs?: number;
    /** This rewrite was observed on a KA fire (not a real request). */
    isKaFire?: boolean;
    /** The lineage's last cache warm-up (real request OR KA fire) happened
     *  before the current proxy process started — i.e. the cache TTL gap spans
     *  a proxy restart. The keepalive engine could not have kept the cache warm
     *  across a gap in which it did not exist, so such an expiry is NOT
     *  `avoidable` — it is an expected consequence of the restart. */
    spansProxyRestart?: boolean;
    /** This lineage HAD a persisted KA snapshot at the restart, but it was
     *  dropped (cache already too stale to revive). Unlike a restart with no
     *  persisted snapshot at all, the proxy genuinely tried and could not save
     *  the cache — so the rewrite is a real, blockable one the user should
     *  consent to, NOT a free `expected:proxy-restart`. Overrides
     *  `spansProxyRestart`. */
    kaRevivalDropped?: boolean;
    /** The current org-id differs from the org-id under which this lineage's
     *  prefix was last cached. Replaying the prefix would cold-write the full
     *  context against — and bill — the NEW org. The predictor sets this only
     *  when BOTH org-ids are known and differ (an unknown org never trips it). */
    orgChanged?: boolean;
}
export interface RewriteVerdict {
    class: RewriteClass;
    /** true → normal/unavoidable, info-level. false → a problem worth attention. */
    expected: boolean;
}
/**
 * Classify a detected/predicted cache rewrite. Pure, never throws.
 * `expected:*` (including the first cold start) is normal — log at info level.
 * `avoidable:*` / `anomalous:*` are problems — KA / the predictor should act.
 */
export declare function classifyRewrite(ctx: RewriteContext): RewriteVerdict;
//# sourceMappingURL=lineage.d.ts.map