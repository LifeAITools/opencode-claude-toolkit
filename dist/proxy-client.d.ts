import { KeepaliveEngine } from "./keepalive-engine.js";
import type { ICredentialsProvider, IEventEmitter, ILivenessChecker, ISessionStore, IUpstreamFetcher, Session } from "./proxy-ports.js";
import { type OrgIdResolver } from "./org-identity.js";
import { OrgVault } from "./org-vault.js";
import { type RefreshedTokens } from "./auth.js";
export interface ProxyClientConfig {
    anthropicBaseUrl?: string;
    kaCacheTtlSec?: number;
    kaIntervalSec?: number;
    kaIdleTimeoutSec?: number;
    kaMinTokens?: number;
    kaRewriteWarnIdleSec?: number;
    kaRewriteWarnTokens?: number;
    kaRewriteBlockIdleSec?: number;
    kaRewriteBlockEnabled?: boolean;
    kaEvictionHoldSec?: number;
    kaEvictionMinTrips?: number;
    orgProactiveRefreshSec?: number;
}
export interface ProxyClientOptions {
    config?: ProxyClientConfig;
    credentialsProvider: ICredentialsProvider;
    eventEmitter?: IEventEmitter;
    sessionStore?: ISessionStore<KeepaliveEngine>;
    upstreamFetcher?: IUpstreamFetcher;
    livenessChecker?: ILivenessChecker;
    orgIdResolver?: OrgIdResolver;
    prefixHistoryPath?: string;
    rewriteBlockDumpDir?: string;
    proxyStartedAt?: number;
    kaSnapshotPath?: string;
    orgVault?: OrgVault;
    claudeConfigDir?: string;
    credentialsPath?: string;
    oauthRefresher?: (refreshToken: string) => Promise<RefreshedTokens>;
    acquireConfigLock?: (configDir: string) => Promise<(() => Promise<void>) | null>;
}
export interface HandleRequestContext {
    sessionId: string;
    sourcePid?: number | null;
    signal?: AbortSignal;
    agentId?: string | null;
    clientUserAgent?: string | null;
    interactive?: boolean;
    idSource?: "header" | "body" | "none";
}
export interface RateLimitSnapshot {
    status: string | null;
    resetAt: number | null;
    resetAt7d?: number | null;
    claim: string | null;
    retryAfter: number | null;
    utilization5h: number | null;
    utilization7d: number | null;
}
export declare class ProxyClient {
    private readonly config;
    private readonly metrics;
    private readonly credentials;
    private readonly events;
    private readonly store;
    private readonly upstream;
    private readonly liveness;
    private readonly realRetryDelaysMs;
    private readonly retryCeilingMs;
    private readonly retryRandom;
    private readonly reaperTimer;
    private lastRateLimit;
    private readonly prefixHistory;
    private readonly prefixHistoryPath;
    private readonly rewriteBlockDumpDir;
    private readonly proxyStartedAt;
    private lastCcVersionBySession;
    private readonly kaSnapshotPath;
    private kaSnapshotPersistFailing;
    private kaSnapshotDirty;
    private readonly kaReviveDropped;
    private readonly lineagePrefix;
    private readonly sessionPins;
    private readonly orgVault;
    private readonly orgRotateConsent;
    private readonly lastServedOrg;
    private readonly orgRefreshInflight;
    private readonly orgLastRefreshAt;
    private readonly orgRefreshCooldown;
    private orgProactiveTimer;
    private readonly claudeConfigDir;
    private readonly credentialsPath;
    private readonly oauthRefresher;
    private readonly acquireConfigLock;
    private readonly orgIdResolver;
    private readonly evictionBreaker;
    constructor(opts: ProxyClientOptions);
    get rateLimitSnapshot(): Readonly<RateLimitSnapshot>;
    listSessions(): Session<KeepaliveEngine>[];
    sessionCount(): number;
    markManagedSession(sessionId: string, workerId: string, ttlMs?: number): boolean;
    workerHeartbeat(workerId: string, activeSessionIds: string[]): number;
    unmarkManagedSession(sessionId: string): boolean;
    get configSnapshot(): Readonly<Omit<Required<ProxyClientConfig>, "kaIntervalSec"> & {
        kaIntervalSec: number | undefined;
    }>;
    get cacheMetricsSnapshot(): import("./cache-metrics.js").MetricsSummary;
    stop(): void;
    disarmSessions(reason: string, sessionId?: string): string[];
    reloadSessions(reason: string, sessionId?: string): string[];
    notifyCredentialsChanged(reason: string): void;
    private reconcileFrozenSessionsForChangedOrg;
    _reconcileFrozenSessionsForChangedOrg(): void;
    _sessionFrozenLineages(sessionId: string): number;
    _sessionPrimedLineages(sessionId: string): number;
    snapshotCurrentAccount(reason: string): Promise<void>;
    private isActiveOrg;
    private orgTokenMeta;
    private isRefreshDueByExpiry;
    private inFailureCooldown;
    private minRefreshIntervalElapsed;
    private recordRefreshSuccess;
    private recordRefreshFailure;
    private withFreshOrgToken;
    private refreshActiveOrg;
    private refreshVaultOrg;
    private handleOrg401;
    private resolveServedOrg;
    private getTokenForSession;
    private proactiveOrgSweep;
    _runOrgProactiveSweep(): Promise<void>;
    private gcSessionPins;
    _gcSessionPins(now?: number): void;
    _orgCooldown(orgId: string): {
        until: number;
        attempts: number;
        needsRelogin: boolean;
    } | undefined;
    _withFreshOrgToken(orgId: string, opts?: {
        force?: boolean;
        reason?: string;
    }): Promise<string | null>;
    _forceOrg401(orgId: string, failedToken: string): Promise<void>;
    switchSessionOrg(sessionId: string, orgQuery: string): Promise<{
        ok: true;
        orgId: string;
        orgName?: string;
        refreshed: boolean;
    } | {
        ok: false;
        error: string;
    }>;
    orgSurface(): {
        orgs: Array<{
            orgId: string;
            orgName?: string;
            accountEmail?: string;
            expiresAt: number | null;
            hasRefreshToken: boolean;
            capturedAt: number;
            lastVerifiedAt?: number;
        }>;
        sessions: Array<{
            sessionId: string;
            pinnedOrg: string | null;
            servedOrg: string | null;
        }>;
    };
    orgTokenHealth(): {
        orgs: number;
        minOrgExpiresInSec: number | null;
        orgsExpired: number;
        orgsNeedRelogin: number;
    };
    private selectSessionToken;
    handleRequest(rawBody: ArrayBuffer | Uint8Array | string, headers: Record<string, string>, ctx: HandleRequestContext): Promise<Response>;
    private createEngine;
    private collectKaSnapshots;
    private persistKaSnapshots;
    private reviveKaSnapshots;
    private restorePinForRevivedSession;
    private static readonly AVOIDABLE_DROP_REASONS;
    private recordReviveDrop;
    private engineDoFetch;
    private parseSSEAndNotify;
    private kaHoldsWarmLineage;
    private assessCacheMiss;
    private commitPrefixHistory;
    private handleNetworkError;
}
export declare function parseRateLimitHeaders(headers: Headers): RateLimitSnapshot;
export declare function extractSessionIdFromBody(rawBody: ArrayBuffer | Uint8Array | string): string | null;
