import type { PluginInput } from '@opencode-ai/plugin';
import type { NormalizedSyncConfig } from './config.js';
import type { SyncLocations } from './paths.js';
type Shell = PluginInput['$'];
export interface OnePasswordConfig {
    type: '1password';
    vault: string;
    authJson: string;
    mcpAuthJson: string;
}
export interface SecretsBackend {
    pull: () => Promise<void>;
    push: () => Promise<void>;
    status: () => Promise<string>;
}
export type SecretsBackendResolution = {
    state: 'none';
} | {
    state: 'invalid';
    error: string;
} | {
    state: 'ok';
    config: OnePasswordConfig;
};
export declare function resolveSecretsBackendConfig(config: NormalizedSyncConfig): SecretsBackendResolution;
export declare function resolveAuthFilePaths(locations: SyncLocations): {
    authPath: string;
    mcpAuthPath: string;
};
export declare function resolveRepoAuthPaths(repoRoot: string): {
    authRepoPath: string;
    mcpAuthRepoPath: string;
};
export declare function computeSecretsHash(locations: SyncLocations): Promise<string>;
export declare function createSecretsBackend(options: {
    $: Shell;
    locations: SyncLocations;
    config: OnePasswordConfig;
}): SecretsBackend;
export {};
