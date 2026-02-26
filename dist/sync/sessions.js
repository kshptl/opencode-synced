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
import { unwrapData } from './utils.js';
const execFileAsync = promisify(execFile);
// ─── Constants ──────────────────────────────────────────────────────────────
/** Strict pattern: OpenCode session IDs are "ses_" + alphanumeric. */
export const SESSION_ID_RE = /^ses_[a-zA-Z0-9]{10,50}$/;
const SESSIONS_DIR_NAME = path.join('data', 'sessions');
const MANIFEST_FILE_NAME = 'manifest.json';
/** Max size of a single .jsonl session file before import is refused. */
const MAX_SESSION_FILE_BYTES = 95 * 1024 * 1024; // 95 MB — stays under GitHub's 100MB limit
/** Max size of a session NDJSON before export is skipped with a warning. */
const MAX_EXPORT_FILE_BYTES = 95 * 1024 * 1024; // 95 MB
/** Max sessions to import in a single pull (prevents manifest-stuffing attacks). */
const MAX_SESSIONS_PER_PULL = 1000;
export const COMPACT_TOOL_PLACEHOLDER = '[Synced: tool output cleared]';
export const COMPACT_REASONING_PLACEHOLDER = '';
// ─── Path helpers ────────────────────────────────────────────────────────────
function sessionsRoot(repoRoot) {
    return path.join(repoRoot, SESSIONS_DIR_NAME);
}
/**
 * Returns an absolute path under the sessions root, after validating:
 * 1. sessionId matches SESSION_ID_RE
 * 2. the resolved path stays within sessionsRoot (no traversal)
 * @internal exported for testing
 */
