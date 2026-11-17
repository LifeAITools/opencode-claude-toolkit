import { type PidGains, type PidLimits, type PidAdaptation, type PidOutput } from "./placement-pid.js";
import type { PlacementWindow } from "./placement.js";
import { type ModelAllowlist } from "./org-model-allowlist.js";
export interface DrainEntry {
    org: string;
    targetUtil: number;
    deadlineMs: number;
}
export type ModelGuardScope = "all" | "new";
export interface PlacementControlConfig {
    enabled: boolean;
    brakeMode: "hard" | "soft";
    modelGuardScope: ModelGuardScope;
    balanceTargetUtil: number;
    weekBrakeUtil: number;
    drain: DrainEntry[];
    gains: PidGains;
    limits: PidLimits;
    adapt: PidAdaptation;
}
export declare const CALIBRATED: Omit<PlacementControlConfig, "enabled" | "drain">;
export declare function activeLoadByOrg(pins: Iterable<[
    string,
    {
        orgId?: string | null;
    }
]>, lastTurnAt: ReadonlyMap<string, number>, classOf: (sessionId: string) => string, nowMs: number, windowMs: number): Map<string, Record<string, number>>;
export declare const DEFAULT_PLACEMENT_CONFIG_PATH: string;
export declare function parsePlacementControl(raw: any): PlacementControlConfig;
export declare function loadModelAllowlist(path?: string): ModelAllowlist;
export declare function loadPlacementControl(path?: string): PlacementControlConfig;
export declare class PlacementController {
    private readonly states;
    private lastStepAt;
    private lastOut;
    snapshot(cfg: PlacementControlConfig): Array<Record<string, unknown>>;
    weight(cfg: PlacementControlConfig, orgId: string, windows: PlacementWindow[], sessionsByClass: Record<string, number>, nowMs: number, inflow: boolean): (PidOutput & {
        mode: "drain" | "balance";
    }) | null;
}
