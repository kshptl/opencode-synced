export interface McpSecretExtraction {
    sanitizedConfig: Record<string, unknown>;
    secretOverrides: Record<string, unknown>;
}
export declare function extractMcpSecrets(config: Record<string, unknown>): McpSecretExtraction;
export declare function mergeOverrides(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown>;
export declare function stripOverrideKeys(base: Record<string, unknown>, toRemove: Record<string, unknown>): Record<string, unknown>;
export declare function hasOverrides(value: Record<string, unknown>): boolean;
