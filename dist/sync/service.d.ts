import type { PluginInput } from '@opencode-ai/plugin';
type SyncServiceContext = Pick<PluginInput, 'client' | '$' | 'directory'>;
interface InitOptions {
    repo?: string;
    owner?: string;
    name?: string;
    url?: string;
    branch?: string;
    includeSecrets?: boolean;
    includeMcpSecrets?: boolean;
    includeSessions?: boolean;
    includePromptStash?: boolean;
    includeModelFavorites?: boolean;
    create?: boolean;
    private?: boolean;
    extraSecretPaths?: string[];
    extraConfigPaths?: string[];
    localRepoPath?: string;
    sessionSync?: {
        mode?: 'compact' | 'full';
        keepRecentToolResults?: number;
    };
}
interface LinkOptions {
    repo?: string;
}
export interface SyncService {
    startupSync: () => Promise<void>;
    status: () => Promise<string>;
    init: (_options: InitOptions) => Promise<string>;
    link: (_options: LinkOptions) => Promise<string>;
    pull: () => Promise<string>;
    push: () => Promise<string>;
    secretsPull: () => Promise<string>;
    secretsPush: () => Promise<string>;
    secretsStatus: () => Promise<string>;
    enableSecrets: (_options?: {
        extraSecretPaths?: string[];
        includeMcpSecrets?: boolean;
    }) => Promise<string>;
    resolve: () => Promise<string>;
}
export declare function createSyncService(ctx: SyncServiceContext): SyncService;
export {};
