import type { ICredentialsProvider, IEventEmitter, ILivenessChecker, ISessionStore, IUpstreamFetcher, ProxyEvent, Session } from "./proxy-ports.js";
export interface FileCredentialsProviderOptions {
    path?: string;
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
    currentExpiresAt(): number | null;
    currentRefreshToken(): string | null;
    private readFromDisk;
    private mtimeChanged;
    private getMtime;
    private isExpired;
}
export interface ConsoleEventEmitterOptions {
    minLevel?: "error" | "info" | "debug";
    format?: "json" | "human";
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
    isAlive(pid: number): boolean;
}
export declare class NativeFetchUpstream implements IUpstreamFetcher {
    fetch(url: string, init: {
        method: "POST";
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }): Promise<Response>;
}
