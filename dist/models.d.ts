export interface ModelMetadata {
    name: string;
    context: number;
    defaultOutput: number;
    maxOutput: number;
    adaptiveThinking: boolean;
    samplingParams: boolean;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
export declare const MAX_MODELS: Record<string, ModelMetadata>;
export declare const FALLBACK_MODEL: Pick<ModelMetadata, "defaultOutput" | "maxOutput" | "adaptiveThinking">;
export declare function resolveMaxTokens(modelId: string, explicitOverride?: number): number;
export declare function getModelMetadata(modelId: string): ModelMetadata | undefined;
export declare function supportsAdaptiveThinking(modelId: string): boolean;
export declare function supportsSamplingParams(modelId: string): boolean;
