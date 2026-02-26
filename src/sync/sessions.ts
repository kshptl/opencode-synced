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

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type { PluginInput } from '@opencode-ai/plugin';
import type { AssistantMessage, Message, Part, Session } from '@opencode-ai/sdk';

import type { NormalizedSyncConfig, SessionManifestEntry, SessionSyncConfig } from './config.js';
import { unwrapData } from './utils.js';

const execFileAsync = promisify(execFile);

type Client = PluginInput['client'];
type Shell = PluginInput['$'];

// ─── Constants ──────────────────────────────────────────────────────────────

/** Strict pattern: OpenCode session IDs are "ses_" + alphanumeric. */
const SESSION_ID_RE = /^ses_[a-zA-Z0-9]{10,50}$/;

const SESSIONS_DIR_NAME = path.join('data', 'sessions');
const MANIFEST_FILE_NAME = 'manifest.json';

/** Max size of a single .jsonl session file before import is refused. */
const MAX_SESSION_FILE_BYTES = 100 * 1024 * 1024; // 100 MB

/** Max sessions to import in a single pull (prevents manifest-stuffing attacks). */
const MAX_SESSIONS_PER_PULL = 1000;

const COMPACT_TOOL_PLACEHOLDER = '[Synced: tool output cleared]';
const COMPACT_REASONING_PLACEHOLDER = '';

// ─── Path helpers ────────────────────────────────────────────────────────────

function sessionsRoot(repoRoot: string): string {
  return path.join(repoRoot, SESSIONS_DIR_NAME);
}

/**
 * Returns an absolute path under the sessions root, after validating:
 * 1. sessionId matches SESSION_ID_RE
 * 2. the resolved path stays within sessionsRoot (no traversal)
 */
function safeSessionPath(repoRoot: string, sessionId: string, suffix: string): string {
  if (!SESSION_ID_RE.test(sessionId)) {
    throw new Error(`Invalid session ID format: "${sessionId}"`);
  }
  const root = path.resolve(sessionsRoot(repoRoot));
  const p = path.resolve(path.join(root, `${sessionId}${suffix}`));
  if (!p.startsWith(root + path.sep) && p !== root) {
    throw new Error(`Path traversal detected for session ID: "${sessionId}"`);
  }
  return p;
}

function jsonlPath(repoRoot: string, sessionId: string): string {
  return safeSessionPath(repoRoot, sessionId, '.jsonl');
}

function metaPath(repoRoot: string, sessionId: string): string {
  return safeSessionPath(repoRoot, sessionId, '.meta.json');
}

function manifestPath(repoRoot: string): string {
  return path.join(sessionsRoot(repoRoot), MANIFEST_FILE_NAME);
}

// ─── Pruning ─────────────────────────────────────────────────────────────────

interface MessageExport {
  info: Message;
  parts: Part[];
}

/**
 * Counts completed tool-result parts across all messages (in order).
 * Returns a Set of part IDs that should be kept in full.
 */
function buildRecentToolPartIds(messages: MessageExport[], keepCount: number): Set<string> {
  if (keepCount <= 0) return new Set();

  // Collect all completed-tool part IDs in document order.
  const completedToolIds: string[] = [];
  for (const msg of messages) {
    for (const part of msg.parts) {
      if (part.type === 'tool' && 'state' in part && part.state.status === 'completed') {
        completedToolIds.push(part.id);
      }
    }
  }

  // Keep only the last N.
  const recent = completedToolIds.slice(-keepCount);
  return new Set(recent);
}

/**
 * Returns a pruned copy of a Part for compact mode.
 * recentToolIds: set of completed-tool part IDs to keep in full.
 */
function prunePartCompact(part: Part, recentToolIds: Set<string>): Part {
  if (part.type === 'tool') {
    const toolPart = part as Extract<Part, { type: 'tool' }>;
    // Only prune completed tool results that are outside the recent window.
    if (toolPart.state.status === 'completed' && !recentToolIds.has(toolPart.id)) {
      return {
        ...toolPart,
        state: {
          ...toolPart.state,
          output: COMPACT_TOOL_PLACEHOLDER,
          attachments: undefined,
        },
      };
    }
    return toolPart;
  }

  if (part.type === 'reasoning') {
    const rp = part as Extract<Part, { type: 'reasoning' }>;
    return { ...rp, reasoning: COMPACT_REASONING_PLACEHOLDER } as typeof rp;
  }

  // All other part types are kept verbatim.
  return part;
}

function pruneMessages(messages: MessageExport[], syncConfig: SessionSyncConfig): MessageExport[] {
  if (syncConfig.mode === 'full') {
    return messages;
  }

  const recentToolIds = buildRecentToolPartIds(messages, syncConfig.keepRecentToolResults);

  return messages.map((msg) => ({
    info: msg.info,
    parts: msg.parts.map((p) => prunePartCompact(p, recentToolIds)),
  }));
}

