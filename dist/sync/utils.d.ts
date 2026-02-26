import type { PluginInput } from '@opencode-ai/plugin';
type Client = PluginInput['client'];
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export declare function createLogger(client: Client): {
    debug: (message: string, extra?: Record<string, unknown>) => void;
    info: (message: string, extra?: Record<string, unknown>) => void;
    warn: (message: string, extra?: Record<string, unknown>) => void;
    error: (message: string, extra?: Record<string, unknown>) => void;
};
export declare function showToast(client: Client, message: string, variant: 'info' | 'success' | 'warning' | 'error'): Promise<void>;
export declare function unwrapData<T>(response: unknown): T | null;
export declare function extractTextFromResponse(response: unknown): string | null;
export declare function resolveSmallModel(client: Client): Promise<{
    providerID: string;
    modelID: string;
} | null>;
export {};
