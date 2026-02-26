import crypto from 'node:crypto';
import path from 'node:path';
import { hasSecretsBackend } from './config.js';
const DEFAULT_CONFIG_NAME = 'opencode.json';
const DEFAULT_CONFIGC_NAME = 'opencode.jsonc';
const DEFAULT_AGENTS_NAME = 'AGENTS.md';
const DEFAULT_SYNC_CONFIG_NAME = 'opencode-synced.jsonc';
const DEFAULT_OVERRIDES_NAME = 'opencode-synced.overrides.jsonc';
const DEFAULT_STATE_NAME = 'sync-state.json';
const CONFIG_DIRS = ['agent', 'command', 'mode', 'tool', 'themes', 'plugin', 'skills', 'lib'];
// SESSION_DIRS removed: OpenCode migrated from flat-file storage to SQLite (~Feb 2026).
// Sessions are now synced via the SDK export/import path in sessions.ts.
const PROMPT_STASH_FILES = ['prompt-stash.jsonl', 'prompt-history.jsonl'];
const MODEL_FAVORITES_FILE = 'model.json';
export function resolveHomeDir(env = process.env, platform = process.platform) {
    if (platform === 'win32') {
        return env.USERPROFILE ?? env.HOMEDRIVE ?? env.HOME ?? '';
    }
    return env.HOME ?? '';
}
export function resolveXdgPaths(env = process.env, platform = process.platform) {
    const homeDir = resolveHomeDir(env, platform);
    if (!homeDir) {
        return {
            homeDir: '',
            configDir: '',
            dataDir: '',
            stateDir: '',
        };
    }
    if (platform === 'win32') {
        const configDir = env.APPDATA ?? path.join(homeDir, 'AppData', 'Roaming');
        const dataDir = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
        // Windows doesn't have XDG_STATE_HOME equivalent, use LOCALAPPDATA
        const stateDir = env.LOCALAPPDATA ?? path.join(homeDir, 'AppData', 'Local');
        return { homeDir, configDir, dataDir, stateDir };
    }
    const configDir = env.XDG_CONFIG_HOME ?? path.join(homeDir, '.config');
    const dataDir = env.XDG_DATA_HOME ?? path.join(homeDir, '.local', 'share');
    const stateDir = env.XDG_STATE_HOME ?? path.join(homeDir, '.local', 'state');
    return { homeDir, configDir, dataDir, stateDir };
}
export function resolveSyncLocations(env = process.env, platform = process.platform) {
    const xdg = resolveXdgPaths(env, platform);
    const customConfigDir = env.opencode_config_dir;
    const configRoot = customConfigDir
        ? path.resolve(expandHome(customConfigDir, xdg.homeDir))
        : path.join(xdg.configDir, 'opencode');
    const dataRoot = path.join(xdg.dataDir, 'opencode');
    return {
        xdg,
        configRoot,
        syncConfigPath: path.join(configRoot, DEFAULT_SYNC_CONFIG_NAME),
        overridesPath: path.join(configRoot, DEFAULT_OVERRIDES_NAME),
        statePath: path.join(dataRoot, DEFAULT_STATE_NAME),
        defaultRepoDir: path.join(dataRoot, 'opencode-synced', 'repo'),
    };
}
export function expandHome(inputPath, homeDir) {
    if (!inputPath)
        return inputPath;
    if (!homeDir)
        return inputPath;
    if (inputPath === '~')
        return homeDir;
    if (inputPath.startsWith('~/'))
        return path.join(homeDir, inputPath.slice(2));
    return inputPath;
}
export function normalizePath(inputPath, homeDir, platform = process.platform) {
    const expanded = expandHome(inputPath, homeDir);
    const resolved = path.resolve(expanded);
    if (platform === 'win32') {
        return resolved.toLowerCase();
    }
    return resolved;
}
export function isSamePath(left, right, homeDir, platform = process.platform) {
    return normalizePath(left, homeDir, platform) === normalizePath(right, homeDir, platform);
}
export function encodeExtraPath(inputPath) {
    const normalized = inputPath.replace(/\\/g, '/');
    const safeBase = normalized.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+/, '');
    const hash = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
    const base = safeBase ? safeBase.slice(-80) : 'path';
    return `${base}-${hash}`;
}
export const encodeSecretPath = encodeExtraPath;
export function resolveRepoRoot(config, locations) {
    if (config?.localRepoPath) {
        return expandHome(config.localRepoPath, locations.xdg.homeDir);
    }
    return locations.defaultRepoDir;
}
export function buildSyncPlan(config, locations, repoRoot, platform = process.platform) {
    const configRoot = locations.configRoot;
    const dataRoot = path.join(locations.xdg.dataDir, 'opencode');
    const stateRoot = path.join(locations.xdg.stateDir, 'opencode');
    const repoConfigRoot = path.join(repoRoot, 'config');
    const repoDataRoot = path.join(repoRoot, 'data');
    const repoSecretsRoot = path.join(repoRoot, 'secrets');
    const repoStateRoot = path.join(repoRoot, 'state');
    const repoExtraDir = path.join(repoSecretsRoot, 'extra');
    const manifestPath = path.join(repoSecretsRoot, 'extra-manifest.json');
    const repoConfigExtraDir = path.join(repoConfigRoot, 'extra');
    const configManifestPath = path.join(repoConfigRoot, 'extra-manifest.json');
    const items = [];
    const usingSecretsBackend = hasSecretsBackend(config);
    const authJsonPath = path.join(dataRoot, 'auth.json');
    const mcpAuthJsonPath = path.join(dataRoot, 'mcp-auth.json');
    const addFile = (name, isSecret, isConfigFile) => {
        items.push({
            localPath: path.join(configRoot, name),
            repoPath: path.join(repoConfigRoot, name),
            type: 'file',
            isSecret,
            isConfigFile,
        });
    };
    addFile(DEFAULT_CONFIG_NAME, false, true);
    addFile(DEFAULT_CONFIGC_NAME, false, true);
    addFile(DEFAULT_AGENTS_NAME, false, false);
    addFile(DEFAULT_SYNC_CONFIG_NAME, false, false);
    for (const dirName of CONFIG_DIRS) {
        items.push({
            localPath: path.join(configRoot, dirName),
            repoPath: path.join(repoConfigRoot, dirName),
            type: 'dir',
            isSecret: false,
            isConfigFile: false,
        });
    }
    if (config.includeModelFavorites !== false) {
        items.push({
            localPath: path.join(stateRoot, MODEL_FAVORITES_FILE),
            repoPath: path.join(repoStateRoot, MODEL_FAVORITES_FILE),
            type: 'file',
            isSecret: false,
            isConfigFile: false,
        });
    }
    if (config.includeSecrets) {
        if (!usingSecretsBackend) {
            items.push({
                localPath: authJsonPath,
                repoPath: path.join(repoDataRoot, 'auth.json'),
                type: 'file',
                isSecret: true,
                isConfigFile: false,
            }, {
                localPath: mcpAuthJsonPath,
                repoPath: path.join(repoDataRoot, 'mcp-auth.json'),
                type: 'file',
                isSecret: true,
                isConfigFile: false,
            });
        }
        if (config.includePromptStash) {
            for (const fileName of PROMPT_STASH_FILES) {
                items.push({
                    localPath: path.join(stateRoot, fileName),
                    repoPath: path.join(repoStateRoot, fileName),
                    type: 'file',
                    isSecret: true,
                    isConfigFile: false,
                });
            }
        }
    }
    const extraSecretPaths = config.includeSecrets ? config.extraSecretPaths : [];
    const filteredExtraSecrets = usingSecretsBackend
        ? extraSecretPaths.filter((entry) => !isSamePath(entry, authJsonPath, locations.xdg.homeDir, platform) &&
            !isSamePath(entry, mcpAuthJsonPath, locations.xdg.homeDir, platform))
        : extraSecretPaths;
    const extraSecrets = buildExtraPathPlan(filteredExtraSecrets, locations, repoExtraDir, manifestPath, platform);
    const extraConfigPaths = (config.extraConfigPaths ?? []).filter((entry) => !isSamePath(entry, locations.syncConfigPath, locations.xdg.homeDir, platform));
    const extraConfigs = buildExtraPathPlan(extraConfigPaths, locations, repoConfigExtraDir, configManifestPath, platform);
    return {
        items,
        extraSecrets,
        extraConfigs,
        repoRoot,
        homeDir: locations.xdg.homeDir,
        platform,
    };
}
function buildExtraPathPlan(inputPaths, locations, repoExtraDir, manifestPath, platform) {
    const allowlist = (inputPaths ?? []).map((entry) => normalizePath(entry, locations.xdg.homeDir, platform));
    const entries = allowlist.map((sourcePath) => ({
        sourcePath,
        repoPath: path.join(repoExtraDir, encodeExtraPath(sourcePath)),
    }));
    return {
        allowlist,
        manifestPath,
        entries,
    };
}
