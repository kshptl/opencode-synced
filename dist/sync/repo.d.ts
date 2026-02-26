import type { PluginInput } from '@opencode-ai/plugin';
import type { SyncConfig } from './config.js';
export interface RepoStatus {
    branch: string;
    changes: string[];
}
export interface RepoUpdateResult {
    updated: boolean;
    branch: string;
}
type Shell = PluginInput['$'];
export declare function isRepoCloned(repoDir: string): Promise<boolean>;
export declare function resolveRepoIdentifier(config: SyncConfig): string;
export declare function resolveRepoBranch(config: SyncConfig, fallback?: string): string;
export declare function ensureRepoCloned($: Shell, config: SyncConfig, repoDir: string): Promise<void>;
export declare function ensureRepoPrivate($: Shell, config: SyncConfig): Promise<void>;
export declare function parseRepoVisibility(output: string): boolean;
export declare function fetchAndFastForward($: Shell, repoDir: string, branch: string): Promise<RepoUpdateResult>;
export declare function getRepoStatus($: Shell, repoDir: string): Promise<RepoStatus>;
export declare function hasLocalChanges($: Shell, repoDir: string): Promise<boolean>;
export declare function commitAll($: Shell, repoDir: string, message: string): Promise<void>;
export declare function pushBranch($: Shell, repoDir: string, branch: string): Promise<void>;
export declare function repoExists($: Shell, repoIdentifier: string): Promise<boolean>;
export declare function getAuthenticatedUser($: Shell): Promise<string>;
export interface FoundRepo {
    owner: string;
    name: string;
    isPrivate: boolean;
}
export declare function findSyncRepo($: Shell, repoName?: string): Promise<FoundRepo | null>;
export {};