// ─── Manifest I/O ────────────────────────────────────────────────────────────

async function readManifest(repoRoot: string): Promise<Record<string, SessionManifestEntry>> {
  const mp = manifestPath(repoRoot);
  try {
    const raw = await fs.readFile(mp, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, SessionManifestEntry>;
    }
  } catch {
    // Missing or corrupt manifest — start fresh.
  }
  return {};
}

async function writeManifest(
  repoRoot: string,
  manifest: Record<string, SessionManifestEntry>
): Promise<void> {
  const mp = manifestPath(repoRoot);
  await fs.mkdir(path.dirname(mp), { recursive: true });
  const tmp = mp + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  await fs.rename(tmp, mp);
}

// ─── NDJSON I/O ──────────────────────────────────────────────────────────────

function encodeNdjsonLine(msg: MessageExport): string {
  return JSON.stringify(msg) + '\n';
}

async function writeNdjson(filePath: string, messages: MessageExport[]): Promise<void> {
  const content = messages.map(encodeNdjsonLine).join('');
  const tmp = filePath + '.tmp';
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, filePath);
}

async function readNdjson(filePath: string): Promise<MessageExport[]> {
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_SESSION_FILE_BYTES) {
    throw new Error(
      `Session file too large to import (${stat.size} bytes, limit ${MAX_SESSION_FILE_BYTES})`
    );
  }

  const raw = await fs.readFile(filePath, 'utf-8');
  const messages: MessageExport[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as MessageExport;
    // Basic schema validation: must have info and parts.
    if (!parsed || typeof parsed !== 'object' || !parsed.info || !Array.isArray(parsed.parts)) {
      throw new Error('Malformed NDJSON line: missing info or parts');
    }
    messages.push(parsed);
  }
  return messages;
}

// ─── Export (push) ───────────────────────────────────────────────────────────

/**
 * Fetches messages for a session from the SDK.
 * Returns null if the session cannot be read (e.g. active/locked).
 */
async function fetchSessionMessages(
  client: Client,
  sessionId: string
): Promise<MessageExport[] | null> {
  try {
    const result = await client.session.messages({ path: { id: sessionId } });
    const data = unwrapData<Array<{ info: Message; parts: Part[] }>>(result);
    if (!data) return null;
    return data.map((m) => ({ info: m.info, parts: m.parts }));
  } catch {
    return null;
  }
}

/**
 * Export all updated sessions to the sync repo.
 *
 * Only sessions whose time.updated has advanced since the manifest entry
 * are re-exported (incremental). Full rewrite of the NDJSON on each update
 * ensures correct pruning-window boundary across all messages.
 *
 * Returns the updated manifest (to be merged into SyncState by the caller).
 */
export async function exportSessionsToRepo(
  client: Client,
  repoRoot: string,
  config: NormalizedSyncConfig
): Promise<Record<string, SessionManifestEntry>> {
  const manifest = await readManifest(repoRoot);

  // Fetch all sessions.
  const listResult = await client.session.list();
  const sessions = unwrapData<Session[]>(listResult) ?? [];

  let updated = false;

  for (const session of sessions) {
    const sessionId = session.id;

    // Security: validate ID before any file-path use.
    if (!SESSION_ID_RE.test(sessionId)) {
      continue;
    }

    const existing = manifest[sessionId];
    const timeUpdated = session.time.updated;

    // Skip sessions that haven't changed since last export.
    if (existing && existing.timeUpdated >= timeUpdated) {
      continue;
    }

    const messages = await fetchSessionMessages(client, sessionId);
    if (!messages) {
      // Could not fetch — skip silently (session may be active or inaccessible).
      continue;
    }

    const pruned = pruneMessages(messages, config.sessionSync);

    await writeNdjson(jsonlPath(repoRoot, sessionId), pruned);
    await fs.mkdir(sessionsRoot(repoRoot), { recursive: true });
    await fs.writeFile(
      metaPath(repoRoot, sessionId),
      JSON.stringify(session, null, 2) + '\n',
      'utf-8'
    );

    manifest[sessionId] = { messageCount: pruned.length, timeUpdated };
    updated = true;
  }

  if (updated) {
    await writeManifest(repoRoot, manifest);
  }

  return manifest;
}

// ─── Import (pull) ───────────────────────────────────────────────────────────

interface ExportFormat {
  info: Session;
  messages: MessageExport[];
}

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
 */
