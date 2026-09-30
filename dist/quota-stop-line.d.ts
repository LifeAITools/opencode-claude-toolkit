export interface KaSpendSample {
    atMs: number;
    read: number;
    write: number;
    output: number;
}
export interface SpendRates {
    readTokensPerPoint: number;
    writeTokensPerPoint: number;
    outputTokensPerPoint: number;
}
export declare class KaSpendMeter {
    private readonly minCoverageMs;
    private readonly samples;
    private readonly firstSeenAt;
    constructor(minCoverageMs?: number);
    record(orgId: string | null | undefined, s: KaSpendSample): void;
    utilPerHour(orgId: string | null | undefined, nowMs: number, rates: SpendRates): number | null;
    private prune;
}
export interface StopLineInput {
    floor: number;
    ceiling: number;
    lagMargin: number;
    resetInMs: number | null;
    kaUtilPerHour: number | null;
}
export interface StopLine {
    line: number;
    basis: "measured" | "floor:unmeasured" | "floor:clamped" | "ceiling:clamped";
    kaNeedToReset: number | null;
}
export declare function quotaStopLine(i: StopLineInput): StopLine;
