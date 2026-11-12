export interface PlacementWindow {
    name: string;
    util: number | null;
    resetAt: number | null;
}
export interface PlacementOrg {
    name: string;
    windows: PlacementWindow[];
    activeAgents: number;
    blockedReason?: string | null;
    inFlight?: number;
    slotCap?: number;
    recentRates?: Record<string, number> | null;
}
export interface PlacementAssessment {
    name: string;
    score: number;
    scoreBefore: number;
    worstHeadroom: number | null;
    measuredCount: number;
    activeAgents: number;
    inFlight: number;
    slotCap: number | null;
    pressureHours: number;
    binding: Array<{
        window: string;
        ttwHours: number;
        resetsInHours: number;
        usedFraction: number;
        recentRatePerHour?: number;
        avgRatePerHour?: number;
    }>;
    verdict: "place" | "unknown" | "avoid" | "walled";
    reason: string;
}
export interface PlacementPlan {
    org: PlacementAssessment | null;
    ranked: PlacementAssessment[];
    reason: string;
}
export declare const NEAR_WALL_HOURS = 2;
export declare function assessOrg(org: PlacementOrg, nowMs: number): PlacementAssessment;
export declare function planPlacement(orgs: PlacementOrg[], nowMs: number, seed?: string): PlacementPlan;
export declare function placementInputs(quotaOrgs: Array<{
    name: string;
    status?: string | null;
    windows?: Array<{
        window: string;
        util: number | null;
        resetAt: number | null;
    }>;
    util5h?: number | null;
    util7d?: number | null;
    utilMonth?: number | null;
}>, pins: Record<string, {
    org: string;
    at?: number;
}>, opts?: {
    nowMs: number;
    pinTtlMs?: number;
}): PlacementOrg[];