function rewriteSessionPaths(
  session: Session,
  messages: MessageExport[],
  localDirectory: string
): { session: Session; messages: MessageExport[] } {
  const sourceDir = session.directory;

  // Nothing to do if the directories already match.
  if (sourceDir === localDirectory) {
    return { session, messages };
  }

  const rewrite = (p: string): string =>
    p.startsWith(sourceDir) ? localDirectory + p.slice(sourceDir.length) : p;

  const rewrittenSession: Session = { ...session, directory: localDirectory };

  const rewrittenMessages: MessageExport[] = messages.map((msg) => {
    if (msg.info.role !== 'assistant') return msg;

    const am = msg.info as AssistantMessage;
    if (!am.path) return msg;

    return {
      ...msg,
      info: {
        ...am,
        path: {
          cwd: rewrite(am.path.cwd),
          root: rewrite(am.path.root),
        },
      } as AssistantMessage,
    };
  });

  return { session: rewrittenSession, messages: rewrittenMessages };
}

/**
 * Checks whether a session already exists locally.
 */
async function sessionExistsLocally(client: Client, sessionId: string): Promise<boolean> {
  try {
    const result = await client.session.get({ path: { id: sessionId } });
    const data = unwrapData<Session>(result);
    return data !== null;
  } catch {
    return false;
  }
}

/**
 * Imports a single session by writing to a temp file and invoking `opencode import`.
 * Rewrites absolute paths so the session is visible under localDirectory.
 * The temp file is always cleaned up.
 */
async function importSession(
  session: Session,
  messages: MessageExport[],
  localDirectory: string,
  log: (msg: string) => void
): Promise<void> {
  const { session: rewrittenSession, messages: rewrittenMessages } = rewriteSessionPaths(
    session,
    messages,
    localDirectory
  );

  const exportData: ExportFormat = { info: rewrittenSession, messages: rewrittenMessages };
  const json = JSON.stringify(exportData);

  // Secure temp file: random UUID name in the system temp dir.
  const tmpFile = path.join(os.tmpdir(), `opencode-sync-import-${crypto.randomUUID()}.json`);

  try {
    await fs.writeFile(tmpFile, json, { encoding: 'utf-8', mode: 0o600 });

    const { stderr } = await execFileAsync('opencode', ['import', tmpFile], {
      timeout: 30_000,
    });

    if (stderr?.trim()) {
      log(`import warning for ${session.id}: ${stderr.trim()}`);
    }
  } finally {
    await fs.unlink(tmpFile).catch(() => {
      // Best-effort cleanup; don't throw if the file was already removed.
    });
  }
}

/**
 * Read session metadata from the repo.
 * Returns null if the file is missing or malformed.
 */
async function readSessionMeta(repoRoot: string, sessionId: string): Promise<Session | null> {
  try {
    const p = metaPath(repoRoot, sessionId);
    const raw = await fs.readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as Session;
    if (!parsed || typeof parsed.id !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Import sessions from the sync repo that are missing locally.
 * Append-only: sessions that already exist locally are never modified.
 * Paths are rewritten to match localDirectory for cross-platform compatibility.
 *
 * Returns the number of sessions successfully imported.
 */
export async function importSessionsFromRepo(
  client: Client,
  repoRoot: string,
  localDirectory: string,
  log: (msg: string) => void
): Promise<number> {
  const manifest = await readManifest(repoRoot);
  const sessionIds = Object.keys(manifest);

  if (sessionIds.length === 0) return 0;

  // Cap to avoid manifest-stuffing attacks.
  const toProcess = sessionIds.slice(0, MAX_SESSIONS_PER_PULL);
  if (sessionIds.length > MAX_SESSIONS_PER_PULL) {
    log(
      `Warning: manifest contains ${sessionIds.length} sessions; processing first ${MAX_SESSIONS_PER_PULL}.`
    );
  }

  let imported = 0;

  for (const sessionId of toProcess) {
    // Security: validate ID before any file I/O.
    if (!SESSION_ID_RE.test(sessionId)) {
      log(`Skipping invalid session ID in manifest: "${sessionId}"`);
      continue;
    }

    // Skip sessions that already exist locally (append-only semantics).
    const exists = await sessionExistsLocally(client, sessionId);
    if (exists) continue;

    const sessionMeta = await readSessionMeta(repoRoot, sessionId);
    if (!sessionMeta) {
      log(`Skipping ${sessionId}: missing or invalid .meta.json`);
      continue;
    }

    let messages: MessageExport[];
    try {
      messages = await readNdjson(jsonlPath(repoRoot, sessionId));
    } catch (err) {
      log(
        `Skipping ${sessionId}: failed to read NDJSON — ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }

    try {
      await importSession(sessionMeta, messages, localDirectory, log);
      imported++;
    } catch (err) {
      // Log and continue — one failing session must not block others.
      log(
        `Failed to import session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return imported;
}
