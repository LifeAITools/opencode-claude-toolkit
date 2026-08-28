export interface RuntimeFlags {
    ledger_dry_run: boolean;
    dump_bodies_full: boolean;
}
export declare function readFlags(): RuntimeFlags;
export declare function isDryRun(): boolean;
export declare function isBodyDumpEnabled(): boolean;
