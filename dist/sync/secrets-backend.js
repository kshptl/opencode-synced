import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { chmodIfExists, pathExists } from './config.js';
import { SyncCommandError } from './errors.js';
export function resolveSecretsBackendConfig(config) {
    const backend = config.secretsBackend;
    if (!backend) {
        return { state: 'none' };
    }
    const backendType = backend.type;
    if (backendType !== '1password') {
        return {
            state: 'invalid',
            error: `Unsupported secrets backend type "${backendType}".`,
        };
    }
    return resolveOnePasswordConfig(backend);
}
export function resolveAuthFilePaths(locations) {
    const dataRoot = path.join(locations.xdg.dataDir, 'opencode');
    return {
        authPath: path.join(dataRoot, 'auth.json'),
        mcpAuthPath: path.join(dataRoot, 'mcp-auth.json'),
    };
}
export function resolveRepoAuthPaths(repoRoot) {
    const repoDataRoot = path.join(repoRoot, 'data');
    return {
        authRepoPath: path.join(repoDataRoot, 'auth.json'),
        mcpAuthRepoPath: path.join(repoDataRoot, 'mcp-auth.json'),
    };
}
export async function computeSecretsHash(locations) {
    const { authPath, mcpAuthPath } = resolveAuthFilePaths(locations);
    return await hashFiles([authPath, mcpAuthPath]);
}
export function createSecretsBackend(options) {
    const backendType = options.config.type;
    if (backendType === '1password') {
        return createOnePasswordBackend(options);
    }
    throw new SyncCommandError(`Unsupported secrets backend type "${backendType}".`);
}
function resolveOnePasswordConfig(backend) {
    const vault = backend.vault?.trim();
    if (!vault) {
        return {
            state: 'invalid',
            error: 'secretsBackend.vault is required for type "1password".',
        };
    }
    const documents = backend.documents ?? {};
    const authJson = documents.authJson?.trim();
    const mcpAuthJson = documents.mcpAuthJson?.trim();
    if (!authJson || !mcpAuthJson) {
        return {
            state: 'invalid',
            error: 'secretsBackend.documents.authJson and secretsBackend.documents.mcpAuthJson ' +
                'are required for type "1password".',
        };
    }
    if (normalizeDocumentName(authJson) === normalizeDocumentName(mcpAuthJson)) {
        return {
            state: 'invalid',
            error: 'secretsBackend.documents.authJson and secretsBackend.documents.mcpAuthJson must be unique.',
        };
    }
    return {
        state: 'ok',
        config: {
            type: '1password',
            vault,
            authJson,
            mcpAuthJson,
        },
    };
}
function normalizeDocumentName(name) {
    return name.trim().toLowerCase();
}
function createOnePasswordBackend(options) {
    const { $, locations, config } = options;
    const { authPath, mcpAuthPath } = resolveAuthFilePaths(locations);
    const pull = async () => {
        await ensureOpAvailable($);
        const index = await listVaultDocuments($, config.vault);
        await pullDocument($, config.vault, config.authJson, authPath, index);
        await pullDocument($, config.vault, config.mcpAuthJson, mcpAuthPath, index);
    };
    const push = async () => {
        await ensureOpAvailable($);
        const existing = await Promise.all([pathExists(authPath), pathExists(mcpAuthPath)]);
        if (!existing.some(Boolean)) {
            return;
        }
        const index = await listVaultDocuments($, config.vault);
        await pushDocument($, config.vault, config.authJson, authPath, index);
        await pushDocument($, config.vault, config.mcpAuthJson, mcpAuthPath, index);
    };
    const status = async () => {
        await ensureOpAvailable($);
        return `1Password backend configured for vault "${config.vault}".`;
    };
    return { pull, push, status };
}
async function ensureOpAvailable($) {
    try {
        await $ `op --version`.quiet();
    }
    catch {
        throw new SyncCommandError('1Password CLI not found. Install it and sign in with `op signin`.');
    }
}
async function listVaultDocuments($, vault) {
    let output;
    try {
        output = await $ `op item list --vault ${vault} --categories Document --format json`
            .quiet()
            .text();
    }
    catch (error) {
        throw new SyncCommandError(`1Password document list failed: ${formatShellError(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(output);
    }
    catch {
        throw new SyncCommandError('1Password document list returned invalid JSON.');
    }
    if (!Array.isArray(parsed)) {
        throw new SyncCommandError('1Password document list returned unexpected data.');
    }
    const index = new Map();
    for (const entry of parsed) {
        if (!entry || typeof entry !== 'object')
            continue;
        const record = entry;
        const id = typeof record.id === 'string' ? record.id : '';
        const title = typeof record.title === 'string' ? record.title : '';
        if (!id || !title)
            continue;
        const key = normalizeDocumentName(title);
        const existing = index.get(key);
        const item = { id, title };
        if (existing) {
            existing.push(item);
        }
        else {
            index.set(key, [item]);
        }
    }
    return index;
}
function lookupDocument(index, documentName) {
    const key = normalizeDocumentName(documentName);
    const matches = index.get(key) ?? [];
    if (matches.length === 0) {
        return { state: 'missing', count: 0 };
    }
    if (matches.length > 1) {
        return { state: 'duplicate', count: matches.length };
    }
    return { state: 'ok', count: 1 };
}
async function pullDocument($, vault, documentName, targetPath, index) {
    const lookup = lookupDocument(index, documentName);
    if (lookup.state === 'missing') {
        return;
    }
    if (lookup.state === 'duplicate') {
        throw new SyncCommandError(`Multiple documents named "${documentName}" found in vault "${vault}". ` +
            'Rename them to be unique.');
    }
    const { tempDir, tempPath } = await createTempPath(targetPath);
    try {
        try {
            await opDocumentGet($, vault, documentName, tempPath);
        }
        catch (error) {
            const retryLookup = await lookupDocumentWithRetry($, vault, documentName);
            if (!retryLookup) {
                throw error;
            }
            if (retryLookup.state === 'missing') {
                return;
            }
            if (retryLookup.state === 'duplicate') {
                throw new SyncCommandError(`Multiple documents named "${documentName}" found in vault "${vault}". ` +
                    'Rename them to be unique.');
            }
            throw error;
        }
        await replaceFile(tempPath, targetPath);
    }
    finally {
        await fs.rm(tempDir, { recursive: true, force: true });
    }
}
async function pushDocument($, vault, documentName, sourcePath, index) {
    if (!(await pathExists(sourcePath))) {
        return;
    }
    const lookup = lookupDocument(index, documentName);
    if (lookup.state === 'duplicate') {
        throw new SyncCommandError(`Multiple documents named "${documentName}" found in vault "${vault}". ` +
            'Rename them to be unique.');
    }
    if (lookup.state === 'missing') {
        try {
            await opDocumentCreate($, vault, documentName, sourcePath);
        }
        catch (createError) {
            throw new SyncCommandError(`1Password create failed: ${formatShellError(createError)}`);
        }
        return;
    }
    try {
        await opDocumentEdit($, vault, documentName, sourcePath);
    }
    catch (error) {
        const retryLookup = await lookupDocumentWithRetry($, vault, documentName);
        if (!retryLookup) {
            throw error;
        }
        if (retryLookup.state === 'missing') {
            try {
                await opDocumentCreate($, vault, documentName, sourcePath);
            }
            catch (createError) {
                throw new SyncCommandError(`1Password create failed: ${formatShellError(createError)}`);
            }
            return;
        }
        if (retryLookup.state === 'duplicate') {
            throw new SyncCommandError(`Multiple documents named "${documentName}" found in vault "${vault}". ` +
                'Rename them to be unique.');
        }
        throw error;
    }
}
async function opDocumentGet($, vault, name, outFile) {
    try {
        await $ `op document get ${name} --vault ${vault} --out-file ${outFile}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`1Password download failed: ${formatShellError(error)}`);
    }
}
async function opDocumentCreate($, vault, name, sourcePath) {
    await $ `op document create --vault ${vault} ${sourcePath} --title ${name}`.quiet();
}
async function opDocumentEdit($, vault, name, sourcePath) {
    try {
        await $ `op document edit ${name} --vault ${vault} ${sourcePath}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`1Password update failed: ${formatShellError(error)}`);
    }
}
async function lookupDocumentWithRetry($, vault, documentName) {
    try {
        const retryIndex = await listVaultDocuments($, vault);
        return lookupDocument(retryIndex, documentName);
    }
    catch {
        return null;
    }
}
async function createTempPath(targetPath) {
    const targetDir = path.dirname(targetPath);
    await fs.mkdir(targetDir, { recursive: true });
    const tempDir = await fs.mkdtemp(path.join(targetDir, '.opencode-synced-'));
    const tempPath = path.join(tempDir, path.basename(targetPath));
    return { tempDir, tempPath };
}
async function replaceFile(sourcePath, targetPath) {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await chmodIfExists(sourcePath, 0o600);
    try {
        await fs.rename(sourcePath, targetPath);
    }
    catch (error) {
        const maybeErrno = error;
        if (maybeErrno.code !== 'EXDEV') {
            throw error;
        }
        await fs.copyFile(sourcePath, targetPath);
        await fs.unlink(sourcePath);
    }
    await chmodIfExists(targetPath, 0o600);
}
async function hashFiles(paths) {
    const hash = crypto.createHash('sha256');
    for (const filePath of paths) {
        hash.update(filePath);
        hash.update('\0');
        const exists = await pathExists(filePath);
        hash.update(exists ? '1' : '0');
        if (exists) {
            const data = await fs.readFile(filePath);
            hash.update(data);
        }
        hash.update('\0');
    }
    return hash.digest('hex');
}
function formatShellError(error) {
    if (!error)
        return 'Unknown error';
    if (typeof error === 'string')
        return error;
    if (error instanceof Error && error.message)
        return error.message;
    const maybe = error;
    const parts = [maybe.stderr, maybe.message].filter((value) => typeof value === 'string' && value.length > 0);
    if (parts.length > 0)
        return parts.join('\n');
    return String(error);
}
