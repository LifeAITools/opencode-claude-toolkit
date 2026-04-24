/**
 * Default adapters for ProxyClient ports.
 *
 * These are the zero-config implementations that ship with SDK so that
 * the most common usage pattern is simply:
 *
 *   const client = new ProxyClient({
 *     config,
 *     credentialsProvider: new FileCredentialsProvider(),
 *   })
 *
 * Each adapter is:
 *   - Small (under 100 lines)
 *   - Single-responsibility (implements ONE port interface)
 *   - Reasonable default (works for 90% of cases out of the box)
 *   - Replaceable (consumers can swap for custom adapters)
 */
import type { ICredentialsProvider, IEventEmitter, ILivenessChecker, ISessionStore, IUpstreamFetcher, ProxyEvent, Session } from './proxy-ports.js';
export interface FileCredentialsProviderOptions {
    /** Path to credentials.json. Default: ~/.claude/.credentials.json */
    path?: string;
    /** Buffer before actual expiry to count as "expired". Default: 5 min */
    expiryBufferMs?: number;
}
export declare class FileCredentialsProvider implements ICredentialsProvider {
    private readonly path;
    private readonly expiryBufferMs;
    private cached;
    private lastMtimeMs;
    constructor(opts?: FileCredentialsProviderOptions);
    getAccessToken(): Promise<string>;
    invalidate(): void;
    private readFromDisk;
    private mtimeChanged;
    private getMtime;
    private isExpired;
}
export interface ConsoleEventEmitterOptions {
    /** Minimum level to emit. Default: 'info' */
    minLevel?: 'error' | 'info' | 'debug';
    /** Format: 'json' (JSONL) or 'human' (colored). Default: 'human' */
    format?: 'json' | 'human';
    /** Custom write target. Default: process.stderr */
    writeTarget?: (line: string) => void;
}
export declare class ConsoleEventEmitter implements IEventEmitter {
    private readonly minRank;
    private readonly format;
    private readonly write;
    constructor(opts?: ConsoleEventEmitterOptions);
    emit(event: ProxyEvent): void;
}
export declare class NullEventEmitter implements IEventEmitter {
    emit(_event: ProxyEvent): void;
}
export declare class InMemorySessionStore<EngineT = unknown> implements ISessionStore<EngineT> {
    private sessions;
    private readonly liveness;
    constructor(liveness?: ILivenessChecker);
    getOrCreate(sessionId: string, ownerPid: number | null, engineFactory: () => EngineT): Session<EngineT>;
    get(sessionId: string): Session<EngineT> | undefined;
    list(): Session<EngineT>[];
    size(): number;
    isOwnerAlive(sessionId: string): boolean;
    reapDead(): string[];
    stopAll(): void;
}
export declare class DefaultLivenessChecker implements ILivenessChecker {
    /**
     * Answers ONLY the question: is this PID currently a running process?
     * Does NOT filter by legitimacy (e.g. "is this a realistic owner PID")
     * — that's ISessionStore's concern.
     *
     * Invalid inputs (0, negative) return false since there's no such PID.
     */
    isAlive(pid: number): boolean;
}
export declare class NativeFetchUpstream implements IUpstreamFetcher {
    fetch(url: string, init: {
        method: 'POST';
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }): Promise<Response>;
}
//# sourceMappingURL=proxy-adapters.d.ts.map