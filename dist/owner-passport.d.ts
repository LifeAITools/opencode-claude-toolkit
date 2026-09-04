export interface OwnerPassport {
    pid: number;
    name: string | null;
    cmd: string | null;
    cwd: string | null;
    ppid: number | null;
    parentName: string | null;
    startedSecAfterBoot: number | null;
}
export declare function scrubSecrets(text: string): string;
export declare function readOwnerPassport(pid: number): OwnerPassport;
