import type { PluginInput } from '@opencode-ai/plugin';
type CommitClient = PluginInput['client'];
type Shell = PluginInput['$'];
interface CommitContext {
    client: CommitClient;
    $: Shell;
}
export declare function generateCommitMessage(ctx: CommitContext, repoDir: string, fallbackDate?: Date): Promise<string>;
export {};
