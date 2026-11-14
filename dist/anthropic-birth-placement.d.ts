import { type PlacementPlan, type PlacementWindow } from "./placement.js";
export interface OauthUsageWindow {
    utilization: number | null;
    resets_at: string | null;
}
export interface OauthUsage {
    five_hour?: OauthUsageWindow | null;
    seven_day?: OauthUsageWindow | null;
}
export interface OrgUsageReading {
    orgId: string;
    windows: PlacementWindow[];
    measuredAt: number;
}
export declare function usageToWindows(u: OauthUsage | null | undefined): PlacementWindow[];
export declare function headerSnapshotToWindows(snap: {
    utilization5h: number | null;
    utilization7d: number | null;
    resetAt: number | null;
    resetAt7d?: number | null;
}): PlacementWindow[];
export interface BirthCandidate {
    orgId: string;
    needsRelogin: boolean;
    tokenAlive: boolean;
}
export interface BirthPlacementInput {
    candidates: BirthCandidate[];
    readings: Map<string, OrgUsageReading>;
    pinsByOrg: Map<string, number>;
    nowMs: number;
    maxReadingAgeMs: number;
    seed: string;
    weights?: Map<string, {
        weight: number;
        mode: string;
        reason: string;
    }>;
}
export interface BirthPlacementResult {
    orgId: string | null;
    plan: PlacementPlan | null;
    skipped: string | null;
    control?: string;
}
export declare function chooseBirthOrg(input: BirthPlacementInput): BirthPlacementResult;
export declare function chooseNonWalledFallback(input: {
    candidates: BirthCandidate[];
    readings: Map<string, OrgUsageReading>;
    activeOrg: string | null;
    nowMs: number;
    seed: string;
}): {
    orgId: string | null;
    reason: string;
};
