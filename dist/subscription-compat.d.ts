export type CompatEmit = (event: {
    level: "error" | "info" | "debug";
    kind: string;
} & Record<string, unknown>) => void;
export declare function hasAnyCacheControl(body: Record<string, unknown>): boolean;
export declare function injectCacheMarkers(body: Record<string, unknown>): number;
export declare function setCompatVersion(v: string): void;
export interface AnthropicEnrichResult {
    body: string;
    headers: Record<string, string>;
}
export declare function clampEffortIfThinkingDisabled(body: Record<string, unknown>, emit?: CompatEmit): string | null;
export declare function enrichAnthropicRequest(rawBody: string, consumerHeaders: Record<string, string>, sessionId: string, emit?: CompatEmit): AnthropicEnrichResult;
