import type { NormalizedSyncConfig, SyncConfig } from './config.js';
export interface XdgPaths {
    homeDir: string;
    configDir: string;
    dataDir: string;
    stateDir: string;
}
export interface SyncLocations {
    xdg: XdgPaths;
    configRoot: string;
    syncConfigPath: string;
    overridesPath: string;
    statePath: string;
    defaultRepoDir: string;
}
export type SyncItemType = 'file' | 'dir';
export interface SyncItem {
    localPath: string;
    repoPath: string;
    type: SyncItemType;
    isSecret: boolean;
    isConfigFile: boolean;
}
export interface ExtraPathPlan {
    allowlist: string[];
    manifestPath: string;
    entries: Array<{
        sourcePath: string;
        repoPath: string;
    }>;
}
export interface SyncPlan {
    items: SyncItem[];
    extraSecrets: ExtraPathPlan;
    extraConfigs: ExtraPathPlan;
    repoRoot: string;
    homeDir: string;
    platform: NodeJS.Platform;
}
export declare function resolveHomeDir(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): string;
export declare function resolveXdgPaths(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): XdgPaths;
export declare function resolveSyncLocations(env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): SyncLocations;
export declare function expandHome(inputPath: string, homeDir: string): string;
export declare function normalizePath(inputPath: string, homeDir: string, platform?: NodeJS.Platform): string;
export declare function isSamePath(left: string, right: string, homeDir: string, platform?: NodeJS.Platform): boolean;
export declare function encodeExtraPath(inputPath: string): string;
export declare const encodeSecretPath: typeof encodeExtraPath;
export declare function resolveRepoRoot(config: SyncConfig | null, locations: SyncLocations): string;
export declare function buildSyncPlan(config: NormalizedSyncConfig, locations: SyncLocations, repoRoot: string, platform?: NodeJS.Platform): SyncPlan;
