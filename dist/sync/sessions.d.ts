/**
 * Session sync: export/import via SDK + NDJSON flat files.
 *
 * Repo structure:
 *   data/sessions/manifest.json            – per-session tracking metadata
 *   data/sessions/<sessionID>.meta.json    – Session info object
 *   data/sessions/<sessionID>.jsonl        – one JSON line per { info, parts } message
 *
 * Pruning (compact mode, default):
 *   - Completed tool outputs: keep the N most-recent unredacted; clear older ones.
 *   - Reasoning parts: clear text (keep structure).
 *   - Everything else (text, compaction, snapshot, patch, step-start/finish, etc.): verbatim.
 *
 * Security:
 *   - Session IDs validated against SESSION_ID_RE before any file-path use.
 *   - All derived paths containment-checked against the sessions root.
 *   - Import temp files use a random UUID name, cleaned up in finally.
 *   - Repo manifest entries validated before use.
 *   - File size limits enforced before loading.
 */
import type { PluginInput } from '@opencode-ai/plugin';
import type { Message, Part, Session } from '@opencode-ai/sdk';
import type { NormalizedSyncConfig, SessionManifestEntry, SessionSyncConfig } from './config.js';
type Client = PluginInput['client'];
/** Strict pattern: OpenCode session IDs are "ses_" + alphanumeric. */
export declare const SESSION_ID_RE: RegExp;
export declare const COMPACT_TOOL_PLACEHOLDER = "[Synced: tool output cleared]";
export declare const COMPACT_REASONING_PLACEHOLDER = "";
/**
 * Returns an absolute path under the sessions root, after validating:
 * 1. sessionId matches SESSION_ID_RE
 * 2. the resolved path stays within sessionsRoot (no traversal)
 * @internal exported for testing
 */
export declare function safeSessionPath(repoRoot: string, sessionId: string, suffix: string): string;
/** @internal exported for testing */
export interface MessageExport {
    info: Message;
    parts: Part[];
}
/**
 * Counts completed tool-result parts across all messages (in order).
 * Returns a Set of part IDs that should be kept in full.
 * @internal exported for testing
 */
export declare function buildRecentToolPartIds(messages: MessageExport[], keepCount: number): Set<string>;
/**
 * Returns a pruned copy of a Part for compact mode.
 * recentToolIds: set of completed-tool part IDs to keep in full.
 * @internal exported for testing
 */
export declare function prunePartCompact(part: Part, recentToolIds: Set<string>): Part;
/** @internal exported for testing */
export declare function pruneMessages(messages: MessageExport[], syncConfig: SessionSyncConfig): MessageExport[];
/**
 * Export all updated sessions to the sync repo.
 *
 * Only sessions whose time.updated has advanced since the manifest entry
 * are re-exported (incremental). Full rewrite of the NDJSON on each update
 * ensures correct pruning-window boundary across all messages.
 *
 * Returns the updated manifest (to be merged into SyncState by the caller).
 */
export declare function exportSessionsToRepo(client: Client, repoRoot: string, config: NormalizedSyncConfig): Promise<Record<string, SessionManifestEntry>>;
/**
 * Rewrites absolute paths in session and message data so imported sessions
 * are visible under the local project directory.
 *
 * When pushing from macOS (/Users/X/project) and pulling on Linux
 * (/home/X/project), the session.directory and every AssistantMessage's
 * path.cwd / path.root are updated by replacing the source prefix with the
 * local project directory.
 *
 * If the directory already matches, the original objects are returned as-is.
 * @internal exported for testing
 */
export declare function rewriteSessionPaths(session: Session, messages: MessageExport[], localDirectory: string): {
    session: Session;
    messages: MessageExport[];
};
/**
 * Import sessions from the sync repo that are missing locally.
 * Append-only: sessions that already exist locally are never modified.
 * Paths are rewritten to match localDirectory for cross-platform compatibility.
 *
 * Returns the number of sessions successfully imported.
 */
export declare function importSessionsFromRepo(client: Client, repoRoot: string, localDirectory: string, log: (msg: string) => void): Promise<number>;
export {};