export function safeSessionPath(repoRoot, sessionId, suffix) {
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
function jsonlPath(repoRoot, sessionId) {
    return safeSessionPath(repoRoot, sessionId, '.jsonl');
}
function metaPath(repoRoot, sessionId) {
    return safeSessionPath(repoRoot, sessionId, '.meta.json');
}
function manifestPath(repoRoot) {
    return path.join(sessionsRoot(repoRoot), MANIFEST_FILE_NAME);
}
/**
 * Counts completed tool-result parts across all messages (in order).
 * Returns a Set of part IDs that should be kept in full.
 * @internal exported for testing
 */
export function buildRecentToolPartIds(messages, keepCount) {
    if (keepCount <= 0)
        return new Set();
    // Collect all completed-tool part IDs in document order.
    const completedToolIds = [];
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
 * @internal exported for testing
 */
export function prunePartCompact(part, recentToolIds) {
    if (part.type === 'tool') {
        const toolPart = part;
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
        const rp = part;
        return { ...rp, reasoning: COMPACT_REASONING_PLACEHOLDER };
    }
    // All other part types are kept verbatim.
    return part;
}
/** @internal exported for testing */
export function pruneMessages(messages, syncConfig) {
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
async function readManifest(repoRoot) {
    const mp = manifestPath(repoRoot);
    try {
        const raw = await fs.readFile(mp, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        // Missing or corrupt manifest — start fresh.
    }
    return {};
}
async function writeManifest(repoRoot, manifest) {
    const mp = manifestPath(repoRoot);
    await fs.mkdir(path.dirname(mp), { recursive: true });
    const tmp = mp + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, mp);
}
// ─── NDJSON I/O ──────────────────────────────────────────────────────────────
function encodeNdjsonLine(msg) {
    return JSON.stringify(msg) + '\n';
}
async function writeNdjson(filePath, messages) {
    const content = messages.map(encodeNdjsonLine).join('');
    const tmp = filePath + '.tmp';
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tmp, content, 'utf-8');
    await fs.rename(tmp, filePath);
}
async function readNdjson(filePath) {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_SESSION_FILE_BYTES) {
        throw new Error(`Session file too large to import (${stat.size} bytes, limit ${MAX_SESSION_FILE_BYTES})`);
    }
    const raw = await fs.readFile(filePath, 'utf-8');
    const messages = [];
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        const parsed = JSON.parse(trimmed);
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
async function fetchSessionMessages(client, sessionId) {
    try {
        const result = await client.session.messages({ path: { id: sessionId } });
        const data = unwrapData(result);
        if (!data)
            return null;
        return data.map((m) => ({ info: m.info, parts: m.parts }));
    }
    catch {
        return null;
    }
}
/**
 * Export all updated sessions to the sync repo across ALL projects.
 *
 * Uses client.project.list() to discover all known projects, then queries
 * sessions per project. Falls back to the unscoped client.session.list()
 * so sessions are always exported even if project.list() is scoped.
 *
 * Returns the updated manifest (to be merged into SyncState by the caller).
 */
export async function exportSessionsToRepo(client, repoRoot, config) {
    const manifest = await readManifest(repoRoot);
    // Collect sessions from all known projects, deduplicating by ID.
    const sessionMap = new Map();
    // 1. Try to enumerate all projects and fetch per-project sessions.
    try {
        const projectsResult = await client.project.list();
        const projects = unwrapData(projectsResult) ?? [];
        for (const project of projects) {
            try {
                const listResult = await client.session.list({
                    query: { directory: project.worktree },
                });
                const sessions = unwrapData(listResult) ?? [];
                for (const s of sessions)
                    sessionMap.set(s.id, s);
            }
            catch {
                // Skip projects that fail to list — don't abort the whole export.
            }
        }
    }
    catch {
        // project.list() unavailable or scoped — fall through to unscoped call.
    }
    // 2. Always also call unscoped list as a fallback/supplement.
    try {
        const listResult = await client.session.list();
        const sessions = unwrapData(listResult) ?? [];
        for (const s of sessions)
            sessionMap.set(s.id, s);
    }
    catch {
        // Ignore — we may already have sessions from project loop.
    }
    let updated = false;
    for (const session of sessionMap.values()) {
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
        const ndjsonContent = pruned.map((m) => JSON.stringify(m) + '\n').join('');
        const ndjsonBytes = Buffer.byteLength(ndjsonContent, 'utf-8');
        if (ndjsonBytes > MAX_EXPORT_FILE_BYTES) {
            // Session is too large for GitHub's 100MB file limit even after pruning.
            // Skip and remove any previously exported files to avoid push failures.
            await fs.rm(jsonlPath(repoRoot, sessionId), { force: true });
            await fs.rm(metaPath(repoRoot, sessionId), { force: true });
            delete manifest[sessionId];
            console.warn(`[opencode-synced] Skipping session ${sessionId} ("${session.title}"): ` +
                `${(ndjsonBytes / 1024 / 1024).toFixed(1)}MB exceeds the ${MAX_EXPORT_FILE_BYTES / 1024 / 1024}MB export limit.`);
            updated = true; // manifest changed (entry removed)
            continue;
        }
        await writeNdjson(jsonlPath(repoRoot, sessionId), pruned);
        await fs.mkdir(sessionsRoot(repoRoot), { recursive: true });
        await fs.writeFile(metaPath(repoRoot, sessionId), JSON.stringify(session, null, 2) + '\n', 'utf-8');
        manifest[sessionId] = { messageCount: pruned.length, timeUpdated };
        updated = true;
    }
    if (updated) {
        await writeManifest(repoRoot, manifest);
    }
    return manifest;
}
/**
 * Extracts the home directory from an absolute path.
 * e.g. /Users/kush/project → /Users/kush
 *      /home/kush/project  → /home/kush
 *      /root/project       → /root
 * Returns null if the path is too shallow to extract a home dir.
 * @internal exported for testing
 */
export function extractSourceHome(directory) {
    const parts = directory.split('/').filter(Boolean);
    // /root is a valid single-segment home on Linux
    if (parts.length >= 1 && parts[0] === 'root')
        return '/root';
    // /Users/X or /home/X — need at least 2 segments
    if (parts.length >= 2)
        return `/${parts[0]}/${parts[1]}`;
    return null;
}
/**
 * Rewrites an absolute path from the source machine to the local machine.
 *
 * Resolution order:
 * 1. Check projectPaths for an explicit full-path mapping.
 * 2. Fall back to replacing the source home prefix with os.homedir().
 * 3. If neither applies, return the path unchanged.
 *
 * @internal exported for testing
 */
export function rewriteAbsolutePath(p, sourceHome, localHome, projectPaths) {
    // 1. Explicit project path mapping (longest-prefix match wins).
    const sortedKeys = Object.keys(projectPaths).sort((a, b) => b.length - a.length);
    for (const src of sortedKeys) {
        if (p === src || p.startsWith(src + '/') || p.startsWith(src + path.sep)) {
            return projectPaths[src] + p.slice(src.length);
        }
    }
    // 2. Home directory substitution.
    if (sourceHome && sourceHome !== localHome) {
        if (p === sourceHome || p.startsWith(sourceHome + '/')) {
            return localHome + p.slice(sourceHome.length);
        }
    }
    return p;
}
/**
 * Rewrites absolute paths in session and message data so imported sessions
 * are visible under the correct local project directory.
 *
 * Uses home-directory substitution as the default heuristic, with an
 * optional explicit projectPaths map for non-standard directory structures.
 *
 * If the directory already resolves to the same path, original objects are
 * returned as-is (no copy made).
 * @internal exported for testing
 */
export function rewriteSessionPaths(session, messages, projectPaths = {}) {
    const localHome = os.homedir();
    const sourceHome = extractSourceHome(session.directory);
    const rewrite = (p) => rewriteAbsolutePath(p, sourceHome, localHome, projectPaths);
    const newDir = rewrite(session.directory);
    // No-op if nothing changes.
    if (newDir === session.directory) {
        return { session, messages };
    }
    const rewrittenSession = { ...session, directory: newDir };
    const rewrittenMessages = messages.map((msg) => {
        if (msg.info.role !== 'assistant')
            return msg;
        const am = msg.info;
        if (!am.path)
            return msg;
        return {
            ...msg,
            info: {
                ...am,
                path: {
                    cwd: rewrite(am.path.cwd),
                    root: rewrite(am.path.root),
                },
            },
        };
    });
    return { session: rewrittenSession, messages: rewrittenMessages };
}
/**
 * Checks whether a session already exists locally.
 */
async function sessionExistsLocally(client, sessionId) {
    try {
        const result = await client.session.get({ path: { id: sessionId } });
        const data = unwrapData(result);
        return data !== null;
    }
    catch {
        return false;
    }
}
/**
 * Imports a single session by writing to a temp file and invoking `opencode import`.
 * Rewrites absolute paths for cross-platform and cross-machine compatibility.
 * The temp file is always cleaned up.
 */
async function importSession(session, messages, projectPaths, log) {
    const { session: rewrittenSession, messages: rewrittenMessages } = rewriteSessionPaths(session, messages, projectPaths);
    const exportData = { info: rewrittenSession, messages: rewrittenMessages };
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
    }
    finally {
        await fs.unlink(tmpFile).catch(() => {
            // Best-effort cleanup; don't throw if the file was already removed.
        });
    }
}
/**
 * Read session metadata from the repo.
 * Returns null if the file is missing or malformed.
 */
async function readSessionMeta(repoRoot, sessionId) {
    try {
        const p = metaPath(repoRoot, sessionId);
        const raw = await fs.readFile(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed.id !== 'string')
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
/**
 * Import sessions from the sync repo that are missing locally.
 * Append-only: sessions that already exist locally are never modified.
 * Paths are rewritten using home-dir heuristic + optional projectPaths config.
 *
 * Returns the number of sessions successfully imported.
 */
export async function importSessionsFromRepo(client, repoRoot, config, log) {
    const manifest = await readManifest(repoRoot);
    const sessionIds = Object.keys(manifest);
    if (sessionIds.length === 0)
        return 0;
    // Cap to avoid manifest-stuffing attacks.
    const toProcess = sessionIds.slice(0, MAX_SESSIONS_PER_PULL);
    if (sessionIds.length > MAX_SESSIONS_PER_PULL) {
        log(`Warning: manifest contains ${sessionIds.length} sessions; processing first ${MAX_SESSIONS_PER_PULL}.`);
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
        if (exists)
            continue;
        const sessionMeta = await readSessionMeta(repoRoot, sessionId);
        if (!sessionMeta) {
            log(`Skipping ${sessionId}: missing or invalid .meta.json`);
            continue;
        }
        let messages;
        try {
            messages = await readNdjson(jsonlPath(repoRoot, sessionId));
        }
        catch (err) {
            log(`Skipping ${sessionId}: failed to read NDJSON — ${err instanceof Error ? err.message : String(err)}`);
            continue;
        }
        try {
            await importSession(sessionMeta, messages, config.sessionSync.projectPaths, log);
            imported++;
        }
        catch (err) {
            // Log and continue — one failing session must not block others.
            log(`Failed to import session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return imported;
}
