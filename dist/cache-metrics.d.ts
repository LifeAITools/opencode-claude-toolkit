export interface RecordedRequest {
    kind: "real" | "ka";
    cacheRead: number;
    cacheWrite: number;
    input: number;
    model?: string;
    sysHash?: string;
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
    windowMs?: number;
    reportIntervalMs?: number;
    regressionThreshold?: number;
    regressionPreviousFloor?: number;
    regressionMinSamples?: number;
    onSummary?: (summary: MetricsSummary) => void;
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
    summary(): MetricsSummary;
    private report;
    private prune;
    stop(): void;
    get _samples(): readonly SampleEntry[];
}
export {};
