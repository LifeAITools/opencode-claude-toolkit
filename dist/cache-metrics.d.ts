/**
 * cache-metrics.ts — rolling-window cache metrics + regression detector.
 *
 * Subscribes to KA event bus (real requests + KA fires) and aggregates:
 *   - hit_rate (cache_read > 0 / total)
 *   - avg_cache_read, avg_cache_write, avg_input
 *   - cold_start_count (callNum=1 with cache_read=0)
 *   - tool_drift_count (delegated to logger that emits TOOL_DRIFT separately)
 *   - distinct_sysHash_count per PID (max in window)
 *
 * Emits CACHE_METRICS_SUMMARY every reportIntervalMs (default 60s).
 *
 * Regression detector: if hit_rate falls below regressionThreshold AND the
 * previous window was healthy, emits CACHE_REGRESSION_DETECTED. This catches
 * silent Anthropic-side changes (e.g. if 1h cache stops being honored).
 *
 * Usage (in proxy-client or opencode-claude):
 *   import { CacheMetricsCollector } from '@life-ai-tools/claude-code-sdk'
 *   const metrics = new CacheMetricsCollector({
 *     onSummary: (summary) => events.emit({ kind: 'CACHE_METRICS_SUMMARY', ...summary }),
 *     onRegression: (info) => events.emit({ kind: 'CACHE_REGRESSION_DETECTED', ...info }),
 *   })
 *   metrics.recordRequest({ kind: 'real', cacheRead, cacheWrite, input, model, sysHash })
 *   metrics.recordRequest({ kind: 'ka', cacheRead, cacheWrite, input, model })
 *   // on shutdown:
 *   metrics.stop()
 */
export interface RecordedRequest {
    kind: 'real' | 'ka';
    cacheRead: number;
    cacheWrite: number;
    input: number;
    model?: string;
    /** Unique hash of system prompt (per-PID stability indicator). Optional. */
    sysHash?: string;
    /** Whether this is the first request of a process. Used for cold-start detection. */
    firstCall?: boolean;
}
export interface MetricsSummary {
    windowMs: number;
    windowEndsAt: string;
    total: number;
    hitRate: number;
    coldStartCount: number;
    realCount: number;
    kaCount: number;
    avgCacheRead: number;
    avgCacheWrite: number;
    avgInput: number;
    maxCacheRead: number;
    distinctSysHash: number;
    /** Total tokens "saved" via cache reads vs cold cost. */
    estimatedSavedTokens: number;
}
export interface RegressionInfo {
    detectedAt: string;
    windowMs: number;
    currentHitRate: number;
    previousHitRate: number;
    drop: number;
    reason: string;
}
export interface CacheMetricsOptions {
    /** Window size for the rolling summary. Default: 60_000 (1 min). */
    windowMs?: number;
    /** How often to emit a summary. Default: equal to windowMs. */
    reportIntervalMs?: number;
    /** Hit-rate below which we trigger a regression (if previous was healthy). Default: 0.7. */
    regressionThreshold?: number;
    /** "Healthy" hit-rate floor for the previous window. Default: 0.85. */
    regressionPreviousFloor?: number;
    /** Minimum samples in the window before regression check makes sense. Default: 50. */
    regressionMinSamples?: number;
    /** Called every reportIntervalMs with rolling stats. */
    onSummary?: (summary: MetricsSummary) => void;
    /** Called when regression detected. */
    onRegression?: (info: RegressionInfo) => void;
}
interface SampleEntry extends RecordedRequest {
    ts: number;
}
export declare class CacheMetricsCollector {
    private samples;
    private timer;
    private previousHitRate;
    private previousSampleCount;
    private readonly windowMs;
    private readonly reportIntervalMs;
    private readonly regressionThreshold;
    private readonly regressionPreviousFloor;
    private readonly regressionMinSamples;
    private readonly onSummary?;
    private readonly onRegression?;
    constructor(opts?: CacheMetricsOptions);
    recordRequest(req: RecordedRequest): void;
    /**
     * Summarize current rolling window. Public so consumers (e.g. /stats endpoint)
     * can pull on demand.
     */
    summary(): MetricsSummary;
    private report;
    private prune;
    stop(): void;
    /** @internal */
    get _samples(): readonly SampleEntry[];
}
export {};
//# sourceMappingURL=cache-metrics.d.ts.map