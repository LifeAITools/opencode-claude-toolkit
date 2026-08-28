export interface ICredentialsProvider {
    getAccessToken(): Promise<string>;
    invalidate(): void;
    currentExpiresAt?(): number | null;
    currentRefreshToken?(): string | null;
}
export interface ProxyEvent {
    ts?: string;
    level: "error" | "info" | "debug";
    kind: string;
    msg?: string;
    [key: string]: unknown;
}
export interface IEventEmitter {
    emit(event: ProxyEvent): void;
}
export interface Session<EngineT = unknown> {
    sessionId: string;
    pid: number | null;
    firstSeenAt: number;
    lastRequestAt: number;
    engine: EngineT;
    model: string | null;
    lastUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
        cacheCreation5mInputTokens?: number;
        cacheCreation1hInputTokens?: number;
        cacheDeletedInputTokens?: number;
    } | null;
    rewriteBlockStreak?: {
        count: number;
        lastAt: number;
        lastClass: string;
    } | null;
}
export interface ISessionStore<EngineT = unknown> {
    getOrCreate(sessionId: string, ownerPid: number | null, engineFactory: () => EngineT): Session<EngineT>;
    get(sessionId: string): Session<EngineT> | undefined;
    list(): Session<EngineT>[];
    size(): number;
    isOwnerAlive(sessionId: string): boolean;
    reapDead(): string[];
    stopAll(): void;
}
export interface IUpstreamFetcher {
    fetch(url: string, init: {
        method: "POST";
        headers: Record<string, string>;
        body: string;
        signal?: AbortSignal;
    }): Promise<Response>;
}
export interface ILivenessChecker {
    isAlive(pid: number): boolean;
}
export interface ProxyClientAdapters {
    credentialsProvider: ICredentialsProvider;
    eventEmitter?: IEventEmitter;
    sessionStore?: ISessionStore;
    upstreamFetcher?: IUpstreamFetcher;
    livenessChecker?: ILivenessChecker;
}
