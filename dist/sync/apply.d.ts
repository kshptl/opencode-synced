import type { SyncPlan } from './paths.js';
export declare function syncRepoToLocal(plan: SyncPlan, overrides: Record<string, unknown> | null): Promise<void>;
export declare function syncLocalToRepo(plan: SyncPlan, overrides: Record<string, unknown> | null, options?: {
    overridesPath?: string;
    allowMcpSecrets?: boolean;
}): Promise<void>;
