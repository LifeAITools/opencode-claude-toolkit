/**
 * keepalive-config.ts — SSOT for cache TTL + keepalive parameters.
 *
 * Hot-reloads from `~/.claude/keepalive.json` on every read (mtime-cached).
 * Falls back to safe defaults if file missing or malformed.
 *
 * Why a single file:
 *   The 5m vs 1h cache TTL story is encoded in NINE different places in
 *   keepalive-engine.ts plus three consumer defaults (proxy-client,
 *   claude-max-proxy/config, opencode-claude/provider). Without this SSOT,
 *   bumping TTL means hunting hardcodes across 4 packages.
 *
 * Discovered evidence (2026-04-30):
 *   * Anthropic's `prompt-caching-scope-2026-01-05` beta now honors
 *     `cache_control: { type: 'ephemeral', ttl: '1h' }` on the OAuth
 *     subscription endpoint. Empirically validated: WRITE @ T+0 →
 *     READ @ T+5m30s and T+10m both return cache_read=39220 tokens.
 *   * 56.2% of MESSAGE_START events in claude-max-headers.log report
 *     ephemeral_1h_input_tokens > 0 — the SDK was writing 1h cache all
 *     along, but engine was tearing it down at 5m boundary.
 *
 * Backward-compat:
 *   If keepalive.json is absent or `cacheTtlSec` is unset, defaults to
 *   the legacy 5m TTL so existing deployments keep their proven behavior.
 *   Activate 1h by writing { "cacheTtlSec": 3600, ... } to keepalive.json.
 *   Hot-reload picks it up on the next mtime-check (next request or KA tick).
 */
export interface DumpConfig {
    /** Master switch — disable all body dumps. Default: true. */
    readonly enabled: boolean;
    /** Always dump first N calls of each PID (initial baseline). Default: 3. */
    readonly initialCalls: number;
    /**
     * Tier-1 rolling ring: keep recent body dumps for post-hoc analysis.
     * After ringRetentionMs, oldest dumps are deleted. 0 = disabled.
     * Default: 2*60*60*1000 (2 hours).
     */
    readonly ringRetentionMs: number;
    /**
     * Tier-1 rolling ring: max disk size in MB. If reached, oldest dumps removed.
     * Default: 300 MB. 0 = no cap (only retentionMs matters).
     */
    readonly ringMaxMb: number;
    /**
     * Tier-2 suspicious archive: when a "suspicious" event happens (cold,
     * sysHash drift, tool drift, large cw without proportional cr), preserve
     * THIS dump + the previous N dumps from ring into a separate archive
     * directory that survives ring rotation. Default: 5 (this + 4 previous).
     */
    readonly suspiciousContextSize: number;
    /**
     * Tier-2 archive retention. Default: 24*60*60*1000 (24 hours).
     */
    readonly suspiciousRetentionMs: number;
    /**
     * Tier-2 archive max disk size in MB. Default: 100 MB.
     */
    readonly suspiciousMaxMb: number;
    /**
     * Detect cold-start events: cw > coldCwThreshold AND cr == 0 AND
     * callNum > initialCalls (not the first few). Default: 10000 tokens.
     */
    readonly coldCwThreshold: number;
    /**
     * Tier-3 metadata retention. Default: 7 days. (Was 24h via env;
     * we extend it because metadata is tiny — ~440 B per call.)
     */
    readonly metadataRetentionMs: number;
}
export interface ResolvedKeepaliveConfig {
    /** Cache TTL in milliseconds. Default: 5*60*1000 (legacy). Recommend: 60*60*1000 (1h). */
    readonly cacheTtlMs: number;
    /** Safety margin subtracted from TTL when scheduling fires/retries. Default: 60_000. */
    readonly safetyMarginMs: number;
    /** Keepalive interval — how often KA fires when idle. Default: 1800_000 (30min) when 1h TTL active, else 120_000. */
    readonly intervalMs: number;
    /** Lower clamp for intervalMs. Default: 60_000. */
    readonly intervalClampMin: number;
    /** Upper clamp for intervalMs. Computed: cacheTtlMs - safetyMarginMs - 60_000. */
    readonly intervalClampMax: number;
    /** Retry delays for transient KA failures, in ms. Cumulative budget should fit in (cacheTtlMs - safetyMarginMs). */
    readonly retryDelaysMs: readonly number[];
    /** Idle threshold to emit a rewrite-warning event. Default: 300_000 (5min, unchanged). */
    readonly rewriteWarnIdleMs: number;
    /** Token threshold for rewrite-warning. Default: 50_000 (unchanged). */
    readonly rewriteWarnTokens: number;
    /** Network probe escalating intervals after a network-related disarm. */
    readonly healthProbeIntervalsMs: readonly number[];
    /** TCP probe per-attempt timeout. Default: 3_000. */
    readonly healthProbeTimeoutMs: number;
    /** Whether keepalive is enabled at all. */
    readonly enabled: boolean;
    /** Idle timeout — stop KA if no real request for this long. 0 / Infinity = never stop. */
    readonly idleTimeoutMs: number;
    /** Minimum input tokens for a request to register a snapshot. Default: 2000. */
    readonly minTokens: number;
    /** Block real requests with too-aggressive cache rewrites (rare safety net). Default: false. */
    readonly rewriteBlockEnabled: boolean;
    /** Body-dump policy with rotation. See DumpConfig docs. */
    readonly dump: DumpConfig;
    /** Source of truth — where we read this config from (for diagnostics). */
    readonly _source: 'defaults' | 'file' | 'mixed';
}
/**
 * Recommended values when 1h cache is active.
 *
 * Activate by writing this to ~/.claude/keepalive.json:
 *   { "cacheTtlSec": 3600, "safetyMarginSec": 60, "intervalSec": 1800,
 *     "retryDelaysSec": [2,3,5,10,15,20,30,60,120,300] }
 */
export declare const RECOMMENDED_1H_CONFIG: {
    readonly cacheTtlSec: 3600;
    readonly safetyMarginSec: 60;
    readonly intervalSec: 1800;
    readonly retryDelaysSec: readonly [2, 3, 5, 10, 15, 20, 30, 60, 120, 300];
};
/**
 * Resolve current keepalive config. Hot-reloads from ~/.claude/keepalive.json on every call.
 *
 * Behaviour:
 *   1. If file unchanged since last read → return cached config (cheap).
 *   2. If file missing → return LEGACY_DEFAULTS (5m TTL).
 *   3. If file present → merge with defaults, validate ranges, log warnings on bad values.
 *   4. NEVER throws. Bad config → falls back per-key.
 */
export declare function loadKeepaliveConfig(): ResolvedKeepaliveConfig;
/**
 * Force re-read (for tests or admin ops). Bypasses mtime cache.
 */
export declare function reloadKeepaliveConfig(): ResolvedKeepaliveConfig;
/**
 * Internal resolver — exported only for tests.
 */
export declare function _resolve(raw: Record<string, unknown> | null): ResolvedKeepaliveConfig;
/**
 * Path of the config file (for diagnostics / endpoints).
 */
export declare function getConfigPath(): string;
/**
 * Fast getter for the most relevant value — used in keepalive-engine 12+ places.
 */
export declare function getCacheTtlMs(): number;
export declare function getSafetyMarginMs(): number;
//# sourceMappingURL=keepalive-config.d.ts.map