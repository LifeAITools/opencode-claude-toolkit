export type ModelAllowlist = Map<string, Set<string>>;
export declare function baseModelName(model: string): string;
export declare function parseModelAllowlist(raw: any): ModelAllowlist;
export declare function orgsAllowedForModel(rules: ModelAllowlist, orgIds: string[], model: string): {
    allowed: string[];
    exclusive: boolean;
};
