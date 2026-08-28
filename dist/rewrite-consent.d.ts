export interface ConsentGrant {
    grantedAt: number;
    ttlMs: number;
}
export type ConsentGrants = Record<string, ConsentGrant>;
export declare function loadConsentGrants(path: string, now?: number): ConsentGrants;
export declare function grantConsent(path: string, sessionId: string, ttlMs: number, now?: number): void;
export declare function consumeConsent(path: string, sessionId: string, now?: number): boolean;
export declare function hasConsent(path: string, sessionId: string, now?: number): boolean;
