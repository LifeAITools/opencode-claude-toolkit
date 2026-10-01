export type CompatEmit = (event: {
    level: "error" | "info" | "debug";
    kind: string;
} & Record<string, unknown>) => void;
export declare const CACHE_OPT_OUT_HEADER = "x-claude-max-cache";
export declare function cacheInjectionDisabled(headers: Record<string, string | undefined> | Headers | undefined): boolean;
export declare function hasAnyCacheControl(body: Record<string, unknown>): boolean;
export declare function injectCacheMarkers(body: Record<string, unknown>): number;
export declare function setCompatVersion(v: string): void;
export interface AnthropicEnrichResult {
    body: string;
    headers: Record<string, string>;
}
export declare function clampEffortIfThinkingDisabled(body: Record<string, unknown>, emit?: CompatEmit): string | null;
export declare function withBillingBlock(system: unknown, billingLine: string): unknown;
export declare function enrichAnthropicRequest(rawBody: string, consumerHeaders: Record<string, string>, sessionId: string, emit?: CompatEmit): AnthropicEnrichResult;
