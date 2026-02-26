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
import type { NormalizedSyncConfig, SessionManifestEntry } from './config.js';
type Client = PluginInput['client'];
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
 * Import sessions from the sync repo that are missing locally.
 * Append-only: sessions that already exist locally are never modified.
 *
 * Returns the number of sessions successfully imported.
 */
export declare function importSessionsFromRepo(client: Client, repoRoot: string, log: (msg: string) => void): Promise<number>;
export {};
