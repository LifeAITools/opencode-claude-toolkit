import { type PidGains, type PidLimits, type PidAdaptation, type PidOutput } from "./placement-pid.js";
import type { PlacementWindow } from "./placement.js";
export interface DrainEntry {
    org: string;
    targetUtil: number;
    deadlineMs: number;
}
export interface PlacementControlConfig {
    enabled: boolean;
    balanceTargetUtil: number;
    drain: DrainEntry[];
    gains: PidGains;
    limits: PidLimits;
    adapt: PidAdaptation;
}
export declare const CALIBRATED: Omit<PlacementControlConfig, "enabled" | "drain">;
export declare const DEFAULT_PLACEMENT_CONFIG_PATH: string;
export declare function parsePlacementControl(raw: any): PlacementControlConfig;
export declare function loadPlacementControl(path?: string): PlacementControlConfig;
export declare class PlacementController {
    private readonly states;
    private lastStepAt;
    weight(cfg: PlacementControlConfig, orgId: string, windows: PlacementWindow[], sessionsByClass: Record<string, number>, nowMs: number, inflow: boolean): (PidOutput & {
        mode: "drain" | "balance";
    }) | null;
}
