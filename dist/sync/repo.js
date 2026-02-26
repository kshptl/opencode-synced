import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathExists } from './config.js';
import { RepoDivergedError, RepoPrivateRequiredError, RepoVisibilityError, SyncCommandError, } from './errors.js';
export async function isRepoCloned(repoDir) {
    const gitDir = path.join(repoDir, '.git');
    return pathExists(gitDir);
}
export function resolveRepoIdentifier(config) {
    const repo = config.repo;
    if (!repo) {
        throw new SyncCommandError('Missing repo configuration.');
    }
    if (repo.url)
        return repo.url;
    if (repo.owner && repo.name)
        return `${repo.owner}/${repo.name}`;
    throw new SyncCommandError('Repo configuration must include url or owner/name.');
}
export function resolveRepoBranch(config, fallback = 'main') {
    const branch = config.repo?.branch;
    if (branch)
        return branch;
    return fallback;
}
export async function ensureRepoCloned($, config, repoDir) {
    if (await isRepoCloned(repoDir)) {
        return;
    }
    await fs.mkdir(path.dirname(repoDir), { recursive: true });
    const repoIdentifier = resolveRepoIdentifier(config);
    try {
        await $ `gh repo clone ${repoIdentifier} ${repoDir}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to clone repo: ${formatError(error)}`);
    }
}
export async function ensureRepoPrivate($, config) {
    const repoIdentifier = resolveRepoIdentifier(config);
    let output;
    try {
        output = await $ `gh repo view ${repoIdentifier} --json isPrivate`.quiet().text();
    }
    catch (error) {
        throw new RepoVisibilityError(`Unable to verify repo visibility: ${formatError(error)}`);
    }
    let isPrivate = false;
    try {
        isPrivate = parseRepoVisibility(output);
    }
    catch (error) {
        throw new RepoVisibilityError(`Unable to verify repo visibility: ${formatError(error)}`);
    }
    if (!isPrivate) {
        throw new RepoPrivateRequiredError('Secrets sync requires a private GitHub repo.');
    }
}
export function parseRepoVisibility(output) {
    const parsed = JSON.parse(output);
    if (typeof parsed.isPrivate !== 'boolean') {
        throw new Error('Invalid repo visibility response.');
    }
    return parsed.isPrivate;
}
export async function fetchAndFastForward($, repoDir, branch) {
    try {
        await $ `git -C ${repoDir} fetch --prune`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to fetch repo: ${formatError(error)}`);
    }
    await checkoutBranch($, repoDir, branch);
    const remoteRef = `origin/${branch}`;
    const remoteExists = await hasRemoteRef($, repoDir, branch);
    if (!remoteExists) {
        return { updated: false, branch };
    }
    const { ahead, behind } = await getAheadBehind($, repoDir, remoteRef);
    if (ahead > 0 && behind > 0) {
        throw new RepoDivergedError(`Local sync repo has diverged. Resolve with: cd ${repoDir} && git status && git pull --rebase`);
    }
    if (behind > 0) {
        try {
            await $ `git -C ${repoDir} merge --ff-only ${remoteRef}`.quiet();
            return { updated: true, branch };
        }
        catch (error) {
            throw new SyncCommandError(`Failed to fast-forward: ${formatError(error)}`);
        }
    }
    return { updated: false, branch };
}
export async function getRepoStatus($, repoDir) {
    const branch = await getCurrentBranch($, repoDir);
    const changes = await getStatusLines($, repoDir);
    return { branch, changes };
}
export async function hasLocalChanges($, repoDir) {
    const lines = await getStatusLines($, repoDir);
    return lines.length > 0;
}
export async function commitAll($, repoDir, message) {
    try {
        await $ `git -C ${repoDir} add -A`.quiet();
        await $ `git -C ${repoDir} commit -m ${message}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to commit changes: ${formatError(error)}`);
    }
}
export async function pushBranch($, repoDir, branch) {
    try {
        await $ `git -C ${repoDir} push -u origin ${branch}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to push changes: ${formatError(error)}`);
    }
}
async function getCurrentBranch($, repoDir) {
    try {
        const output = await $ `git -C ${repoDir} rev-parse --abbrev-ref HEAD`.quiet().text();
        const branch = output.trim();
        if (!branch || branch === 'HEAD')
            return 'main';
        return branch;
    }
    catch {
        return 'main';
    }
}
async function checkoutBranch($, repoDir, branch) {
    const exists = await hasLocalBranch($, repoDir, branch);
    try {
        if (exists) {
            await $ `git -C ${repoDir} checkout ${branch}`.quiet();
            return;
        }
        await $ `git -C ${repoDir} checkout -b ${branch}`.quiet();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to checkout branch: ${formatError(error)}`);
    }
}
async function hasLocalBranch($, repoDir, branch) {
    try {
        await $ `git -C ${repoDir} show-ref --verify refs/heads/${branch}`.quiet();
        return true;
    }
    catch {
        return false;
    }
}
async function hasRemoteRef($, repoDir, branch) {
    try {
        await $ `git -C ${repoDir} show-ref --verify refs/remotes/origin/${branch}`.quiet();
        return true;
    }
    catch {
        return false;
    }
}
async function getAheadBehind($, repoDir, remoteRef) {
    try {
        const output = await $ `git -C ${repoDir} rev-list --left-right --count HEAD...${remoteRef}`
            .quiet()
            .text();
        const [aheadRaw, behindRaw] = output.trim().split(/\s+/);
        const ahead = Number(aheadRaw ?? 0);
        const behind = Number(behindRaw ?? 0);
        return { ahead, behind };
    }
    catch {
        return { ahead: 0, behind: 0 };
    }
}
async function getStatusLines($, repoDir) {
    try {
        const output = await $ `git -C ${repoDir} status --porcelain`.quiet().text();
        return output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function formatError(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
export async function repoExists($, repoIdentifier) {
    try {
        await $ `gh repo view ${repoIdentifier} --json name`.quiet();
        return true;
    }
    catch {
        return false;
    }
}
export async function getAuthenticatedUser($) {
    try {
        const output = await $ `gh api user --jq .login`.quiet().text();
        return output.trim();
    }
    catch (error) {
        throw new SyncCommandError(`Failed to detect GitHub user. Ensure gh is authenticated: ${formatError(error)}`);
    }
}
const LIKELY_SYNC_REPO_NAMES = [
    'my-opencode-config',
    'opencode-config',
    'opencode-sync',
    'opencode-synced',
    'dotfiles-opencode',
];
export async function findSyncRepo($, repoName) {
    const owner = await getAuthenticatedUser($);
    // If user provided a specific name, check that first
    if (repoName) {
        const exists = await repoExists($, `${owner}/${repoName}`);
        if (exists) {
            const isPrivate = await checkRepoPrivate($, `${owner}/${repoName}`);
            return { owner, name: repoName, isPrivate };
        }
        return null;
    }
    // Search through likely repo names
    for (const name of LIKELY_SYNC_REPO_NAMES) {
        const exists = await repoExists($, `${owner}/${name}`);
        if (exists) {
            const isPrivate = await checkRepoPrivate($, `${owner}/${name}`);
            return { owner, name, isPrivate };
        }
    }
    return null;
}
async function checkRepoPrivate($, repoIdentifier) {
    try {
        const output = await $ `gh repo view ${repoIdentifier} --json isPrivate`.quiet().text();
        return parseRepoVisibility(output);
    }
    catch {
        return false;
    }
}
