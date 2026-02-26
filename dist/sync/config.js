import { promises as fs } from 'node:fs';
import path from 'node:path';
export async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
export async function chmodIfExists(filePath, mode) {
    try {
        await fs.chmod(filePath, mode);
    }
    catch (error) {
        const maybeErrno = error;
        if (maybeErrno.code === 'ENOENT')
            return;
        throw error;
    }
}
export function isPlainObject(value) {
    if (!value || typeof value !== 'object')
        return false;
    return Object.getPrototypeOf(value) === Object.prototype;
}
export function normalizeSecretsBackend(input) {
    if (!input || typeof input !== 'object')
        return undefined;
    const type = typeof input.type === 'string' ? input.type : undefined;
    if (!type)
        return undefined;
    if (type !== '1password') {
        return { type };
    }
    const vault = typeof input.vault === 'string' ? input.vault : undefined;
    const documentsInput = isPlainObject(input.documents) ? input.documents : {};
    const documents = {
        authJson: typeof documentsInput.authJson === 'string' ? documentsInput.authJson : undefined,
        mcpAuthJson: typeof documentsInput.mcpAuthJson === 'string' ? documentsInput.mcpAuthJson : undefined,
    };
    return { type: '1password', vault, documents };
}
export function normalizeSessionSyncConfig(input) {
    return {
        mode: input?.mode === 'full' ? 'full' : 'compact',
        keepRecentToolResults: typeof input?.keepRecentToolResults === 'number' && input.keepRecentToolResults >= 0
            ? input.keepRecentToolResults
            : 5,
        projectPaths: input?.projectPaths && typeof input.projectPaths === 'object'
            ? input.projectPaths
            : {},
    };
}
export function normalizeSyncConfig(config) {
    const includeSecrets = Boolean(config.includeSecrets);
    const includeModelFavorites = config.includeModelFavorites !== false;
    return {
        includeSecrets,
        includeMcpSecrets: includeSecrets ? Boolean(config.includeMcpSecrets) : false,
        includeSessions: config.includeSessions !== false,
        includePromptStash: Boolean(config.includePromptStash),
        includeModelFavorites,
        secretsBackend: normalizeSecretsBackend(config.secretsBackend),
        extraSecretPaths: Array.isArray(config.extraSecretPaths) ? config.extraSecretPaths : [],
        extraConfigPaths: Array.isArray(config.extraConfigPaths) ? config.extraConfigPaths : [],
        localRepoPath: config.localRepoPath,
        repo: config.repo,
        sessionSync: normalizeSessionSyncConfig(config.sessionSync),
    };
}
export function canCommitMcpSecrets(config) {
    return Boolean(config.includeSecrets) && Boolean(config.includeMcpSecrets);
}
export function hasSecretsBackend(config) {
    return Boolean(config.secretsBackend);
}
export async function loadSyncConfig(locations) {
    if (!(await pathExists(locations.syncConfigPath))) {
        return null;
    }
    const content = await fs.readFile(locations.syncConfigPath, 'utf8');
    const parsed = parseJsonc(content);
    return normalizeSyncConfig(parsed);
}
export async function writeSyncConfig(locations, config) {
    await fs.mkdir(path.dirname(locations.syncConfigPath), { recursive: true });
    const payload = normalizeSyncConfig(config);
    await writeJsonFile(locations.syncConfigPath, payload, { jsonc: true });
}
export async function loadOverrides(locations) {
    if (!(await pathExists(locations.overridesPath))) {
        return null;
    }
    const content = await fs.readFile(locations.overridesPath, 'utf8');
    const parsed = parseJsonc(content);
    return parsed;
}
export async function loadState(locations) {
    if (!(await pathExists(locations.statePath))) {
        return {};
    }
    const content = await fs.readFile(locations.statePath, 'utf8');
    return parseJsonc(content);
}
export async function writeState(locations, state) {
    await fs.mkdir(path.dirname(locations.statePath), { recursive: true });
    await writeJsonFile(locations.statePath, state, { jsonc: false });
}
export async function updateState(locations, update) {
    const existing = await loadState(locations);
    await writeState(locations, { ...existing, ...update });
}
export function applyOverridesToRuntimeConfig(config, overrides) {
    const merged = deepMerge(config, overrides);
    for (const key of Object.keys(config)) {
        delete config[key];
    }
    Object.assign(config, merged);
}
export function deepMerge(base, override) {
    if (!isPlainObject(base) || !isPlainObject(override)) {
        return (override === undefined ? base : override);
    }
    const result = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (isPlainObject(value) && isPlainObject(result[key])) {
            result[key] = deepMerge(result[key], value);
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
export function stripOverrides(localConfig, overrides, baseConfig) {
    if (!isPlainObject(localConfig) || !isPlainObject(overrides)) {
        return localConfig;
    }
    const result = { ...localConfig };
    for (const [key, overrideValue] of Object.entries(overrides)) {
        const baseValue = baseConfig ? baseConfig[key] : undefined;
        const currentValue = result[key];
        if (isPlainObject(overrideValue) && isPlainObject(currentValue)) {
            const stripped = stripOverrides(currentValue, overrideValue, isPlainObject(baseValue) ? baseValue : null);
            if (Object.keys(stripped).length === 0 && !baseValue) {
                delete result[key];
            }
            else {
                result[key] = stripped;
            }
            continue;
        }
        if (baseValue === undefined) {
            delete result[key];
        }
        else {
            result[key] = baseValue;
        }
    }
    return result;
}
export function parseJsonc(content) {
    let output = '';
    let inString = false;
    let inSingleLine = false;
    let inMultiLine = false;
    let escapeNext = false;
    for (let i = 0; i < content.length; i += 1) {
        const current = content[i];
        const next = content[i + 1];
        if (inSingleLine) {
            if (current === '\n') {
                inSingleLine = false;
                output += current;
            }
            continue;
        }
        if (inMultiLine) {
            if (current === '*' && next === '/') {
                inMultiLine = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            output += current;
            if (escapeNext) {
                escapeNext = false;
                continue;
            }
            if (current === '\\') {
                escapeNext = true;
                continue;
            }
            if (current === '"') {
                inString = false;
            }
            continue;
        }
        if (current === '"') {
            inString = true;
            output += current;
            continue;
        }
        if (current === '/' && next === '/') {
            inSingleLine = true;
            i += 1;
            continue;
        }
        if (current === '/' && next === '*') {
            inMultiLine = true;
            i += 1;
            continue;
        }
        if (current === ',') {
            let nextIndex = i + 1;
            while (nextIndex < content.length && /\s/.test(content[nextIndex])) {
                nextIndex += 1;
            }
            const nextChar = content[nextIndex];
            if (nextChar === '}' || nextChar === ']') {
                continue;
            }
        }
        output += current;
    }
    return JSON.parse(output);
}
export async function writeJsonFile(filePath, data, options = { jsonc: false }) {
    const json = JSON.stringify(data, null, 2);
    const content = options.jsonc ? `// Generated by opencode-synced\n${json}\n` : `${json}\n`;
    await fs.writeFile(filePath, content, 'utf8');
    if (options.mode !== undefined) {
        await chmodIfExists(filePath, options.mode);
    }
}
export function hasOwn(target, key) {
    return Object.hasOwn(target, key);
}
