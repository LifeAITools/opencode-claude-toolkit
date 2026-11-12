export interface PidGains {
    kp: number;
    ki: number;
    kd: number;
    kff: number;
}
export interface PidLimits {
    wMax: number;
    slewPerHour: number;
    integralMax: number;
    brakeMargin: number;
    derivTauHours: number;
}
export interface PidAdaptation {
    enabled: boolean;
    kCalByClass: Record<string, number>;
    kDefault: number;
    forget: number;
    adaptMin: number;
    adaptMax: number;
    minObservations: number;
}
export interface DrainTarget {
    targetUtil: number;
    deadlineMs: number;
}
export interface PidState {
    t0Ms: number | null;
    util0: number | null;
    targetKey: string | null;
    integral: number;
    derivFiltered: number;
    lastUtil: number | null;
    lastMs: number | null;
    lastOutput: number;
    sxy: number;
    sxx: number;
    observations: number;
}
export declare function newPidState(): PidState;
export interface PidInput {
    nowMs: number;
    util: number | null;
    sessionsByClass: Record<string, number>;
    inflowSinceLast: boolean;
    target: DrainTarget;
}
export interface PidOutput {
    weight: number;
    reason: string;
    terms: {
        setpoint: number;
        error: number;
        p: number;
        i: number;
        d: number;
        ff: number;
        adapt: number;
        forecast: number;
    };
    braked: boolean;
}
export declare function expectedLoadPerHour(sessionsByClass: Record<string, number>, adapt: Pick<PidAdaptation, "kCalByClass" | "kDefault">): number;
export declare function sessionClass(provider: string, model: string): string;
export declare function pidStep(state: PidState, input: PidInput, gains: PidGains, limits: PidLimits, adapt: PidAdaptation): PidOutput;
