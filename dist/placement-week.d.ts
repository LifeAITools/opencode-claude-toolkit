export declare const WEEK_MS: number;
export declare const WEEK_TARGET_UTIL = 0.99;
export interface ActivityProfile {
    hourly: readonly number[];
    weekday: readonly number[];
}
export declare const DEFAULT_PROFILE: ActivityProfile;
export declare function activityWeightAt(ms: number, p?: ActivityProfile): number;
export declare function activityMass(fromMs: number, toMs: number, p?: ActivityProfile): number;
export interface WeekForecast {
    forecast: number;
    deficit: number;
    remainingMass: number;
    need: number;
    resetsInHours: number;
}
export declare function forecastWeek(util: number | null, resetAtMs: number | null, nowMs: number, target?: number, p?: ActivityProfile): WeekForecast | null;
